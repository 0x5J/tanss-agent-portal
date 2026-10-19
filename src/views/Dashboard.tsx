import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { DonutCard, HBars, StatTile } from "../ui/charts.tsx";
import {
  ageBuckets,
  claimsByEmployee,
  createdOnDay,
  historyForList,
  dashboardTiles,
  dayCurve,
  donutSegments,
  dueSummary,
  fixedListKey,
  intakeByDay,
  intakeByHour,
  listMembers,
  topCompanies,
  weekHeatmap,
  type ClaimEntry,
  type CollectorHealth,
  type DashboardDay,
  type ListKey,
} from "../../shared/dashboard.ts";
import { formatShortDate, shiftYmd, weekdayLabel } from "../../shared/days.ts";
import type { SavedView } from "../../shared/filters.ts";
import type { TicketRow } from "../../shared/tickets.ts";
import { todayYmd } from "../format.ts";
import { loadViews } from "../savedViews.ts";

type Props = {
  reload: number;
  onSubtitle: (text: string) => void;
  onError: (error: unknown) => void;
  onToast: (text: string) => void;
  onOpen: (id: number) => void;
};

type Board = { rows: TicketRow[]; employeeId: number; employeeName: string };
type Dash = { days: DashboardDay[]; polling: boolean; intervalMinutes: number; health: CollectorHealth | null };

const listStorageKey = (employeeId: number) => `agent-portal:dashboard-list:${employeeId}`;

const nf = new Intl.NumberFormat("de-DE");

/**
 * One list, four ways to look at it: headline numbers, distribution, what came
 * in over the day, and how the count moved from morning to evening. Everything
 * on the page follows the selected list's filter criteria.
 */
