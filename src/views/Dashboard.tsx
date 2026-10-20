import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { RankRows, RingCard, VBars } from "../ui/charts.tsx";
import { CheckBox, Dot, PageHeader, SectionTitle, Segmented, Tile } from "../ui/kit.tsx";
import "../styles/dashboard.css";
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
  /** When the board last arrived — the "Stand" in the subtitle. */
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
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
        setLoadedAt(new Date());
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

  const stand = loadedAt ? ` · Stand ${clock(loadedAt.getHours() * 60 + loadedAt.getMinutes())}` : "";
  const subtitle = selected ? `${selected.label} · ${nf.format(selected.rows.length)} Tickets${stand}` : "lädt …";
  useEffect(() => {
    onSubtitle(subtitle);
  }, [subtitle, onSubtitle]);

  if (!board || !selected) {
    return (
      <div className="view">
        <PageHeader title="Dashboard" subtitle="lädt …" />
      </div>
    );
  }

  const key = selected.key;
  const tiles = dashboardTiles(selected.rows, today);
  const due = dueSummary(selected.rows, today);
  const intakeToday = intakeByHour(createdOnDay(todayEntry, key, selected.rows, today).values());
  const intakeWeek = intakeByDay(days, key, selected.rows, today, 7);
  const curveToday = dayCurve(todayEntry, key);
  const curveYesterday = dayCurve(yesterdayEntry, key);
  const interval = dash?.intervalMinutes ?? 5;
  const polling = dash?.polling === true;
  const claims = historyForList(history, key);
  const age = ageBuckets(selected.rows, today);
  const reportOn = reportLists.includes(key);
  const customers = topCompanies(selected.rows);

  return (
    <div className="view dash-view">
      <PageHeader title="Dashboard" subtitle={subtitle}>
        <button
          className="btn lg"
          onClick={() => void toggleReport(key)}
          title="Am Tageswechsel wird der abgeschlossene Tag als A4-Bericht abgelegt"
          aria-pressed={reportOn}
        >
          <CheckBox on={reportOn} size={11} />
          Tagesbericht ablegen
        </button>
        <button className="btn primary lg" disabled={refreshing} onClick={() => void refreshNow()}>
          {refreshing ? "Lädt …" : "Aktualisieren"}
        </button>
      </PageHeader>

      <div className="dash-list">
        <div className="dash-list-row">
          <span className="dash-list-label">Liste</span>
          <Segmented
            label="Liste"
            options={members.map((m) => ({ id: m.key, label: m.label }))}
            value={key}
            onChange={(next) => setListKey(next)}
          />
        </div>
        <span className="small muted">Alle Diagramme gelten für diese Liste und ihre Filterkriterien.</span>
        <CollectorStatus health={dash?.health ?? null} polling={polling} interval={interval} />
      </div>

      <div className="tiles">
        <Tile label="Offen" value={nf.format(tiles.total)} />
        <Tile label="Unzugewiesen" value={nf.format(tiles.unassigned)} />
        <Tile label="Neu heute" value={nf.format(tiles.newToday)} />
        <Tile label="Wartet auf Kunde" value={nf.format(tiles.waiting)} />
        <Tile label="Überfällig" value={nf.format(due.overdue)} tone={due.overdue > 0 ? "danger" : undefined} />
        <Tile label="Heute fällig" value={nf.format(due.dueToday)} tone={due.dueToday > 0 ? "warn" : undefined} />
        <Tile label="Fällig diese Woche" value={nf.format(due.dueWeek)} />
      </div>

      <div className="ring-grid">
        <RingCard title="Nach Status" segments={donutSegments(selected.rows, "status")} total={tiles.total} />
        <RingCard title="Nach Zuständig" segments={donutSegments(selected.rows, "assignee")} total={tiles.total} />
        <RingCard title="Nach Typ" segments={donutSegments(selected.rows, "type")} total={tiles.total} />
      </div>

      <section className="section">
        <SectionTitle title="Übernommen">
          <Segmented
            label="Zeitraum der Übernahmen"
            options={[
              { id: "today", label: "Heute" },
              { id: "week", label: "7 Tage" },
              { id: "month", label: "30 Tage" },
              { id: "all", label: "Alles" },
            ]}
            value={claimsMode}
            onChange={setClaimsMode}
          />
        </SectionTitle>
        <ClaimsList claims={claims} today={today} polling={polling} interval={interval} onOpen={props.onOpen} />
      </section>

      <section className="section">
        <SectionTitle title="Eingang über den Tag">
          <Segmented
            label="Ansicht des Eingangs"
            options={[
              { id: "today", label: "Heute" },
              { id: "week", label: "7 Tage" },
              { id: "grid", label: "Wochenraster" },
            ]}
            value={intakeMode}
            onChange={setIntakeMode}
          />
        </SectionTitle>
        {intakeMode === "today" ? (
          <VBars
            values={intakeToday}
            labelOf={(i) => `${i}–${i + 1} Uhr`}
            tickOf={(i) => (i % 3 === 0 ? String(i) : "")}
            height={220}
            maxBar={24}
            empty="Heute ist noch kein Ticket in dieser Liste angelegt worden."
            ariaLabel="Eingang heute je Stunde"
          />
        ) : intakeMode === "week" ? (
          <VBars
            values={intakeWeek.map((d) => d.count)}
            labelOf={(i) => `${weekdayLabel(intakeWeek[i].day)} ${intakeWeek[i].day.slice(8)}.${intakeWeek[i].day.slice(5, 7)}.`}
            tickOf={(i) => weekdayLabel(intakeWeek[i].day)}
            height={220}
            maxBar={64}
            empty="In den letzten 7 Tagen ist kein Ticket in dieser Liste angelegt worden."
            ariaLabel="Eingang der letzten 7 Tage"
          />
        ) : (
          <Heatmap grid={weekHeatmap(days, key, selected.rows, today)} />
        )}
        <span className="tiny muted pretty">
          {intakeMode === "grid"
            ? "Wochentag × Stunde über die gesammelten Wochen (bis 8) – wann kommen die Tickets dieser Liste eigentlich?"
            : "Neu angelegte Tickets der Liste, nach Erstellzeit – auch die, die inzwischen wieder zu sind."}
          {polling ? "" : " Ohne Hintergrund-Messung zählt nur, was gerade offen ist."}
        </span>
      </section>

      <div className="dash-pair">
        <section className="section dash-pair-wide">
          <SectionTitle title="Alter der Tickets" />
          <VBars
            values={age.map((b) => b.count)}
            labelOf={(i) => age[i].label}
            tickOf={(i) => age[i].label}
            height={180}
            maxBar={64}
            empty="Keine Tickets in dieser Liste."
            ariaLabel="Alter der Tickets"
          />
        </section>
        <section className="section dash-pair-narrow">
          <SectionTitle title="Top-Kunden" />
          <RankRows
            rows={customers.map((c) => ({ label: c.label, value: c.count }))}
            format={(v) => `${nf.format(v)} ${v === 1 ? "Ticket" : "Tickets"}`}
            empty="Keine Tickets in dieser Liste."
          />
        </section>
      </div>

      <section className="section">
        <SectionTitle title="Verlauf über den Tag">
          <span className="curve-legend">
            <span>
              <i style={{ background: "var(--ink)" }} />
              Heute
            </span>
            <span>
              <i style={{ background: "var(--v4)" }} />
              Gestern
            </span>
          </span>
        </SectionTitle>
        {curveToday.length > 0 || curveYesterday.length > 0 ? (
          <CurveChart today={curveToday} yesterday={curveYesterday} intervalMinutes={interval} />
        ) : polling ? (
          <div className="empty-inline">
            Noch keine Messpunkte – der Server zählt alle {interval} Minuten, die Kurve entsteht über den Tag.
          </div>
        ) : (
          <div className="empty-inline pretty">
            Für die Tagesverlaufskurve braucht der Server eigene Messpunkte: <code>TANSS_USERNAME</code> und{" "}
            <code>TANSS_PASSWORD</code> in der <code>.env</code> setzen, dann zählt er alle {interval} Minuten selbst –
            auch ohne offenen Browser.
          </div>
        )}
        <span className="tiny muted">
          Anzahl der Tickets in der Liste je Messpunkt (alle {interval} min). Lücken heißen: da wurde nicht gemessen.
        </span>
      </section>

      <section className="section">
        <SectionTitle title="Archiv" note={reports.length ? `${nf.format(reports.length)} ${reports.length === 1 ? "Bericht" : "Berichte"}` : "noch keiner abgelegt"} />
        {reports.length ? (
          <div className="table">
            {reports.slice(0, 30).map((r) => (
              <div key={r.name} className="trow archive-row">
                <span className="num-cell">{formatShortDate(r.day)}</span>
                <span className="muted ellipsis" title={r.name}>{r.name}</span>
                <span className="muted small archive-size">{formatBytes(r.bytes)}</span>
                <a className="btn small" href={`/me/reports/${r.name}`} target="_blank" rel="noreferrer">
                  Öffnen
                </a>
              </div>
            ))}
          </div>
        ) : (
          <p className="small muted pretty lead">
            Ist „Tagesbericht ablegen“ für eine Liste eingeschaltet, schreibt der Sammler den abgeschlossenen Tag beim
            ersten Messpunkt des Folgetags als A4-Seite hierher – mit Verlauf, Eingang je Stunde und allen Übernahmen.
            Die Seite ist in sich geschlossen und lässt sich drucken.
          </p>
        )}
      </section>
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
      <div className="collector-banner">
        <Dot tone="flat" />
        <span className="pretty">
          <strong>Ohne Hintergrund-Messung</strong> zeigen die Diagramme nur den aktuellen Stand: Was aus der Liste
          herausfällt, verschwindet überall. Für Verlauf, Eingangs-Historie und Übernahmen <code>TANSS_USERNAME</code>/
          <code>TANSS_PASSWORD</code> in der <code>.env</code> setzen.
        </span>
      </div>
    );
  }
  if (health?.stopped) {
    return (
      <div className="collector-banner">
        <Dot tone="danger" />
        <span className="pretty">
          <strong>Automatische Messung gestoppt.</strong> {health.lastError} – es wird nichts mehr versucht, bis die
          Zugangsdaten geprüft und der Container neu gestartet ist.
        </span>
      </div>
    );
  }
  if (health && health.lastError) {
    return (
      <div className="collector-banner">
        <Dot tone="warn" />
        <span className="pretty">
          <strong>Letzte Messung fehlgeschlagen:</strong> {health.lastError}
          {health.retryAfter > 0 ? ` – nächster Versuch um ${clock(minuteOfDay(health.retryAfter))}.` : ""}
        </span>
      </div>
    );
  }
  return (
    <div className="collector-ok">
      <Dot tone="ok" />
      <span>
        {health?.lastSampleAt
          ? `Letzte Messung um ${clock(minuteOfDay(health.lastSampleAt))} · alle ${props.interval} min`
          : `Messung läuft an · alle ${props.interval} min`}
      </span>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${nf.format(bytes)} B`;
  return `${(bytes / 1024).toFixed(1).replace(".", ",")} KB`;
}

function minuteOfDay(unixSeconds: number): number {
  const d = new Date(unixSeconds * 1000);
  return d.getHours() * 60 + d.getMinutes();
}

type Point = { minute: number; count: number };

function niceMax(max: number): { max: number; step: number } {
  if (max <= 4) return { max: Math.max(max, 2), step: 1 };
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? mag * 10;
  return { max: Math.ceil((max * 1.1) / step) * step, step };
}

const CURVE_W = 1440;
const CURVE_H = 220;

/**
 * The day-course: today in ink, yesterday in grey as context. The line breaks
 * where measuring paused — a gap in the data stays a gap. Drawn as an SVG
 * stretched over the plot (minutes across, count up), with the tick lines,
 * the last point and the hover read-out as plain HTML on top.
 */
function CurveChart(props: { today: Point[]; yesterday: Point[]; intervalMinutes: number }) {
  const [hover, setHover] = useState<{ minute: number; text: string } | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const all = [...props.today, ...props.yesterday];
  const { max, step } = niceMax(Math.max(1, ...all.map((p) => p.count)));
  const gap = Math.max(props.intervalMinutes * 3, 15);
  const ticks: number[] = [];
  for (let v = step; v < max; v += step) ticks.push(v);

  function segments(points: Point[]): Point[][] {
    const result: Point[][] = [];
    let current: Point[] = [];
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
  const xy = (p: Point) => `${p.minute.toFixed(1)} ${(CURVE_H - (p.count / max) * CURVE_H).toFixed(1)}`;
  const path = (points: Point[]) =>
    segments(points)
      .map((seg) => seg.map((p, i) => `${i === 0 ? "M" : "L"} ${xy(p)}`).join(" "))
      .join(" ");
  const last = props.today[props.today.length - 1] ?? null;

  function onMove(event: React.MouseEvent<HTMLDivElement>) {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || all.length === 0) return;
    const minute = Math.max(0, Math.min(24 * 60 - 1, ((event.clientX - rect.left) / rect.width) * 24 * 60));
    const nearest = (points: Point[]) =>
      points.reduce<Point | null>(
        (best, p) => (best === null || Math.abs(p.minute - minute) < Math.abs(best.minute - minute) ? p : best),
        null,
      );
    const t = nearest(props.today);
    const y = nearest(props.yesterday);
    const parts: string[] = [];
    if (t && Math.abs(t.minute - minute) <= 60) parts.push(`${clock(t.minute)} · ${nf.format(t.count)}`);
    if (y && Math.abs(y.minute - minute) <= 60) parts.push(`gestern ${clock(y.minute)} · ${nf.format(y.count)}`);
    if (parts.length === 0) return setHover(null);
    setHover({ minute: (t ?? y)!.minute, text: parts.join("   ") });
  }

  return (
    <div className="curve">
      <div ref={plotRef} className="curve-plot" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <div key={v} className="curve-tick" style={{ bottom: `${(v / max) * 100}%` }}>
            <span>{nf.format(v)}</span>
          </div>
        ))}
        <svg viewBox={`0 0 ${CURVE_W} ${CURVE_H}`} preserveAspectRatio="none" role="img" aria-label="Tickets in der Liste über den Tag">
          <path d={path(props.yesterday)} fill="none" stroke="var(--v4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={path(props.today)} fill="none" stroke="var(--ink)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {hover ? <span className="curve-cursor" style={{ left: `${(hover.minute / 1440) * 100}%` }} /> : null}
        {last ? (
          <>
            <span
              className="curve-dot"
              style={{ left: `calc(${(last.minute / 1440) * 100}% - 6px)`, bottom: `calc(${(last.count / max) * 100}% - 6px)` }}
            />
            <span
              className="curve-dot-label"
              style={{ left: `calc(${(last.minute / 1440) * 100}% + 10px)`, bottom: `calc(${(last.count / max) * 100}% + 4px)` }}
            >
              {nf.format(last.count)}
            </span>
          </>
        ) : null}
        {hover ? (
          <div className="viz-tip" style={{ left: `${(hover.minute / 1440) * 100}%`, top: -6 }}>
            {hover.text}
          </div>
        ) : null}
      </div>
      <div className="curve-hours">
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
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
      <span className="muted pretty lead">
        Übernahmen erkennt der Hintergrund-Sammler am Wechsel des Zuständigen zwischen zwei Messungen – dafür braucht es{" "}
        <code>TANSS_USERNAME</code>/<code>TANSS_PASSWORD</code> in der <code>.env</code>.
      </span>
    );
  }
  if (props.claims.length === 0) {
    return (
      <span className="muted">
        Keine Übernahme gemessen – der Sammler vergleicht alle {props.interval} Minuten den Zuständigen.
      </span>
    );
  }
  const byEmployee = claimsByEmployee(props.claims);
  const shown = props.claims.slice(0, CLAIMS_SHOWN);
  return (
    <div className="claims-block">
      <div className="claim-chips">
        {byEmployee.map(({ name, count }) => (
          <span key={name} className="claim-chip">
            {name} · {count}
          </span>
        ))}
      </div>
      <div className="table">
        {shown.map((claim, i) => (
          <div key={`${claim.day}-${claim.id}-${claim.minute}-${i}`} className="trow claim-row">
            <span className="muted num-cell" title={formatShortDate(claim.day)}>
              {claim.day === props.today
                ? clock(claim.minute)
                : `${formatShortDate(claim.day).slice(0, 6)} ${clock(claim.minute)}`}
            </span>
            <button className="linkish strong" onClick={() => props.onOpen(claim.id)}>
              #{claim.id}
            </button>
            <span className="ellipsis" title={claim.title}>{claim.title || "—"}</span>
            <span className="claim-to">
              → <strong>{claim.assigneeName}</strong>
              {claim.fromId > 0 ? <span className="muted"> (von {claim.fromName})</span> : null}
            </span>
          </div>
        ))}
      </div>
      {props.claims.length > shown.length ? (
        <span className="tiny muted">… {nf.format(props.claims.length - shown.length)} weitere im Zeitraum</span>
      ) : null}
      <span className="tiny muted">Läuft fortlaufend mit – die Historie bleibt, auch wenn die Messwerte des Tages altern.</span>
    </div>
  );
}

const WEEKDAY_ROWS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

/** Weekday × hour intake — one hue, darker where more comes in. */
function Heatmap(props: { grid: number[][] }) {
  const max = Math.max(1, ...props.grid.flat());
  const total = props.grid.flat().reduce((a, b) => a + b, 0);
  if (total === 0) {
    return <div className="empty-inline">Noch keine Eingänge gesammelt.</div>;
  }
  return (
    <div className="heat" role="img" aria-label="Eingang nach Wochentag und Stunde">
      {props.grid.map((rowValues, day) => (
        <div key={day} className="heat-line">
          <span className="heat-day">{WEEKDAY_ROWS[day]}</span>
          {rowValues.map((value, hour) => (
            <span
              key={hour}
              className="heat-box"
              title={`${WEEKDAY_ROWS[day]} ${hour}–${hour + 1} Uhr · ${nf.format(value)}`}
              style={{
                background:
                  value > 0 ? `color-mix(in oklch, var(--ink) ${Math.round(12 + (value / max) * 80)}%, var(--bg))` : "var(--soft)",
              }}
            />
          ))}
        </div>
      ))}
      <div className="heat-line">
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} className="heat-hour-label">
            {hour % 6 === 0 ? hour : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
