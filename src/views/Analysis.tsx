import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Meta } from "../api.ts";
import {
  PRESETS,
  REST_ID,
  applyFacet,
  bucketSize,
  groupBy,
  isYmd,
  presetRange,
  series,
  topWithRest,
  totals,
  type Facet,
  type Group,
  type GroupKey,
  type Preset,
  type Range,
} from "../../shared/analysis.ts";
import { berlinYmd, formatShortDate } from "../../shared/days.ts";
import { DAY_TARGET, formatHours, type Support } from "../../shared/timeline.ts";
import { todayYmd } from "../format.ts";
import { RankRows } from "../ui/charts.tsx";
import { Dot, Icon, KeyDot, PageHeader, Ring, SectionTitle, Tile } from "../ui/kit.tsx";
import "../styles/dashboard.css";
import { TimeBars } from "./AnalysisCharts.tsx";

type Props = {
  /** Carries the technician list and who I am. */
  meta: Meta | null;
  onSubtitle: (text: string) => void;
  onError: (error: unknown) => void;
  onOpen: (ticketId: number) => void;
  /** Jump into the day sheet at this Berlin day. */
  onDay: (day: string) => void;
};

const TOP = 10;
/** Rows the bookings table renders; the CSV carries every booking. */
const ROWS_SHOWN = 100;
const nf = new Intl.NumberFormat("de-DE");

