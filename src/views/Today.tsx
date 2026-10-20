import { useEffect, useMemo, useState } from "react";
import { api, type Briefing, type Meta } from "../api.ts";
import type { Activity } from "../../shared/activity.ts";
import { formatElapsed } from "../../shared/activity.ts";
import { berlinMinuteOfDay } from "../../shared/days.ts";
import { sumMinutes, supportsOfDay, WEEK_TARGET, type Support } from "../../shared/timeline.ts";
import type { TicketRow } from "../../shared/tickets.ts";
import { byUrgency, dueLabel, dueState, dueToday, firstName, greeting, ownOpen } from "../../shared/today.ts";
import { nowUnix, todayYmd } from "../format.ts";
import { Icon, SPARK } from "../ui/kit.tsx";
import type { View } from "../Shell.tsx";
import "../styles/today.css";

type Props = {
  meta: Meta | null;
  employeeId: number;
  agentReady: boolean;
  reload: number;
  onOpen: (id: number) => void;
  onView: (view: View) => void;
  onError: (error: unknown) => void;
  /** Hands the loaded tickets to the agent sidebar, like the board does. */
  onData: (rows: TicketRow[], activity: Record<number, Activity>) => void;
};

/** How many of my tickets the start page lists before pointing to the board. */
const LIST_LIMIT = 8;

/**
 * Today's briefing survives leaving the page: it costs a model run, and the
 * server would hand back the same text for the rest of the day anyway.
 */
let kept: { day: string; employeeId: number; briefing: Briefing } | null = null;

const LONG_DATE = new Intl.DateTimeFormat("de-DE", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Europe/Berlin",
});

/** "32,5 h" — hours without the trailing zeros the day sheet keeps. */
function hours(minutes: number): string {
  return `${(Math.round((minutes / 60) * 100) / 100).toString().replace(".", ",")} h`;
}

