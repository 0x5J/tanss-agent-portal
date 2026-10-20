import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Meta } from "../api.ts";
import { berlinMinuteOfDay, formatLongDate, shiftYmd } from "../../shared/days.ts";
import {
  DAY_TARGET,
  WEEK_TARGET,
  WINDOW_END,
  WINDOW_START,
  buildBlocks,
  formatClock,
  formatHours,
  nextFreeStart,
  sumMinutes,
  supportsOfDay,
  type Support,
} from "../../shared/timeline.ts";
import { todayYmd } from "../format.ts";
import { BookingForm, type BookingInitial } from "./BookingForm.tsx";
import type { BookingTemplate } from "../../shared/template.ts";
import { durationForGap, routinesForGap, type Routine } from "../../shared/routines.ts";
import type { BookingIdea } from "../../shared/assistant.ts";
import {
  draftForGap,
  draftFromIdea,
  draftFromRoutine,
  draftFromSupport,
  draftFromTemplate,
} from "../../shared/draft.ts";

type Props = {
  meta: Meta | null;
  reload: number;
  onSubtitle: (text: string) => void;
  onError: (error: unknown) => void;
  onToast: (text: string) => void;
  onChanged: () => void;
  onOpen: (id: number) => void;
  agentReady: boolean;
  /** Which day to open at; today when nothing is given. */
  initialDay?: string;
};

const TOP = 8;
const MIN_PX_PER_HOUR = 36;