export function AnalysisView(props: Props) {
  const me = props.meta?.employeeId ?? 0;
  /**
   * Whose bookings are on screen. Starts at me on every mount — this is my
   * view first; looking at someone else is a deliberate step that does not
   * outlive leaving the view.
   */
  const [who, setWho] = useState(0);
  const employeeId = who || me;
  const foreign = employeeId !== me && employeeId > 0;
  const whoName =
    props.meta?.technicians.find((t) => t.id === employeeId)?.name ?? `Mitarbeiter ${employeeId}`;
  const [preset, setPreset] = useState<Preset | null>("month");
  const [range, setRange] = useState<Range>(() => presetRangeFor("month"));
  const [supports, setSupports] = useState<Support[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * Set while the result area may not be shown. Stale bookings under a fresh
   * heading are worse than no answer at all, so this replaces the whole area
   * instead of passing by as a toast.
   */
  const [problem, setProblem] = useState<string | null>(null);
  const [facet, setFacet] = useState<Facet>(null);
  const [whoOpen, setWhoOpen] = useState(false);
  const whoRef = useRef<HTMLDivElement | null>(null);

  // The person menu closes on any click outside it, like a native select.
  useEffect(() => {
    if (!whoOpen) return;
    function onDown(event: MouseEvent) {
      if (!whoRef.current?.contains(event.target as Node)) setWhoOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setWhoOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [whoOpen]);
  /** Ranges already fetched — going back must not fetch again. */
  const cache = useRef(new Map<string, Support[]>());
  const { onError, onSubtitle } = props;

  // The preset owns the range until the date fields are touched.
  function pick(next: Preset) {
    setPreset(next);
    setRange(presetRangeFor(next));
    setFacet(null);
  }

  /**
   * One end of the range, straight from a date field. `<input type="date">`
   * reports `""` while a field is cleared or half typed, and a range with
   * such an end has no days at all — so a value that is not a whole day is
   * dropped and the previous range stands. What survives is clamped to
   * today, the same rule the presets follow: evaluating days that have not
   * happened yet would only pad "Werktage ohne Buchung".
   */
  function setEnd(which: "from" | "to", value: string) {
    if (!isYmd(value)) return;
    const today = todayYmd();
    const day = value > today ? today : value;
    setRange((r) => (which === "from" ? { ...r, from: day } : { ...r, to: day }));
    setPreset(null);
    setFacet(null);
  }

  useEffect(() => {
    // A reversed range is a statement about the input, not about the data —
    // saying "no bookings in this range" here would answer a question nobody
    // asked. The route would refuse it too; no need to ask it.
    if (range.from > range.to) {
      setProblem("Zeitraum verdreht: „von“ liegt nach „bis“.");
      setSupports([]);
      setLoading(false);
      return;
    }
    // Keyed by `who`, not by the resolved id: 0 means "me" whether or not
    // the meta with my id has arrived yet, so the first load is never fetched
    // twice.
    const key = `${who}|${range.from}..${range.to}`;
    const known = cache.current.get(key);
    if (known) {
      setSupports(known);
      setProblem(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    api
      .supportsRange(range.from, range.to, who || undefined)
      .then((result) => {
        if (!alive) return;
        cache.current.set(key, result.supports);
        setSupports(result.supports);
        setProblem(null);
      })
      .catch((error) => {
        if (!alive) return;
        onError(error);
        // The server said why — a range over a year, a broken date. Carry
        // that reason, and drop the previous range's bookings with it.
        setProblem(error instanceof Error ? error.message : "Der Zeitraum konnte nicht geladen werden.");
        setSupports([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [range.from, range.to, who, onError]);

  const shown = useMemo(() => applyFacet(supports, facet), [supports, facet]);
  const sums = useMemo(() => totals(shown, range), [shown, range]);
  /** The whole range, unfiltered — what a facet's share is a share of. */
  const whole = useMemo(() => totals(supports, range), [supports, range]);
  const size = useMemo(() => bucketSize(range), [range]);
  const slots = useMemo(() => series(shown, range, size), [shown, range, size]);
  const tickets = useMemo(() => topWithRest(groupBy(shown, "ticket"), TOP), [shown]);
  const companies = useMemo(() => topWithRest(groupBy(shown, "company"), TOP), [shown]);
  const types = useMemo(() => topWithRest(groupBy(shown, "type"), 6), [shown]);

  const span = `${formatShortDate(range.from)} – ${formatShortDate(range.to)}`;
  // The view looks identical whoever is shown, so the name travels with the
  // heading. Reading someone else's hours as your own is the one mistake this
  // view must not allow. Without a result there is no sum to carry — the
  // previous range's hours under the new dates would be the same lie the
  // result area refuses.
  const whose = foreign ? `${whoName} · ` : "";
  const subtitle = problem || loading ? `${whose}${span}` : `${whose}${span} · ${formatHours(sums.minutes)}`;
  useEffect(() => {
    onSubtitle(subtitle);
  }, [onSubtitle, subtitle]);

  const target = sums.targetMinutes;
  const share = (part: number) => (sums.minutes > 0 ? `${Math.round((part / sums.minutes) * 100)} %` : "—");
  // Under a facet the calendar figures — working days, target, days without a
  // booking — still describe the whole range, so they would read as a
  // shortfall where only a slice is shown. Nothing here is extrapolated: the
  // numbers that would change meaning step aside instead.
  const drilled = facet !== null;
  const wholeShare =
    whole.minutes > 0 ? `${Math.round((sums.minutes / whole.minutes) * 100)} %` : "—";

  const technicians = props.meta?.technicians ?? [];
  const people = [{ id: 0, label: "Meine Zeiten" }, ...technicians.filter((t) => t.id !== me).map((t) => ({ id: t.id, label: t.name }))];
  const whoLabel = people.find((p) => p.id === who)?.label ?? "Meine Zeiten";
  const perDay = size === "day";
  // Newest first — the latest bookings are the ones you check.
  const shownRows = [...shown].sort((a, b) => b.date - a.date || b.id - a.id).slice(0, ROWS_SHOWN);
  const facetText = facetLabel(facet, { ticket: tickets, company: companies, type: types });

  return (
    <div className="view analysis-view">
      <PageHeader title="Auswertung" subtitle={subtitle}>
        <button
          className="btn primary lg"
          disabled={loading || problem !== null || shown.length === 0}
          onClick={() => downloadCsv(shown, range, foreign ? whoName : "")}
          title="Die Buchungen dieser Ansicht (mit Filter) als CSV für Excel"
        >
          CSV exportieren
        </button>
      </PageHeader>

      <div className="soft-card p20 filter-card">
        <div className="preset-row">
          {PRESETS.map((p) => (
            <button key={p.id} className={`preset${preset === p.id ? " active" : ""}`} onClick={() => pick(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="range-row">
          <label className="range-field">
            <span>Von</span>
            <input type="date" value={range.from} max={todayYmd()} onChange={(e) => setEnd("from", e.target.value)} />
          </label>
          <label className="range-field">
            <span>bis</span>
            <input type="date" value={range.to} max={todayYmd()} onChange={(e) => setEnd("to", e.target.value)} />
          </label>
          {technicians.length > 0 ? (
            <div className="an-who" ref={whoRef}>
              <button className="who-button" aria-haspopup="listbox" aria-expanded={whoOpen} onClick={() => setWhoOpen((o) => !o)}>
                <span>{whoLabel}</span>
                <Icon d="m6 9 6 6 6-6" size={14} stroke={2} />
              </button>
              {whoOpen ? (
                <div className="popover who-menu" role="listbox">
                  {people.map((p, i) => (
                    <button
                      key={p.id}
                      role="option"
                      aria-selected={who === p.id}
                      className={`popover-item${who === p.id ? " active" : ""}${i === 0 ? " first" : ""}`}
                      onClick={() => {
                        setWho(p.id);
                        setFacet(null);
                        setWhoOpen(false);
                      }}
                    >
                      <span style={{ flex: 1 }}>{p.label}</span>
                      {who === p.id ? <Icon d="M20 6 9 17l-5-5" size={14} stroke={2.5} /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {foreign ? (
          // The tiles, bars and table look exactly the same whoever is shown.
          // Without this line a glance after coming back reads someone else's
          // hours as your own.
          <div className="filter-note">
            <span className="foreign-pill">
              <Dot tone="warn" />
              Zeiten von {whoName}
            </span>
            <button className="linkish" onClick={() => setWho(0)}>
              Zurück zu meinen
            </button>
          </div>
        ) : null}
        {facet ? (
          <div className="filter-note">
            <span className="facet-pill">
              {facetText}
              <button onClick={() => setFacet(null)} title="Filter aufheben" aria-label="Filter aufheben">
                <Icon d="M18 6 6 18M6 6l12 12" size={10} stroke={3} />
              </button>
            </span>
            <span className="small muted">Klick auf Balken oder Legende filtert, erneuter Klick hebt auf.</span>
          </div>
        ) : null}
      </div>

      {loading ? (
        // One quiet placeholder for the whole result area — the tiles, bars,
        // ring and table all read off `shown`, which still holds the previous
        // range's data while the new one is in flight. Showing them here would
        // read as an answer about the new range that it is not.
        <div className="empty-note">Lädt …</div>
      ) : problem ? (
        // The same area the loading hint covers. Everything below reads off
        // the previous range's bookings; showing it under the new heading
        // would answer a question that was never answered.
        <div className="problem-note">
          <Dot tone="danger" />
          {problem}
        </div>
      ) : (
        <>
          <div className="tiles wide">
            <Tile
              label="Gebucht"
              value={formatHours(sums.minutes)}
              hint={
                drilled
                  ? `${wholeShare} von ${formatHours(whole.minutes)} im Zeitraum`
                  : `Soll ${formatHours(target)} (${sums.workdays} Werktage) · ${target ? Math.round((sums.minutes / target) * 100) : 0} %`
              }
            />
            <Tile label="Abrechenbar" value={formatHours(sums.billable)} hint={`${share(sums.billable)} · nicht berechnet ${formatHours(sums.notCharged)}`} />
            <Tile label="Intern" value={formatHours(sums.internal)} hint={share(sums.internal)} />
            <Tile label="Freigegeben" value={formatHours(sums.cleared)} hint={`offen ${formatHours(sums.open)}`} />
            {drilled ? null : (
              <Tile
                label="Werktage ohne Buchung"
                value={String(sums.daysWithout.length)}
                hint={sums.daysWithout.map((d) => formatShortDate(d).slice(0, 6)).join(" ") || "keiner"}
                tone={sums.daysWithout.length > 0 ? "warn" : undefined}
              />
            )}
          </div>

          <section className="section">
            <SectionTitle
              title={`Verlauf ${perDay ? "je Tag" : size === "week" ? "je Woche" : "je Monat"}`}
              note={
                perDay
                  ? foreign
                    ? ""
                    : "Klick auf einen Tag öffnet den Tagesbogen"
                  : "Über 45 Tage wird je Woche gezeigt; ohne Soll-Linie"
              }
            />
            {/* The day sheet only ever shows my own bookings, so a bar of
                someone else's has nowhere honest to jump — better no click
                than one that quietly lands on my day. */}
            <TimeBars slots={slots} targetPerSlot={perDay ? DAY_TARGET : undefined} onPick={foreign ? undefined : props.onDay} />
          </section>

          <div className="dash-pair">
            <section className="section dash-pair-half">
              <SectionTitle title="Top-Tickets" />
              <RankRows
                rows={tickets.map((g) => ({ id: g.id === REST_ID ? undefined : g.id, label: g.label, title: g.hint || g.label, value: g.minutes }))}
                format={formatHours}
                empty="Keine Buchungen in diesem Zeitraum."
                activeId={facet?.key === "ticket" ? facet.id : undefined}
                onPick={(id) => setFacet(facet?.key === "ticket" && facet.id === id ? null : { key: "ticket", id })}
              />
            </section>
            <section className="section dash-pair-half">
              <SectionTitle title="Top-Kunden" />
              <RankRows
                rows={companies.map((g) => ({ id: g.id === REST_ID ? undefined : g.id, label: g.label, title: g.hint || g.label, value: g.minutes }))}
                format={formatHours}
                empty="Keine Buchungen in diesem Zeitraum."
                activeId={facet?.key === "company" ? facet.id : undefined}
                onPick={(id) => setFacet(facet?.key === "company" && facet.id === id ? null : { key: "company", id })}
              />
            </section>
          </div>

          <section className="soft-card">
            <SectionTitle title="Leistungsarten" />
            {sums.minutes === 0 ? (
              <span className="muted">Keine Buchungen in diesem Zeitraum.</span>
            ) : (
              <div className="ring-wrap wide">
                <Ring segments={types.map((g) => ({ label: g.label, value: g.minutes }))} total={formatHours(sums.minutes)} unit="gebucht" size={150} />
                <div className="type-rows">
                  {types.map((g, i) => {
                    const id = g.id === REST_ID ? undefined : g.id;
                    const active = facet?.key === "type" && facet.id === id;
                    return (
                      <button
                        key={g.id}
                        className={`type-row${active ? " active" : ""}`}
                        disabled={!id}
                        onClick={() => id && setFacet(active ? null : { key: "type", id })}
                      >
                        <KeyDot index={i} />
                        <span className="label">{g.label}</span>
                        <span className="share">{share(g.minutes)}</span>
                        <span className="val">{formatHours(g.minutes)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          <section className="section">
            <SectionTitle title="Buchungen" note={nf.format(shown.length)} />
            <div className="table-scroll">
              <div className="table bookings">
                <div className="thead">
                  <span>Datum</span>
                  <span>Dauer</span>
                  <span>Ticket</span>
                  <span>Kunde</span>
                  <span>Art</span>
                  <span>Text</span>
                </div>
                {shownRows.map((s) => (
                  <div key={s.id} className="trow">
                    <span className="num-cell">{formatShortDate(berlinDay(s)).slice(0, 6)}</span>
                    <span className="num-cell strong">{formatHours(s.duration)}</span>
                    <span>
                      {s.ticketId ? (
                        <button className="linkish" onClick={() => props.onOpen(s.ticketId)}>
                          #{s.ticketId}
                        </button>
                      ) : (
                        <span className="mute">—</span>
                      )}
                    </span>
                    <span className="ellipsis" title={s.companyName}>{s.companyName}</span>
                    <span className="ellipsis muted" title={s.typeName}>{s.typeName}</span>
                    <span className="ellipsis" title={s.text}>{s.text}</span>
                  </div>
                ))}
                {shown.length > shownRows.length ? (
                  <div className="table-more">
                    {nf.format(shown.length - shownRows.length)} weitere Buchungen – der CSV-Export enthält alle.
                  </div>
                ) : null}
                {shown.length === 0 ? <div className="empty-inline">Keine Buchungen in diesem Zeitraum.</div> : null}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/** Never past today: a preset gives the full calendar span, this trims it. */
function clampToToday(range: Range): Range {
  const today = todayYmd();
  return range.to > today ? { ...range, to: today } : range;
}

function presetRangeFor(preset: Preset): Range {
  return clampToToday(presetRange(preset, todayYmd()));
}

function berlinDay(support: Support): string {
  return berlinYmd(support.date);
}

// One list per facet kind, keyed by GroupKey — ticket, company and type ids
// are separate number ranges and collide as plain strings, so the lookup
// must never search the merged list. A fourth facet kind cannot skip this:
// Record<GroupKey, …> forces its list to be supplied too.
function facetLabel(facet: Facet, byKey: Record<GroupKey, Group[]>): string {
  if (!facet) return "";
  const noun = facet.key === "ticket" ? "Ticket" : facet.key === "company" ? "Kunde" : "Art";
  const found = byKey[facet.key].find((g) => g.id === facet.id);
  return `${noun}: ${found?.label ?? facet.id}`;
}

/**
 * The bookings on screen as CSV for Excel: semicolons, decimal commas, a BOM
 * so umlauts survive the double click. Built in the browser from what the
 * view already holds — no second round trip to TANSS.
 */
function downloadCsv(supports: Support[], range: Range, whose: string) {
  const cell = (value: string) => (/[";\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const header = ["Datum", "Beginn", "Dauer (min)", "Dauer (h)", "Ticket", "Kunde", "Art", "Ort", "Intern", "Nicht berechnet (min)", "Freigabe", "Text"];
  const lines = [...supports]
    .sort((a, b) => a.date - b.date)
    .map((s) => {
      const start = new Date(s.date * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
      return [
        formatShortDate(berlinDay(s)),
        start,
        String(s.duration),
        (s.duration / 60).toFixed(2).replace(".", ","),
        s.ticketId ? String(s.ticketId) : "",
        s.companyName,
        s.typeName,
        LOCATION_LABEL[s.location] ?? s.location,
        s.internal ? "ja" : "nein",
        String(s.durationNotCharged),
        s.clearanceStatus === "CLEARED" ? "freigegeben" : "offen",
        s.text.replace(/\s+/g, " ").trim(),
      ]
        .map(cell)
        .join(";");
    });
  const csv = "\ufeff" + [header.join(";"), ...lines].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const who = whose ? `-${whose.toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-")}` : "";
  a.download = `buchungen${who}-${range.from}-bis-${range.to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const LOCATION_LABEL: Record<string, string> = { OFFICE: "Büro", REMOTE: "Remote", CUSTOMER: "Beim Kunden" };