function clock(unix: number): string {
  const minute = berlinMinuteOfDay(unix);
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/**
 * The start page: greeting, the agent's briefing over my tickets, what needs
 * me first, what is due today and how far the week's hours are booked.
 */
export function TodayView(props: Props) {
  const { onError, onData, employeeId } = props;
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [activity, setActivity] = useState<Record<number, Activity>>({});
  /** The histories are still on their way; a briefing now would miss the stale tickets. */
  const [activityPending, setActivityPending] = useState(false);
  const [window_, setWindow] = useState<{ today: string; since: string } | null>(null);
  const [week, setWeek] = useState<Support[] | null>(null);
  const [briefing, setBriefing] = useState<Briefing | null>(() =>
    kept && kept.day === todayYmd() && kept.employeeId === employeeId ? kept.briefing : null,
  );
  const [briefingBusy, setBriefingBusy] = useState(false);
  const [now, setNow] = useState(nowUnix);
  const today = todayYmd();

  useEffect(() => {
    const timer = window.setInterval(() => setNow(nowUnix()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setActivityPending(false);
    api
      .tickets()
      .then((result) => {
        if (cancelled) return;
        setRows(result.rows);
        const ids = ownOpen(result.rows, employeeId).map((r) => r.id).slice(0, 200);
        if (!ids.length) return;
        // The histories make "longest without a trace" exact; without them
        // the age stands in, so a failure here is no reason to complain.
        setActivityPending(true);
        api
          .activity(ids)
          .then((a) => {
            if (cancelled) return;
            const map: Record<number, Activity> = {};
            for (const [id, value] of Object.entries(a.activity)) map[Number(id)] = value;
            setActivity(map);
            setWindow({ today: a.today, since: a.since });
          })
          .catch(() => null)
          .finally(() => {
            if (!cancelled) setActivityPending(false);
          });
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    api
      .supports(todayYmd())
      .then((result) => !cancelled && setWeek(result.supports))
      .catch((error: unknown) => {
        if (!cancelled) onError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [props.reload, employeeId, onError]);

  // Once loaded, an empty result is news too: it clears the board the nav badge and the sidebar read.
  useEffect(() => {
    if (!loading) onData(rows, activity);
  }, [loading, rows, activity, onData]);

  const own = useMemo(() => ownOpen(rows, employeeId), [rows, employeeId]);
  const ordered = useMemo(
    () => byUrgency(own, activity, now, window_?.today ?? today, window_?.since ?? today),
    [own, activity, now, window_, today],
  );
  const due = useMemo(() => dueToday(own, now), [own, now]);

  async function makeBriefing(force: boolean) {
    setBriefingBusy(true);
    try {
      const result = await api.agent.briefing({ rows, activity, force, scope: "mine" });
      kept = { day: todayYmd(), employeeId, briefing: result };
      setBriefing(result);
    } catch (error) {
      onError(error);
    } finally {
      setBriefingBusy(false);
    }
  }

  const name = firstName(props.meta?.technicians.find((t) => t.id === employeeId)?.name ?? "");
  const weekMinutes = week ? sumMinutes(week) : 0;
  const todayMinutes = week ? sumMinutes(supportsOfDay(week, today)) : 0;
  const share = (minutes: number) => `${Math.min(100, (minutes / WEEK_TARGET) * 100)}%`;
  const lastTrace = (row: TicketRow) => activity[row.id]?.at || row.creationDate;

  return (
    <div className="view today">
      <div className="today-head">
        <span className="muted">{LONG_DATE.format(new Date(now * 1000))}</span>
        <h1>
          {greeting(berlinMinuteOfDay(now))}
          {name ? `, ${name}` : ""}
        </h1>
      </div>

      <section className="briefing-card">
        <div className="briefing-label">
          <Icon d={SPARK} size={18} />
          <span>
            Briefing
            {briefing ? ` · ${clock(briefing.createdAt > 1e12 ? Math.floor(briefing.createdAt / 1000) : briefing.createdAt)}` : ""}
          </span>
        </div>
        {briefing ? (
          <p className="briefing-text">{linkIds(briefing.text, props.onOpen)}</p>
        ) : briefingBusy ? (
          <p className="briefing-text muted">
            <span className="dot xs pulse" /> Der Agent liest deine Tickets …
          </p>
        ) : props.agentReady ? (
          <p className="briefing-text muted">
            Der Agent fasst deine offenen Tickets zusammen: was neu ist, was drängt und was liegen geblieben ist.
          </p>
        ) : (
          <p className="briefing-text muted">
            Für das Briefing braucht es ein lokales Modell.{" "}
            <button className="linkish" onClick={() => props.onView("settings")}>
              KI einrichten
            </button>
          </p>
        )}
        <div className="briefing-actions">
          {!briefing && props.agentReady ? (
            <button className="btn primary" disabled={briefingBusy || loading || activityPending || own.length === 0} onClick={() => void makeBriefing(false)}>
              {briefingBusy ? "Schreibt …" : activityPending ? "Verläufe laden …" : "Briefing erstellen"}
            </button>
          ) : null}
          <button className={`btn${briefing || !props.agentReady ? " primary" : ""}`} onClick={() => props.onView("times")}>
            Zeiten prüfen
          </button>
          <button className="btn" onClick={() => props.onView("tickets")}>
            Tickets ansehen
          </button>
          {briefing ? (
            <button className="btn ghost" disabled={briefingBusy || activityPending} onClick={() => void makeBriefing(true)} title="Verwerfen und neu schreiben">
              {briefingBusy ? "Schreibt …" : "Neu schreiben"}
            </button>
          ) : null}
        </div>
      </section>

      <div className="today-columns">
        <section className="today-main">
          <div className="today-main-head">
            <div className="row" style={{ alignItems: "baseline", gap: 12 }}>
              <h2 className="h2">Meine offenen Tickets</h2>
              <span className="muted">{loading ? "" : own.length}</span>
            </div>
            <p className="lead">
              Was dich zuerst braucht: verpasste und heutige Termine, danach, was am längsten ohne Kommentar oder Leistung liegt.
            </p>
          </div>
          {loading ? (
            <div className="empty-note">Lädt aus TANSS …</div>
          ) : ordered.length === 0 ? (
            <div className="empty-note">
              <div style={{ fontWeight: 500, color: "var(--ink)" }}>Nichts offen bei dir.</div>
              <div>Neue Tickets findest du unter „Unzugewiesen“.</div>
            </div>
          ) : (
            <div className="attention">
              {ordered.slice(0, LIST_LIMIT).map((row) => {
                const state = dueState(row, now);
                return (
                  <button key={row.id} className="attention-row" onClick={() => props.onOpen(row.id)}>
                    <span className="attention-meta">
                      <span className="badge">{row.statusName || "—"}</span>
                      <span className="attention-id">#{row.id}</span>
                      <span className="muted ellipsis">{row.companyName || "—"}</span>
                      {state === "overdue" || state === "today" ? (
                        <span className={`attention-age ${state === "overdue" ? "danger" : "warn"}`}>
                          <span className={`dot ${state === "overdue" ? "danger" : "warn"}`} />
                          fällig {dueLabel(row, now)}
                        </span>
                      ) : (
                        <span className="attention-age" title="Seit der letzten Spur (Kommentar oder Leistung)">
                          {formatElapsed(lastTrace(row), now)} still
                        </span>
                      )}
                    </span>
                    <span className="attention-title">{row.title}</span>
                    {row.waiting ? (
                      <span className="attention-note">
                        <span className="dot warn" /> wartet auf Kunde
                      </span>
                    ) : null}
                  </button>
                );
              })}
              {ordered.length > LIST_LIMIT ? (
                <button className="linkish muted attention-more" onClick={() => props.onView("tickets")}>
                  Alle {ordered.length} in Tickets →
                </button>
              ) : null}
            </div>
          )}
        </section>

        <aside className="today-aside">
          <div className="soft-card">
            <div className="today-card-head">
              <h2 className="h2">Fällig heute</h2>
              <button className="linkish muted" onClick={() => props.onView("tickets")}>
                Alle Tickets →
              </button>
            </div>
            {loading ? (
              <span className="muted">Lädt …</span>
            ) : due.length === 0 ? (
              <span className="muted">Heute ist nichts fällig.</span>
            ) : (
              <div className="due-list">
                {due.map((row) => {
                  const state = dueState(row, now);
                  return (
                    <button key={row.id} className="due-row" onClick={() => props.onOpen(row.id)}>
                      <span className="due-text">
                        <span className="due-title">{row.title}</span>
                        <span className="due-sub">
                          #{row.id} · {row.companyName || "—"}
                        </span>
                      </span>
                      <span className={`due-when ${state === "overdue" ? "danger" : "warn"}`}>{dueLabel(row, now)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="soft-card">
            <h2 className="h2">Zeiten diese Woche</h2>
            <div className="week-figure">
              <span className="week-value">{week ? hours(weekMinutes) : "…"}</span>
              <span className="muted">von {hours(WEEK_TARGET)} gebucht</span>
            </div>
            <div className="week-bar" title={`${hours(weekMinutes)} von ${hours(WEEK_TARGET)}`}>
              <span className="done" style={{ width: share(weekMinutes - todayMinutes) }} />
              <span className="now" style={{ width: share(todayMinutes) }} />
            </div>
            <div className="week-legend">
              <span>
                <span className="dot" /> bis gestern
              </span>
              <span>
                <span className="dot flat" /> heute {hours(todayMinutes)}
              </span>
            </div>
            <button className="btn primary" style={{ alignSelf: "flex-start" }} onClick={() => props.onView("times")}>
              Zeiten öffnen
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** "#4711" in the text becomes a click that opens the ticket. */
function linkIds(text: string, onOpen: (id: number) => void) {
  return text.split(/(#\d{2,})/g).map((part, i) => {
    const m = /^#(\d{2,})$/.exec(part);
    if (!m) return <span key={i}>{part}</span>;
    return (
      <button key={i} className="linkish briefing-id" onClick={() => onOpen(Number(m[1]))}>
        {part}
      </button>
    );
  });
}