export function TimesView(props: Props) {
  const [day, setDay] = useState(props.initialDay ?? todayYmd());
  const [supports, setSupports] = useState<Support[]>([]);
  const [templates, setTemplates] = useState<BookingTemplate[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [ideas, setIdeas] = useState<BookingIdea[] | null>(null);
  const [note, setNote] = useState("");
  const [thinking, setThinking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [draft, setDraft] = useState<BookingInitial>({ date: day });
  /**
   * Bumped for every new draft. The form reads its fields into local state
   * when it mounts, so without a changing key a clicked gap, template or
   * suggestion would leave the old values standing.
   */
  const [draftSeq, setDraftSeq] = useState(0);

  function openDraft(next: BookingInitial) {
    setDraft(next);
    setDraftSeq((n) => n + 1);
  }
  const chartRef = useRef<HTMLDivElement | null>(null);
  const [chartHeight, setChartHeight] = useState(600);

  /** Open an existing booking for changing — the lock reason comes with it. */
  async function edit(support: Support) {
    try {
      const found = await api.support(support.id);
      openDraft(draftFromSupport(found.support, found.lockText));
    } catch (error) {
      props.onError(error);
    }
  }

  /** One call over the whole day — or over one gap when asked for that. */
  async function askAssistant(focus?: { start: number; end: number }) {
    setThinking(true);
    try {
      const result = await api.agent.assistant(day, focus);
      setIdeas(result.ideas);
      setNote(result.note);
    } catch (error) {
      props.onError(error);
    } finally {
      setThinking(false);
    }
  }

  // The chart fills whatever height the view leaves it; the scale follows.
  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    const update = () => setChartHeight(el.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const PX_PER_HOUR = Math.max(MIN_PX_PER_HOUR, (chartHeight - TOP * 2) / ((WINDOW_END - WINDOW_START) / 60));
  const { onSubtitle, onError } = props;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .supports(day)
      .then((result) => {
        if (!cancelled) {
          setSupports(result.supports);
          setTemplates(result.templates ?? []);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [day, version, props.reload, onError]);

  useEffect(() => {
    onSubtitle(formatLongDate(day));
  }, [day, onSubtitle]);

  useEffect(() => {
    openDraft({ date: day });
    setIdeas(null);
    setNote("");
  }, [day]);

  useEffect(() => {
    let cancelled = false;
    api
      .routines()
      .then((r) => !cancelled && setRoutines(r.routines))
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, [props.reload]);

  // A fresh draft starts where the day left off, not always at nine.
  useEffect(() => {
    setDraft((current) => {
      if (current.supportId || current.startMinute !== undefined) return current;
      setDraftSeq((n) => n + 1);
      return { ...current, startMinute: nextFreeStart(supportsOfDay(supports, day)) };
    });
  }, [supports, day]);

  const today = supportsOfDay(supports, day);
  // Only meaningful for the current day; drawn as a thin red rule.
  const nowMinute = berlinMinuteOfDay(Math.floor(Date.now() / 1000));
  const blocks = useMemo(() => buildBlocks(today), [today]);
  const gaps = blocks.filter((b) => b.kind === "gap");
  const dayMinutes = sumMinutes(today);
  const weekMinutes = sumMinutes(supports);
  const outside = today.filter((s) => {
    const block = blocks.find((b) => b.kind === "support" && b.support.id === s.id);
    return block && (block.end <= WINDOW_START || block.start >= WINDOW_END);
  });

  const hours: number[] = [];
  for (let h = WINDOW_START / 60; h <= WINDOW_END / 60; h++) hours.push(h);

  return (
    <div className="times">
      <div className="times-left">
        <div className="day-head">
          <button className="btn icon" onClick={() => setDay(shiftYmd(day, -1))} aria-label="Vortag">
            ←
          </button>
          <span className="mono">{day.split("-").reverse().join(".")}</span>
          <button className="btn icon" onClick={() => setDay(shiftYmd(day, 1))} aria-label="Folgetag">
            →
          </button>
          <button className="btn ghost small" onClick={() => setDay(todayYmd())}>
            heute
          </button>
          {loading ? (
            <span className="row small muted" style={{ gap: 6 }}>
              <span className="dot sm" style={{ animation: "pulse 2.4s ease-in-out infinite" }} /> lädt aus TANSS
            </span>
          ) : (
            <>
              <span
                className="day-meter"
                title={`${formatHours(dayMinutes)} von ${formatHours(DAY_TARGET)} gebucht`}
              >
                <i style={{ width: `${Math.min(100, (dayMinutes / DAY_TARGET) * 100)}%` }} />
              </span>
              <span className="day-stats">
                <span>
                  Tag <b>{formatHours(dayMinutes)}</b> von {formatHours(DAY_TARGET)}
                </span>
                <span>
                  Woche <b>{formatHours(weekMinutes)}</b> von {formatHours(WEEK_TARGET)}
                </span>
              </span>
            </>
          )}
        </div>

        {templates.length ? (
          <div className="templates">
            <div className="row tiny muted" style={{ marginBottom: 5 }}>
              <span className="badge">VORLAGEN</span>
              <span className="pretty">
                Termine und Telefonate, die TANSS kennt — noch nicht gebucht und in keiner Summe.
              </span>
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {templates.map((t) => (
                <button
                  key={t.key}
                  className="btn template"
                  title={`${t.title}${t.detail ? ` · ${t.detail}` : ""} · ${t.duration} min`}
                  onClick={() => openDraft(draftFromTemplate(day, t))}
                >
                  <span className={`dot xs ${t.kind === "call" ? "agent" : "ok"}`} />
                  <span className="mono tiny">{formatClock(t.startMinute)}</span>
                  <span className="ellipsis" style={{ maxWidth: 190 }}>{t.title}</span>
                  <span className="tiny muted">{t.duration} min</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="chart" ref={chartRef}>
          {hours.map((h) => (
            <div
              key={h}
              className={`hour${h % 2 === 0 ? " band" : ""}`}
              style={{ top: TOP + (h - WINDOW_START / 60) * PX_PER_HOUR, height: PX_PER_HOUR }}
            >
              <span>{String(h).padStart(2, "0")}:00</span>
            </div>
          ))}
          {day === todayYmd() && nowMinute > WINDOW_START && nowMinute < WINDOW_END ? (
            <div className="now-line" style={{ top: TOP + ((nowMinute - WINDOW_START) / 60) * PX_PER_HOUR }}>
              <span>{formatClock(nowMinute)}</span>
            </div>
          ) : null}
          {blocks.map((block) => {
            const top = TOP + ((Math.max(block.start, WINDOW_START) - WINDOW_START) / 60) * PX_PER_HOUR;
            const bottom = TOP + ((Math.min(block.end, WINDOW_END) - WINDOW_START) / 60) * PX_PER_HOUR;
            if (bottom <= TOP || top >= TOP + ((WINDOW_END - WINDOW_START) / 60) * PX_PER_HOUR) return null;
            const height = Math.max(14, bottom - top - 4);
            if (block.kind === "gap") {
              return (
                <div
                  key={`gap:${block.start}`}
                  className={`block gap${height < 34 ? " tight" : ""}`}
                  style={{ top, height }}
                  onClick={() =>
                    openDraft(draftForGap(day, block.start, block.end))
                  }
                  title="Lücke buchen"
                >
                  <div className="time">
                    {formatClock(block.start)}–{formatClock(block.end)} · {block.end - block.start} min offen
                  </div>
                </div>
              );
            }
            const s = block.support;
            return (
              <div
                key={`s:${s.id}`}
                className={`block${height < 34 ? " tight" : ""}`}
                style={{ top, height }}
                onClick={() => void edit(s)}
                title={`${s.text}\n\nKlick: ändern`}
              >
                <div className="time">
                  {formatClock(block.start)}–{formatClock(block.end)}
                  {s.ticketId ? (
                    <button
                      className="btn ghost small mono"
                      style={{ padding: "0 4px" }}
                      title="Ticket öffnen"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onOpen(s.ticketId);
                      }}
                    >
                      #{s.ticketId}
                    </button>
                  ) : null}
                  {s.companyName ? ` · ${s.companyName}` : ""}
                </div>
                <div className="label ellipsis">{s.text.split("\n")[0] || s.typeName}</div>
              </div>
            );
          })}
          {!loading && today.length === 0 ? (
            <div className="muted small" style={{ position: "absolute", left: 72, top: 16 }}>
              Keine Leistung an diesem Tag.
            </div>
          ) : null}
        </div>

        {outside.length ? (
          <div className="small muted">
            Außerhalb des Fensters:{" "}
            {outside.map((s) => `${formatClock(blocks.find((b) => b.kind === "support" && b.support.id === s.id)!.start)} (${s.duration} min)`).join(", ")}
          </div>
        ) : null}

      </div>

      <div className="times-right">
        <h2 style={{ fontSize: 15, marginBottom: 10 }}>Buchen · {day.split("-").reverse().join(".")}</h2>
        <div className="card" style={{ marginBottom: 14 }}>
          <BookingForm
            key={draftSeq}
            meta={props.meta}
            agentReady={props.agentReady}
            initial={draft}
            daySupports={today}
            onDone={() => {
              // A booked draft is done; the next one starts fresh below the
              // day that just grew.
              openDraft({ date: day });
              setVersion((v) => v + 1);
              props.onChanged();
            }}
            onError={onError}
            onToast={props.onToast}
          />
        </div>

        <div className="card pad" style={{ marginBottom: 14 }}>
          <div className="row" style={{ marginBottom: ideas ? 8 : 0 }}>
            <span className="viz-title">Was fehlt noch?</span>
            <button
              className="btn agent small"
              style={{ marginLeft: "auto" }}
              disabled={!props.agentReady || thinking}
              title={props.agentReady ? "Termine, Anrufe, Lücken, Bausteine und Wiederkehrendes des Tages prüfen" : "KI nicht eingerichtet (Einstellungen)"}
              onClick={() => void askAssistant()}
            >
              {thinking ? (
                <>
                  <span className="dot xs agent pulse" /> denkt …
                </>
              ) : ideas ? (
                "erneut fragen"
              ) : (
                "Assistent fragen"
              )}
            </button>
          </div>
          {ideas ? (
            ideas.length === 0 ? (
              <div className="small muted pretty">{note || "Der Assistent sieht nichts, was fehlt."}</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {ideas.map((idea, i) => (
                  <div key={i} className={`idea${idea.documented ? "" : " guess"}`}>
                    <div className="row" style={{ gap: 6 }}>
                      <span className={`dot xs ${idea.documented ? "ok" : "flat"}`} />
                      <span className="small ellipsis" style={{ flex: 1 }}>{idea.text}</span>
                      <span className="mono tiny muted">{idea.minutes} min</span>
                      <button
                        className="btn ghost small"
                        onClick={() => openDraft(draftFromIdea(day, idea))}
                      >
                        übernehmen
                      </button>
                    </div>
                    <div className="tiny muted pretty" style={{ marginTop: 2 }}>
                      {idea.evidence || "ohne Angabe"}
                      {idea.documented ? "" : " · ohne Beleg"}
                      {idea.company ? ` · ${idea.company}` : ""}
                    </div>
                  </div>
                ))}
                {note ? <div className="tiny muted pretty">{note}</div> : null}
                <div className="tiny muted pretty">
                  Jeder Vorschlag ist ein Entwurf. Kunde und Ticket wählst du selbst — der Assistent
                  kennt nur Namen, keine Nummern, und soll sich nicht an den falschen Kunden hängen.
                </div>
              </div>
            )
          ) : (
            <div className="tiny muted pretty">
              Ein Aufruf über den ganzen Tag: gebuchte Zeit, offene Termine und Anrufe, Lücken,
              Bausteine und was an diesem Wochentag wiederkehrt.
            </div>
          )}
        </div>

        {gaps.length ? (
          <>
            <h2 style={{ fontSize: 15, margin: "18px 0 4px" }}>Offene Zeit</h2>
            <p className="tiny muted pretty" style={{ marginBottom: 8 }}>
              Zeiten ohne Leistung in TANSS. „Vorschlag" fragt den Assistenten nur zu dieser Lücke,
              „Spuren" sucht in eigenen Kommentaren und Änderungen des Tages.
            </p>
            <div>
              {gaps.map((gap) => {
                const fitting = routinesForGap(routines, gap.end - gap.start);
                return (
                  <div key={gap.start}>
                    <div className="gap-line">
                      <span className="mono">
                        {formatClock(gap.start)}–{formatClock(gap.end)}
                      </span>
                      <span className="muted">{gap.end - gap.start} min</span>
                      <button
                        className="btn ghost small"
                        style={{ marginLeft: "auto" }}
                        onClick={() => openDraft(draftForGap(day, gap.start, gap.end))}
                      >
                        buchen
                      </button>
                      <button
                        className="btn ghost small"
                        disabled={!props.agentReady || thinking}
                        title="Den Assistenten nur zu dieser Lücke fragen"
                        onClick={() => void askAssistant({ start: gap.start, end: gap.end })}
                      >
                        Vorschlag
                      </button>
                    </div>
                    {fitting.length ? (
                      <div className="row" style={{ gap: 5, flexWrap: "wrap", padding: "4px 10px 6px" }}>
                        <span className="tiny muted">Baustein:</span>
                        {fitting.map((r) => {
                          const minutes = durationForGap(r, gap.end - gap.start)!;
                          return (
                            <button
                              key={r.id}
                              className="btn ghost small"
                              title={`${r.text} · ${r.minMinutes}–${r.maxMinutes} min`}
                              onClick={() => openDraft(draftFromRoutine(day, r, gap.start, minutes))}
                            >
                              {r.text.slice(0, 24)} · {minutes} min
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
