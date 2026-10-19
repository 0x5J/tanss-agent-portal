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
import { DonutCard, HBars, StatTile } from "../ui/charts.tsx";
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

  useEffect(() => {
    const span = `${formatShortDate(range.from)}–${formatShortDate(range.to)}`;
    // The view looks identical whoever is shown, so the name travels with the
    // heading. Reading someone else's hours as your own is the one mistake
    // this view must not allow.
    const whose = foreign ? `${whoName} · ` : "";
    // Without a result there is no sum to carry — the previous range's hours
    // under the new dates would be the same lie the result area refuses.
    onSubtitle(problem ? `${whose}${span}` : `${whose}${span} · ${formatHours(sums.minutes)}`);
  }, [onSubtitle, range, sums.minutes, problem, foreign, whoName]);

  const target = sums.targetMinutes;
  const share = (part: number) => (sums.minutes > 0 ? `${Math.round((part / sums.minutes) * 100)} %` : "—");
  // Under a facet the calendar figures — working days, target, days without a
  // booking — still describe the whole range, so they would read as a
  // shortfall where only a slice is shown. Nothing here is extrapolated: the
  // numbers that would change meaning step aside instead.
  const drilled = facet !== null;
  const wholeShare =
    whole.minutes > 0 ? `${Math.round((sums.minutes / whole.minutes) * 100)} %` : "—";

  return (
    <div className="dash">
      <div className="viz-card">
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {PRESETS.map((p) => (
            <button key={p.id} className={`btn ghost small${preset === p.id ? " active" : ""}`} onClick={() => pick(p.id)}>
              {p.label}
            </button>
          ))}
          <span className="spacer" style={{ marginLeft: "auto" }} />
          <input
            className="input"
            type="date"
            value={range.from}
            max={todayYmd()}
            onChange={(e) => setEnd("from", e.target.value)}
          />
          <span className="tiny muted">bis</span>
          <input
            className="input"
            type="date"
            value={range.to}
            max={todayYmd()}
            onChange={(e) => setEnd("to", e.target.value)}
          />
          {props.meta && props.meta.technicians.length > 0 ? (
            <select
              className="input"
              value={who}
              onChange={(e) => {
                setWho(Number(e.target.value));
                setFacet(null);
              }}
            >
              <option value={0}>Meine Zeiten</option>
              {props.meta.technicians
                .filter((t) => t.id !== me)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          ) : null}
        </div>
        {foreign ? (
          // The tiles, bars and table look exactly the same whoever is shown.
          // Without this line a glance after coming back reads someone else's
          // hours as your own.
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <span className="badge" style={{ color: "var(--warn)" }}>
              Zeiten von {whoName}
            </span>
            <button className="btn ghost small" onClick={() => setWho(0)}>
              Zurück zu meinen
            </button>
          </div>
        ) : null}
        {facet ? (
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <span className="filter-chip">{facetLabel(facet, { ticket: tickets, company: companies, type: types })}</span>
            <button className="btn ghost small" onClick={() => setFacet(null)}>
              Filter aufheben
            </button>
          </div>
        ) : null}
      </div>

      {loading ? (
        // One quiet placeholder for the whole result area — the tiles, bars,
        // donut and table all read off `shown`, which still holds the
        // previous range's data while the new one is in flight. Showing them
        // here would read as an answer about the new range that it is not.
        <div className="viz-card">
          <div className="small muted" style={{ padding: "18px 0" }}>Lädt …</div>
        </div>
      ) : problem ? (
        // The same area the loading hint covers. Tiles, bars, donut and table
        // all read off the previous range's bookings; showing them under the
        // new heading would answer a question that was never answered.
        <div className="viz-card">
          <div className="small" style={{ padding: "18px 0", color: "var(--danger)" }}>{problem}</div>
        </div>
      ) : (
        <>
          <div className="dash-tiles">
            <StatTile
              label="Gebucht"
              value={formatHours(sums.minutes)}
              hint={
                drilled
                  ? `${wholeShare} von ${formatHours(whole.minutes)} im Zeitraum`
                  : `Soll ${formatHours(target)} (${sums.workdays} Werktage) · ${target ? Math.round((sums.minutes / target) * 100) : 0} %`
              }
            />
            <StatTile label="Abrechenbar" value={formatHours(sums.billable)} hint={`${share(sums.billable)} · nicht berechnet ${formatHours(sums.notCharged)}`} />
            <StatTile label="Intern" value={formatHours(sums.internal)} hint={share(sums.internal)} />
            <StatTile label="Freigegeben" value={formatHours(sums.cleared)} hint={`offen ${formatHours(sums.open)}`} />
            {drilled ? null : (
              <StatTile
                label="Werktage ohne Buchung"
                value={String(sums.daysWithout.length)}
                hint={sums.daysWithout.map((d) => formatShortDate(d).slice(0, 6)).join(" ") || "keiner"}
                tone={sums.daysWithout.length > 0 ? "warn" : undefined}
              />
            )}
          </div>

          <div className="viz-card">
            <div className="viz-title" style={{ marginBottom: 8 }}>
              Verlauf {size === "day" ? "je Tag" : size === "week" ? "je Woche" : "je Monat"}
            </div>
            {/* The day sheet only ever shows my own bookings, so a bar of
                someone else's has nowhere honest to jump — better no click
                than one that quietly lands on my day. */}
            <TimeBars
              slots={slots}
              targetPerSlot={size === "day" ? DAY_TARGET : undefined}
              onPick={foreign ? undefined : props.onDay}
            />
          </div>

          <div className="dash-row">
            <div className="viz-card" style={{ marginBottom: 0 }}>
              <div className="viz-title" style={{ marginBottom: 8 }}>Top-Tickets</div>
              <HBars
                rows={tickets.map((g) => ({
                  id: g.id === REST_ID ? undefined : g.id,
                  label: g.label,
                  title: g.hint || g.label,
                  count: g.minutes,
                }))}
                format={formatHours}
                empty="Keine Buchungen in diesem Zeitraum."
                activeId={facet?.key === "ticket" ? facet.id : undefined}
                valueWidth={56}
                onPick={(id) => setFacet(facet?.key === "ticket" && facet.id === id ? null : { key: "ticket", id })}
              />
            </div>
            <div className="viz-card" style={{ marginBottom: 0 }}>
              <div className="viz-title" style={{ marginBottom: 8 }}>Top-Kunden</div>
              <HBars
                rows={companies.map((g) => ({
                  id: g.id === REST_ID ? undefined : g.id,
                  label: g.label,
                  title: g.hint || g.label,
                  count: g.minutes,
                }))}
                format={formatHours}
                empty="Keine Buchungen in diesem Zeitraum."
                activeId={facet?.key === "company" ? facet.id : undefined}
                valueWidth={56}
                onPick={(id) => setFacet(facet?.key === "company" && facet.id === id ? null : { key: "company", id })}
              />
            </div>
          </div>

          <DonutCard
            title="Leistungsarten"
            segments={types.map((g) => ({ id: g.id === REST_ID ? undefined : g.id, label: g.label, count: g.minutes }))}
            total={sums.minutes}
            format={formatHours}
            unit="gebucht"
            empty="Keine Buchungen in diesem Zeitraum."
            centerFontSize={22}
            activeId={facet?.key === "type" ? facet.id : undefined}
            onPick={(id) => setFacet(facet?.key === "type" && facet.id === id ? null : { key: "type", id })}
          />

          <div className="viz-card">
            <div className="viz-title" style={{ marginBottom: 8 }}>Buchungen ({shown.length})</div>
            <div className="times-table">
              <div className="line">
                <span className="tiny muted" style={{ flex: "none", width: 82 }}>Datum</span>
                <span className="tiny muted" style={{ flex: "none", width: 64 }}>Dauer</span>
                <span className="tiny muted" style={{ flex: "none", width: 70 }}>Ticket</span>
                <span className="tiny muted" style={{ flex: "none", width: 160 }}>Kunde</span>
                <span className="tiny muted" style={{ flex: "none", width: 140 }}>Art</span>
                <span className="tiny muted" style={{ flex: 1, minWidth: 0 }}>Text</span>
              </div>
              {shown.map((s) => (
                <div key={s.id} className="line">
                  <span className="mono" style={{ flex: "none", width: 82 }}>{formatShortDate(berlinDay(s))}</span>
                  <span className="mono" style={{ flex: "none", width: 64 }}>{formatHours(s.duration)}</span>
                  <span style={{ flex: "none", width: 70 }}>
                    {s.ticketId ? (
                      <button className="btn ghost small" onClick={() => props.onOpen(s.ticketId)}>
                        #{s.ticketId}
                      </button>
                    ) : (
                      <span className="tiny muted">—</span>
                    )}
                  </span>
                  <span className="ellipsis" style={{ flex: "none", width: 160 }} title={s.companyName}>
                    {s.companyName}
                  </span>
                  <span className="ellipsis" style={{ flex: "none", width: 140 }} title={s.typeName}>
                    {s.typeName}
                  </span>
                  <span className="ellipsis" style={{ flex: 1, minWidth: 0 }} title={s.text}>
                    {s.text}
                  </span>
                </div>
              ))}
            </div>
            {shown.length === 0 ? (
              <div className="small muted" style={{ padding: "18px 0" }}>Keine Buchungen in diesem Zeitraum.</div>
            ) : null}
          </div>
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