export function DashboardView(props: Props) {
  const [board, setBoard] = useState<Board | null>(null);
  const [views, setViews] = useState<SavedView[]>([]);
  const [dash, setDash] = useState<Dash | null>(null);
  const [listKey, setListKey] = useState<ListKey | null>(null);
  const [intakeMode, setIntakeMode] = useState<"today" | "week" | "grid">("today");
  const [claimsMode, setClaimsMode] = useState<"today" | "week" | "month" | "all">("today");
  const [history, setHistory] = useState<ClaimEntry[]>([]);
  const [reports, setReports] = useState<{ name: string; day: string; bytes: number }[]>([]);
  const [reportLists, setReportLists] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const reloadRef = useRef<(() => void) | null>(null);
  const { onSubtitle, onError } = props;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [tickets, dashboard] = await Promise.all([api.tickets(), api.dashboard()]);
        const storedViews = await loadViews(tickets.employeeId);
        if (cancelled) return;
        setBoard(tickets);
        setViews(storedViews);
        setDash(dashboard);
        setListKey((current) => {
          if (current) return current;
          try {
            const stored = localStorage.getItem(listStorageKey(tickets.employeeId));
            if (stored) return stored;
          } catch {
            /* ignore */
          }
          // The first saved list is the natural default — that is the one the
          // dashboard was asked for; without saved lists, "Meine offenen".
          return storedViews.length > 0 ? `view:${storedViews[0].id}` : fixedListKey("own");
        });
      } catch (error) {
        if (!cancelled) onError(error);
      }
    }
    reloadRef.current = () => void load();
    void load();
    // New samples appear every few minutes; a quiet refetch keeps the page
    // current without a skeleton flash (the old render stays until data lands).
    const timer = window.setInterval(() => void load(), 5 * 60_000);
    // Coming back to the tab means "show me now", not "show me what was true
    // five minutes ago" — that is when a stale board is most confusing.
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      reloadRef.current = null;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [props.reload, onError]);

  useEffect(() => {
    const since =
      claimsMode === "today"
        ? todayYmd()
        : claimsMode === "week"
          ? shiftYmd(todayYmd(), -6)
          : claimsMode === "month"
            ? shiftYmd(todayYmd(), -29)
            : "2000-01-01";
    let cancelled = false;
    api
      .claimHistory(since)
      .then((r) => !cancelled && setHistory(r.entries))
      .catch((error: unknown) => !cancelled && onError(error));
    return () => {
      cancelled = true;
    };
  }, [claimsMode, props.reload, onError]);

  useEffect(() => {
    let cancelled = false;
    api
      .reports()
      .then((r) => {
        if (cancelled) return;
        setReports(r.reports);
        setReportLists(r.lists);
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [props.reload]);

  async function toggleReport(key: ListKey) {
    const next = reportLists.includes(key) ? reportLists.filter((k) => k !== key) : [...reportLists, key];
    setReportLists(next);
    try {
      await api.saveReportLists(next);
      props.onToast(
        next.includes(key)
          ? "Tagesbericht wird ab dem nächsten Tageswechsel abgelegt"
          : "Tagesbericht abgeschaltet",
      );
    } catch (error) {
      onError(error);
    }
  }

  async function refreshNow() {
    setRefreshing(true);
    try {
      reloadRef.current?.();
      // Give the request a moment so the button does not just blink.
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (board && listKey) {
      try {
        localStorage.setItem(listStorageKey(board.employeeId), listKey);
      } catch {
        /* ignore */
      }
    }
  }, [board, listKey]);

  const members = useMemo(
    () => (board ? listMembers(board.rows, views, { id: board.employeeId, name: board.employeeName }) : []),
    [board, views],
  );
  const selected = members.find((m) => m.key === listKey) ?? members[0] ?? null;
  const today = todayYmd();
  const days = dash?.days ?? [];
  const todayEntry = days.find((d) => d.day === today) ?? null;
  const yesterday = shiftYmd(today, -1);
  const yesterdayEntry = days.find((d) => d.day === yesterday) ?? null;

  useEffect(() => {
    onSubtitle(selected ? `${selected.label} · ${nf.format(selected.rows.length)} Tickets` : "lädt …");
  }, [selected, onSubtitle]);

  if (!board || !selected) {
    return <div style={{ padding: 16 }} className="muted small">Lädt …</div>;
  }

  const key = selected.key;
  const tiles = dashboardTiles(selected.rows, today);
  const due = dueSummary(selected.rows, today);
  const intakeToday = intakeByHour(createdOnDay(todayEntry, key, selected.rows, today).values());
  const intakeWeek = intakeByDay(days, key, selected.rows, today, 7);
  const curveToday = dayCurve(todayEntry, key);
  const curveYesterday = dayCurve(yesterdayEntry, key);
  const interval = dash?.intervalMinutes ?? 5;
  const claims = historyForList(history, key);
  const age = ageBuckets(selected.rows, today);

  return (
    <div className="dash" style={{ padding: 16 }}>
      <div className="row" style={{ marginBottom: 14, gap: 10 }}>
        <span className="small muted">Liste</span>
        <select className="select" value={key} onChange={(e) => setListKey(e.target.value)} style={{ minWidth: 220 }}>
          {members.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="tiny muted">Alle Diagramme gelten für diese Liste und ihre Filterkriterien.</span>
        <label
          className="row tiny muted"
          style={{ gap: 5, marginLeft: "auto" }}
          title="Am Tageswechsel wird der abgeschlossene Tag als A4-Bericht abgelegt"
        >
          <input type="checkbox" checked={reportLists.includes(key)} onChange={() => void toggleReport(key)} />
          Tagesbericht ablegen
        </label>
        <button className="btn ghost small" disabled={refreshing} onClick={() => void refreshNow()}>
          {refreshing ? "lädt …" : "Aktualisieren"}
        </button>
      </div>

      <CollectorStatus health={dash?.health ?? null} polling={dash?.polling === true} interval={interval} />

      <div className="dash-tiles">
        <StatTile label="Offen" value={nf.format(tiles.total)} />
        <StatTile label="Unzugewiesen" value={nf.format(tiles.unassigned)} />
        <StatTile label="Neu heute" value={nf.format(tiles.newToday)} />
        <StatTile label="Wartet auf Kunde" value={nf.format(tiles.waiting)} />
        <StatTile label="Überfällig" value={nf.format(due.overdue)} tone={due.overdue > 0 ? "danger" : undefined} />
        <StatTile label="Heute fällig" value={nf.format(due.dueToday)} tone={due.dueToday > 0 ? "warn" : undefined} />
        <StatTile label="Fällig diese Woche" value={nf.format(due.dueWeek)} />
      </div>

      <div className="dash-row donuts">
        <DonutCard title="Nach Status" segments={donutSegments(selected.rows, "status")} total={tiles.total} />
        <DonutCard title="Nach Zuständig" segments={donutSegments(selected.rows, "assignee")} total={tiles.total} />
        <DonutCard title="Nach Typ" segments={donutSegments(selected.rows, "type")} total={tiles.total} />
      </div>

      <div className="viz-card">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="viz-title">Übernommen</span>
          <div className="row" style={{ marginLeft: "auto", gap: 4 }}>
            {([
              ["today", "Heute"],
              ["week", "7 Tage"],
              ["month", "30 Tage"],
              ["all", "alles"],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                className={`btn ghost small${claimsMode === mode ? " active" : ""}`}
                onClick={() => setClaimsMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <ClaimsList claims={claims} today={today} polling={dash?.polling === true} interval={interval} onOpen={props.onOpen} />
      </div>

      <div className="viz-card">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="viz-title">Eingang über den Tag</span>
          <div className="row" style={{ marginLeft: "auto", gap: 4 }}>
            <button className={`btn ghost small${intakeMode === "today" ? " active" : ""}`} onClick={() => setIntakeMode("today")}>
              Heute
            </button>
            <button className={`btn ghost small${intakeMode === "week" ? " active" : ""}`} onClick={() => setIntakeMode("week")}>
              7 Tage
            </button>
            <button className={`btn ghost small${intakeMode === "grid" ? " active" : ""}`} onClick={() => setIntakeMode("grid")}>
              Wochenraster
            </button>
          </div>
        </div>
        {intakeMode === "today" ? (
          <BarChart
            values={intakeToday}
            labelOf={(i) => `${i} Uhr`}
            tickOf={(i) => (i % 3 === 0 ? String(i) : "")}
            empty="Heute ist noch kein Ticket in dieser Liste angelegt worden."
          />
        ) : intakeMode === "week" ? (
          <BarChart
            values={intakeWeek.map((d) => d.count)}
            labelOf={(i) => `${weekdayLabel(intakeWeek[i].day)} ${intakeWeek[i].day.slice(8)}.${intakeWeek[i].day.slice(5, 7)}.`}
            tickOf={(i) => weekdayLabel(intakeWeek[i].day)}
            empty="In den letzten 7 Tagen ist kein Ticket in dieser Liste angelegt worden."
          />
        ) : (
          <Heatmap grid={weekHeatmap(days, key, selected.rows, today)} />
        )}
        <div className="tiny muted" style={{ marginTop: 6 }}>
          {intakeMode === "grid"
            ? `Wochentag × Stunde über die gesammelten Wochen (bis 8) — wann kommen die Tickets dieser Liste eigentlich?`
            : "Neu angelegte Tickets der Liste, nach Erstellzeit — auch die, die inzwischen wieder zu sind"}
          {dash?.polling ? "" : " (ohne Hintergrund-Messung zählt nur, was gerade offen ist)"}.
        </div>
      </div>

      <div className="dash-row">
        <div className="viz-card" style={{ marginBottom: 0 }}>
          <div className="viz-title" style={{ marginBottom: 8 }}>Alter der Tickets</div>
          <BarChart
            values={age.map((b) => b.count)}
            labelOf={(i) => age[i].label}
            tickOf={(i) => age[i].label}
            empty="Keine Tickets in dieser Liste."
            compact
          />
        </div>
        <div className="viz-card" style={{ marginBottom: 0 }}>
          <div className="viz-title" style={{ marginBottom: 8 }}>Top-Kunden</div>
          <HBars rows={topCompanies(selected.rows)} />
        </div>
      </div>

      <div className="viz-card">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="viz-title">Verlauf über den Tag</span>
          <div className="row viz-legend" style={{ marginLeft: "auto" }}>
            <span className="viz-key" style={{ background: "var(--viz-1)" }} />
            <span className="tiny muted">Heute</span>
            <span className="viz-key" style={{ background: "var(--viz-dim)" }} />
            <span className="tiny muted">Gestern</span>
          </div>
        </div>
        {curveToday.length > 0 || curveYesterday.length > 0 ? (
          <CurveChart today={curveToday} yesterday={curveYesterday} intervalMinutes={interval} />
        ) : dash?.polling ? (
          <div className="small muted" style={{ padding: "18px 0" }}>
            Noch keine Messpunkte — der Server zählt alle {interval} Minuten, die Kurve entsteht über den Tag.
          </div>
        ) : (
          <div className="small muted pretty" style={{ padding: "18px 0", maxWidth: "68ch" }}>
            Für die Tagesverlaufskurve braucht der Server eigene Messpunkte: <span className="mono">TANSS_USERNAME</span> und{" "}
            <span className="mono">TANSS_PASSWORD</span> in der <span className="mono">.env</span> setzen, dann zählt er alle{" "}
            {interval} Minuten selbst — auch ohne offenen Browser.
          </div>
        )}
        <div className="tiny muted" style={{ marginTop: 6 }}>
          Anzahl der Tickets in der Liste je Messpunkt (alle {interval} min). Lücken heißen: da wurde nicht gemessen.
        </div>
      </div>

      <div className="viz-card">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="viz-title">Archiv</span>
          <span className="tiny muted" style={{ marginLeft: "auto" }}>
            {reports.length ? `${reports.length} Berichte` : "noch keiner abgelegt"}
          </span>
        </div>
        {reports.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {reports.slice(0, 30).map((r) => (
              <div key={r.name} className="row tiny" style={{ gap: 8 }}>
                <span className="mono" style={{ flex: "none", width: 88 }}>{r.day}</span>
                <span className="muted ellipsis" style={{ flex: 1, minWidth: 0 }}>{r.name}</span>
                <a className="btn ghost small" href={`/me/reports/${r.name}`} target="_blank" rel="noreferrer">
                  öffnen
                </a>
              </div>
            ))}
          </div>
        ) : (
          <div className="tiny muted pretty">
            Ist „Tagesbericht ablegen" für eine Liste eingeschaltet, schreibt der Sammler den
            abgeschlossenen Tag beim ersten Messpunkt des Folgetags als A4-Seite hierher — mit
            Verlauf, Eingang je Stunde und allen Übernahmen. Die Seite ist in sich geschlossen und
            lässt sich drucken.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * What the background collector is doing. A collector that quietly fails
 * leaves the diagrams on the live state and the history empty — that must be
 * visible on the page, not only in a container log.
 */
function CollectorStatus(props: { health: CollectorHealth | null; polling: boolean; interval: number }) {
  const { health } = props;
  if (!props.polling) {
    return (
      <div className="banner flat" style={{ marginBottom: 14 }}>
        <span className="dot sm flat" />
        <span className="small pretty">
          Ohne Hintergrund-Messung zeigen die Diagramme nur den aktuellen Stand: Was aus der Liste
          herausfällt, verschwindet überall. Für Verlauf, Eingangs-Historie und Übernahmen{" "}
          <span className="mono">TANSS_USERNAME</span>/<span className="mono">TANSS_PASSWORD</span> setzen.
        </span>
      </div>
    );
  }
  if (health?.stopped) {
    return (
      <div className="banner danger" style={{ marginBottom: 14 }}>
        <span className="dot sm danger" />
        <span className="small pretty">
          <strong>Automatische Messung gestoppt.</strong> {health.lastError} — es wird nichts mehr versucht,
          bis die Zugangsdaten geprüft und der Container neu gestartet ist.
        </span>
      </div>
    );
  }
  if (health && health.lastError) {
    return (
      <div className="banner" style={{ marginBottom: 14 }}>
        <span className="dot sm warn" />
        <span className="small pretty">
          Letzte Messung fehlgeschlagen: {health.lastError}
          {health.retryAfter > 0 ? ` — nächster Versuch um ${clock(minuteOfDay(health.retryAfter))}.` : ""}
        </span>
      </div>
    );
  }
  return (
    <div className="row tiny muted" style={{ marginBottom: 14, gap: 6 }}>
      <span className="dot xs ok" />
      <span>
        {health?.lastSampleAt
          ? `Letzte Messung um ${clock(minuteOfDay(health.lastSampleAt))} · alle ${props.interval} min`
          : `Messung läuft an · alle ${props.interval} min`}
      </span>
    </div>
  );
}

function minuteOfDay(unixSeconds: number): number {
  const d = new Date(unixSeconds * 1000);
  return d.getHours() * 60 + d.getMinutes();
}

const PAD = { left: 34, right: 12, top: 10, bottom: 24 };

/**
 * The rendered width of the chart's wrapper, so the SVG draws 1:1 in real
 * pixels — scaling a fixed viewBox up would fatten text and strokes.
 */
function useWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(760);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return Math.max(420, width);
}

function niceMax(max: number): { max: number; step: number } {
  if (max <= 4) return { max: Math.max(max, 2), step: 1 };
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? mag * 10;
  return { max: Math.ceil(max / step) * step, step };
}

/** Columns over an index axis — one series, one hue, hover carries the exact value. */
function BarChart(props: {
  values: number[];
  labelOf: (index: number) => string;
  tickOf: (index: number) => string;
  empty: string;
  compact?: boolean;
}) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const width = useWidth(wrapRef);
  const { values } = props;
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) {
    return <div className="small muted" style={{ padding: "18px 0" }}>{props.empty}</div>;
  }
  const height = props.compact ? 180 : 230;
  const plotH = height - PAD.top - PAD.bottom;
  const plotW = width - PAD.left - PAD.right;
  const { max, step } = niceMax(Math.max(...values));
  const slot = plotW / values.length;
  const barW = Math.min(24, slot - 2);
  const yOf = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const peak = values.indexOf(Math.max(...values));
  const ticks: number[] = [];
  for (let v = step; v <= max; v += step) ticks.push(v);

  function show(event: React.MouseEvent, index: number) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTip({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top - 28,
      text: `${props.labelOf(index)} · ${nf.format(values[index])}`,
    });
  }

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" onMouseLeave={() => setTip(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={width - PAD.right} y1={yOf(v)} y2={yOf(v)} stroke="var(--viz-grid)" strokeWidth="1" />
            <text x={PAD.left - 6} y={yOf(v) + 3} textAnchor="end" fontSize="11" fill="var(--text2)">
              {nf.format(v)}
            </text>
          </g>
        ))}
        <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="var(--viz-axis)" strokeWidth="1" />
        {values.map((v, i) => {
          const x = PAD.left + i * slot + (slot - barW) / 2;
          const y = yOf(v);
          const h = PAD.top + plotH - y;
          return (
            <g key={i}>
              {v > 0 ? (
                <path
                  d={`M ${x} ${PAD.top + plotH} V ${y + Math.min(4, h)} Q ${x} ${y} ${x + Math.min(4, barW / 2)} ${y} H ${x + barW - Math.min(4, barW / 2)} Q ${x + barW} ${y} ${x + barW} ${y + Math.min(4, h)} V ${PAD.top + plotH} Z`}
                  fill="var(--viz-1)"
                />
              ) : null}
              {i === peak && v > 0 ? (
                <text x={x + barW / 2} y={y - 5} textAnchor="middle" fontSize="11" fill="var(--text)">
                  {nf.format(v)}
                </text>
              ) : null}
              <rect
                x={PAD.left + i * slot}
                y={PAD.top}
                width={slot}
                height={plotH}
                fill="transparent"
                onMouseEnter={(e) => show(e, i)}
                onMouseMove={(e) => show(e, i)}
              />
            </g>
          );
        })}
        {values.map((_, i) => {
          const label = props.tickOf(i);
          if (!label) return null;
          return (
            <text key={i} x={PAD.left + i * slot + slot / 2} y={height - 6} textAnchor="middle" fontSize="11" fill="var(--text2)">
              {label}
            </text>
          );
        })}
      </svg>
      {tip ? (
        <div className="viz-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The day-course: today in the accent hue, yesterday as gray context. The
 * line breaks where measuring paused — a gap in the data stays a gap.
 */
function CurveChart(props: {
  today: { minute: number; count: number }[];
  yesterday: { minute: number; count: number }[];
  intervalMinutes: number;
}) {
  const [hover, setHover] = useState<{ x: number; text: string } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const width = useWidth(wrapRef);
  const height = 240;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const all = [...props.today, ...props.yesterday];
  const { max, step } = niceMax(Math.max(1, ...all.map((p) => p.count)));
  const xOf = (minute: number) => PAD.left + (minute / (24 * 60)) * plotW;
  const yOf = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const gap = Math.max(props.intervalMinutes * 3, 15);

  function segments(points: { minute: number; count: number }[]): { minute: number; count: number }[][] {
    const result: { minute: number; count: number }[][] = [];
    let current: { minute: number; count: number }[] = [];
    for (const p of points) {
      if (current.length > 0 && p.minute - current[current.length - 1].minute > gap) {
        result.push(current);
        current = [];
      }
      current.push(p);
    }
    if (current.length > 0) result.push(current);
    return result;
  }

  const path = (seg: { minute: number; count: number }[]) =>
    seg.map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.minute).toFixed(1)} ${yOf(p.count).toFixed(1)}`).join(" ");

  const last = props.today[props.today.length - 1] ?? null;
  const ticks: number[] = [];
  for (let v = step; v <= max; v += step) ticks.push(v);

  function onMove(event: React.MouseEvent<SVGSVGElement>) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || props.today.length + props.yesterday.length === 0) return;
    const viewX = event.clientX - rect.left;
    const minute = Math.max(0, Math.min(24 * 60 - 1, ((viewX - PAD.left) / plotW) * 24 * 60));
    const nearest = (points: { minute: number; count: number }[]) =>
      points.reduce<{ minute: number; count: number } | null>(
        (best, p) => (best === null || Math.abs(p.minute - minute) < Math.abs(best.minute - minute) ? p : best),
        null,
      );
    const t = nearest(props.today);
    const y = nearest(props.yesterday);
    const parts: string[] = [];
    if (t && Math.abs(t.minute - minute) <= 60) parts.push(`${clock(t.minute)} · ${nf.format(t.count)}`);
    if (y && Math.abs(y.minute - minute) <= 60) parts.push(`gestern ${clock(y.minute)} · ${nf.format(y.count)}`);
    if (parts.length === 0) return setHover(null);
    setHover({ x: xOf((t ?? y)!.minute), text: parts.join("   ") });
  }

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={width - PAD.right} y1={yOf(v)} y2={yOf(v)} stroke="var(--viz-grid)" strokeWidth="1" />
            <text x={PAD.left - 6} y={yOf(v) + 3} textAnchor="end" fontSize="11" fill="var(--text2)">
              {nf.format(v)}
            </text>
          </g>
        ))}
        <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="var(--viz-axis)" strokeWidth="1" />
        {[0, 6, 12, 18, 24].map((h) => (
          <text key={h} x={xOf(h * 60)} y={height - 6} textAnchor="middle" fontSize="11" fill="var(--text2)">
            {h}
          </text>
        ))}
        {segments(props.yesterday).map((seg, i) => (
          <path key={`y${i}`} d={path(seg)} fill="none" stroke="var(--viz-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {segments(props.today).map((seg, i) => (
          <path key={`t${i}`} d={path(seg)} fill="none" stroke="var(--viz-1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {hover ? (
          <line x1={hover.x} x2={hover.x} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--viz-axis)" strokeWidth="1" />
        ) : null}
        {last ? (
          <g>
            <circle cx={xOf(last.minute)} cy={yOf(last.count)} r="4.5" fill="var(--viz-1)" stroke="var(--surface)" strokeWidth="2" />
            <text x={Math.min(xOf(last.minute) + 8, width - PAD.right)} y={yOf(last.count) - 7} fontSize="11" fill="var(--text)">
              {nf.format(last.count)}
            </text>
          </g>
        ) : null}
      </svg>
      {hover ? (
        <div className="viz-tip" style={{ left: hover.x, top: 0 }}>
          {hover.text}
        </div>
      ) : null}
    </div>
  );
}

function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

const CLAIMS_SHOWN = 25;

/** Who took which ticket of the list — the measured assignee changes. */
function ClaimsList(props: {
  claims: ClaimEntry[];
  today: string;
  polling: boolean;
  interval: number;
  onOpen: (id: number) => void;
}) {
  if (!props.polling && props.claims.length === 0) {
    return (
      <div className="small muted pretty" style={{ padding: "8px 0", maxWidth: "68ch" }}>
        Übernahmen erkennt der Hintergrund-Sammler am Wechsel des Zuständigen zwischen zwei Messungen —
        dafür braucht es <span className="mono">TANSS_USERNAME</span>/<span className="mono">TANSS_PASSWORD</span> in der{" "}
        <span className="mono">.env</span>.
      </div>
    );
  }
  if (props.claims.length === 0) {
    return (
      <div className="small muted" style={{ padding: "8px 0" }}>
        Keine Übernahme gemessen — der Sammler vergleicht alle {props.interval} Minuten den Zuständigen.
      </div>
    );
  }
  const byEmployee = claimsByEmployee(props.claims);
  const shown = props.claims.slice(0, CLAIMS_SHOWN);
  return (
    <div>
      <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {byEmployee.map(({ name, count }) => (
          <span key={name} className="chip">
            {name} · {count}
          </span>
        ))}
      </div>
      <div className="claims">
        {shown.map((claim, i) => (
          <div key={`${claim.day}-${claim.id}-${claim.minute}-${i}`} className="row tiny" style={{ gap: 8 }}>
            <span className="mono muted" style={{ flex: "none", width: 96 }} title={formatShortDate(claim.day)}>
              {claim.day === props.today
                ? clock(claim.minute)
                : `${formatShortDate(claim.day).slice(0, 6)} ${clock(claim.minute)}`}
            </span>
            <button className="btn ghost small mono" style={{ padding: "0 4px" }} onClick={() => props.onOpen(claim.id)}>
              #{claim.id}
            </button>
            <span className="small ellipsis" style={{ minWidth: 0 }}>{claim.title || "—"}</span>
            <span className="small" style={{ flex: "none", marginLeft: "auto" }}>
              → {claim.assigneeName}
              {claim.fromId > 0 ? <span className="muted"> (von {claim.fromName})</span> : null}
            </span>
          </div>
        ))}
        {props.claims.length > shown.length ? (
          <div className="tiny muted">
            … {nf.format(props.claims.length - shown.length)} weitere im Zeitraum
          </div>
        ) : null}
        <div className="tiny muted" style={{ marginTop: 2 }}>
          Läuft fortlaufend mit — die Historie bleibt, auch wenn die Messwerte des Tages altern.
        </div>
      </div>
    </div>
  );
}

const WEEKDAY_ROWS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

/** Weekday × hour intake — one hue, darker where more comes in. */
function Heatmap(props: { grid: number[][] }) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const max = Math.max(1, ...props.grid.flat());
  const total = props.grid.flat().reduce((a, b) => a + b, 0);
  if (total === 0) {
    return <div className="small muted" style={{ padding: "18px 0" }}>Noch keine Eingänge gesammelt.</div>;
  }
  function show(event: React.MouseEvent, day: number, hour: number) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTip({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top - 28,
      text: `${WEEKDAY_ROWS[day]} ${hour}–${hour + 1} Uhr · ${nf.format(props.grid[day][hour])}`,
    });
  }
  return (
    <div ref={wrapRef} style={{ position: "relative" }} onMouseLeave={() => setTip(null)}>
      {props.grid.map((rowValues, day) => (
        <div key={day} className="heat-row">
          <span className="tiny muted heat-label">{WEEKDAY_ROWS[day]}</span>
          {rowValues.map((value, hour) => (
            <span
              key={hour}
              className="heat-cell"
              style={{
                background:
                  value > 0
                    ? `color-mix(in oklch, var(--viz-1) ${Math.round(15 + (value / max) * 80)}%, var(--surface))`
                    : "transparent",
              }}
              onMouseEnter={(e) => show(e, day, hour)}
              onMouseMove={(e) => show(e, day, hour)}
            />
          ))}
        </div>
      ))}
      <div className="heat-row">
        <span className="heat-label" />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} className="tiny muted heat-hour">
            {hour % 6 === 0 ? hour : ""}
          </span>
        ))}
      </div>
      {tip ? (
        <div className="viz-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      ) : null}
    </div>
  );
}
