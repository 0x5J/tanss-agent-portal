import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type Meta } from "../api.ts";
import { berlinMinuteOfDay, formatLongDate, shiftYmd } from "../../shared/days.ts";
import {
  DAY_TARGET,
  SNAP_MINUTES,
  WEEK_TARGET,
  WINDOW_END,
  WINDOW_START,
  buildBlocks,
  formatClock,
  formatHours,
  nextFreeStart,
  snapMinute,
  sumMinutes,
  supportsOfDay,
  type Support,
} from "../../shared/timeline.ts";
import { todayYmd } from "../format.ts";
import { BookingForm, type BookingInitial } from "./BookingForm.tsx";
import type { BookingTemplate } from "../../shared/template.ts";
import { durationForGap, routinesForGap, type Routine } from "../../shared/routines.ts";
import type { BookingIdea, EvidenceKind } from "../../shared/assistant.ts";
import {
  draftForGap,
  draftFromIdea,
  draftFromRoutine,
  draftFromSupport,
  draftFromTemplate,
} from "../../shared/draft.ts";
import { Icon, PageHeader, SPARK, SPARK_SMALL } from "../ui/kit.tsx";
import "../styles/times.css";

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

/** The day is drawn at a fixed 48 px per hour, as in the prototype; 07:00–19:00 fills ~600 px. */
const PX_PER_HOUR = 48;
const TOP = 12;
const PLOT_HEIGHT = TOP + ((WINDOW_END - WINDOW_START) / 60) * PX_PER_HOUR + 28;
/** A block shorter than this shows time and label on one line. */
const SHORT_PX = 44;
/** A click (no drag) in a gap up to this long takes the whole gap; in a longer one, half an hour. */
const WHOLE_GAP_MAX = 120;
const CLICK_MINUTES = 30;

const KIND_LABEL: Record<EvidenceKind, string> = {
  termin: "Termin",
  anruf: "Anruf",
  linear: "Linear",
  luecke: "Lücke",
  muster: "Muster",
  baustein: "Baustein",
};

/** The floating booking card: the draft it was opened with and the span it is anchored to. */
type FormState = { draft: BookingInitial; seq: number; lo: number; hi: number };

function y(minute: number): number {
  return TOP + ((minute - WINDOW_START) / 60) * PX_PER_HOUR;
}

export function TimesView(props: Props) {
  const [day, setDay] = useState(props.initialDay ?? todayYmd());
  const [supports, setSupports] = useState<Support[]>([]);
  const [templates, setTemplates] = useState<BookingTemplate[]>([]);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [ideas, setIdeas] = useState<BookingIdea[] | null>(null);
  const [ideaMinutes, setIdeaMinutes] = useState<Record<number, string>>({});
  const [dismissed, setDismissed] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const [thinking, setThinking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [form, setForm] = useState<FormState | null>(null);
  /** The range being dragged out, in minutes of the day. */
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const [formHeight, setFormHeight] = useState(480);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLDivElement | null>(null);
  /**
   * Bumped for every new draft. The form reads its fields into local state
   * when it mounts, so without a changing key a clicked gap, template or
   * suggestion would leave the old values standing.
   */
  const seq = useRef(0);
  const { onSubtitle, onError } = props;

  const today = supportsOfDay(supports, day);
  const blocks = useMemo(() => buildBlocks(today), [today]);
  const gaps = blocks.filter((b) => b.kind === "gap");
  const dayMinutes = sumMinutes(today);
  const weekMinutes = sumMinutes(supports);

  /** Opens the floating card for a draft, anchored at its time (or at the next free slot). */
  function openDraft(draft: BookingInitial) {
    const start = draft.startMinute ?? nextFreeStart(today);
    const length = draft.duration ?? CLICK_MINUTES;
    seq.current += 1;
    setSel(null);
    setForm({ draft: { ...draft, startMinute: start }, seq: seq.current, lo: start, hi: start + length });
  }

  function closeForm() {
    setForm(null);
    setSel(null);
  }

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
      setIdeaMinutes({});
      setDismissed([]);
      setNote(result.note);
    } catch (error) {
      props.onError(error);
    } finally {
      setThinking(false);
    }
  }

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
    setForm(null);
    setSel(null);
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

  // Escape drops the card or the selection being dragged.
  useEffect(() => {
    if (!form && !sel) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeForm();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [form, sel]);

  // The card is placed by its real height, so it can sit above a late selection.
  useLayoutEffect(() => {
    const el = formRef.current;
    if (!el) return;
    const update = () => setFormHeight(el.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [form?.seq]);

  // A freshly opened card scrolls into view when it landed below the fold.
  useEffect(() => {
    if (form) formRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [form?.seq]);

  /** Minute of the day under the pointer, snapped to the quarter hour and kept in the window. */
  function minuteAt(clientY: number): number {
    const rect = plotRef.current!.getBoundingClientRect();
    const minute = WINDOW_START + ((clientY - rect.top - TOP) / PX_PER_HOUR) * 60;
    return Math.max(WINDOW_START, Math.min(WINDOW_END, snapMinute(minute)));
  }

  function onPlotDown(event: React.MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || !plotRef.current) return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-block],[data-form]")) return;
    event.preventDefault();
    const gapEl = target.closest<HTMLElement>("[data-gap]");
    const gap = gapEl ? { start: Number(gapEl.dataset.start), end: Number(gapEl.dataset.end) } : null;
    const a = Math.min(minuteAt(event.clientY), WINDOW_END - SNAP_MINUTES);
    let b = a + SNAP_MINUTES;
    let moved = false;
    setForm(null);
    setSel({ a, b });
    const move = (ev: MouseEvent) => {
      const next = minuteAt(ev.clientY);
      if (next !== a) moved = true;
      b = next === a ? a + SNAP_MINUTES : next;
      setSel({ a, b });
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", abort);
    };
    // Escape mid-drag drops the selection; the release then opens nothing.
    const abort = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      stop();
      setSel(null);
    };
    const up = () => {
      stop();
      let lo = Math.min(a, b);
      let hi = Math.max(a, b);
      if (!moved) {
        if (gap && gap.end - gap.start <= WHOLE_GAP_MAX) {
          lo = gap.start;
          hi = gap.end;
        } else {
          // Half an hour from the click, kept inside the gap it landed in.
          lo = gap ? Math.max(gap.start, Math.min(a, gap.end - CLICK_MINUTES)) : a;
          hi = Math.min(gap ? gap.end : WINDOW_END, lo + CLICK_MINUTES);
        }
      }
      openDraft(draftForGap(day, lo, hi));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("keydown", abort);
  }

  // Only meaningful for the current day; drawn as a thin red rule.
  const nowMinute = berlinMinuteOfDay(Math.floor(Date.now() / 1000));
  const outside = today.filter((s) => {
    const block = blocks.find((b) => b.kind === "support" && b.support.id === s.id);
    return block && (block.end <= WINDOW_START || block.start >= WINDOW_END);
  });
  const hours: number[] = [];
  for (let h = WINDOW_START / 60; h <= WINDOW_END / 60; h++) hours.push(h);

  // What the selection shows: the drag in progress, or the card's span.
  const range = sel ? { lo: Math.min(sel.a, sel.b), hi: Math.max(sel.a, sel.b) } : form ? { lo: form.lo, hi: form.hi } : null;
  const vis = (m: number) => Math.max(WINDOW_START, Math.min(WINDOW_END, m));
  const selTop = range ? y(vis(range.lo)) + 2 : 0;
  const selHeight = range ? Math.max(20, y(vis(range.hi)) - y(vis(range.lo)) - 4) : 0;
  // Above the selection when there is room (a little overlap at the very top is fine),
  // otherwise below it — then the timeline grows and the page scrolls, but the
  // selection the card belongs to stays visible.
  const formTop = (() => {
    if (!form) return 0;
    const above = selTop - formHeight - 10;
    if (above >= -40 && form.lo >= 12 * 60) return Math.max(0, above);
    return selTop + selHeight + 10;
  })();
  const plotHeight = form ? Math.max(PLOT_HEIGHT, formTop + formHeight + 8) : PLOT_HEIGHT;

  const visibleIdeas = (ideas ?? []).map((idea, index) => ({ idea, index })).filter((x) => !dismissed.includes(x.index));

  return (
    <div className="times-view">
      <PageHeader
        title="Zeiten"
        subtitle={`${formatLongDate(day)} · ${formatHours(dayMinutes)} gebucht · Soll ${formatHours(DAY_TARGET)} · Zum Buchen im Zeitstrahl ziehen`}
      >
        <button className="btn round" onClick={() => setDay(shiftYmd(day, -1))} aria-label="Vortag" title="Vortag">
          ←
        </button>
        <button className="btn" onClick={() => setDay(todayYmd())} disabled={day === todayYmd()}>
          Heute
        </button>
        <button className="btn round" onClick={() => setDay(shiftYmd(day, 1))} aria-label="Folgetag" title="Folgetag">
          →
        </button>
        <button
          className="btn primary lg"
          onClick={() => openDraft({ date: day, startMinute: nextFreeStart(today), duration: CLICK_MINUTES })}
        >
          Zeit erfassen
        </button>
      </PageHeader>

      <div className="times-meter">
        {loading ? (
          <span className="row" style={{ gap: 6 }}>
            <span className="dot xs pulse" /> lädt aus TANSS
          </span>
        ) : (
          <>
            <span className="meter" title={`${formatHours(dayMinutes)} von ${formatHours(DAY_TARGET)} gebucht`}>
              <i style={{ width: `${Math.min(100, (dayMinutes / DAY_TARGET) * 100)}%` }} />
            </span>
            <span>
              Tag <b>{formatHours(dayMinutes)}</b> von {formatHours(DAY_TARGET)}
            </span>
            <span>
              Woche <b>{formatHours(weekMinutes)}</b> von {formatHours(WEEK_TARGET)}
            </span>
          </>
        )}
      </div>

      <div className="times-layout">
        <div className="tl" ref={plotRef} style={{ height: plotHeight }} onMouseDown={onPlotDown}>
          {hours.map((h) => (
            <div key={h} className="tl-hour" style={{ top: y(h * 60) }}>
              <span>{String(h).padStart(2, "0")}:00</span>
            </div>
          ))}
          {day === todayYmd() && nowMinute > WINDOW_START && nowMinute < WINDOW_END ? (
            <div className="tl-now" style={{ top: y(nowMinute) }}>
              <span>{formatClock(nowMinute)}</span>
            </div>
          ) : null}
          {blocks.map((block) => {
            const top = y(Math.max(block.start, WINDOW_START)) + 2;
            const bottom = y(Math.min(block.end, WINDOW_END)) - 2;
            if (bottom <= TOP || top >= y(WINDOW_END)) return null;
            const height = Math.max(14, bottom - top);
            const short = height < SHORT_PX;
            if (block.kind === "gap") {
              const length = block.end - block.start;
              return (
                <div
                  key={`gap:${block.start}`}
                  data-gap="1"
                  data-start={block.start}
                  data-end={block.end}
                  className={`tl-gap${short ? " short" : ""}`}
                  style={{ top, height }}
                  title={
                    length <= WHOLE_GAP_MAX
                      ? `Klick bucht die Lücke ${formatClock(block.start)}–${formatClock(block.end)}, Ziehen einen Ausschnitt`
                      : "Klick bucht eine halbe Stunde, Ziehen einen beliebigen Ausschnitt"
                  }
                >
                  {height >= 18 ? `${formatClock(block.start)}–${formatClock(block.end)} · ${length} min offen` : null}
                </div>
              );
            }
            const s = block.support;
            return (
              <div
                key={`s:${s.id}`}
                data-block="1"
                className={`tl-block${short ? " short" : ""}`}
                style={{ top, height }}
                onClick={() => void edit(s)}
                title={`${s.text}\n\nKlick: ändern`}
              >
                <span className="t">
                  {formatClock(block.start)}–{formatClock(block.end)}
                  {s.ticketId ? (
                    <>
                      {" · "}
                      <button
                        className="tk"
                        title="Ticket öffnen"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onOpen(s.ticketId);
                        }}
                      >
                        #{s.ticketId}
                      </button>
                    </>
                  ) : null}
                  {s.companyName && !short ? ` · ${s.companyName}` : ""}
                </span>
                <span className="l">{s.text.split("\n")[0] || s.typeName}</span>
              </div>
            );
          })}
          {range ? (
            <div
              className={`tl-sel${selHeight < SHORT_PX ? " short" : ""}`}
              style={{ top: selTop, height: selHeight }}
            >
              <span className="t">
                {formatClock(range.lo)}–{formatClock(range.hi % (24 * 60))}
              </span>
              <span className="d">{range.hi - range.lo} min</span>
            </div>
          ) : null}
          {!loading && today.length === 0 && !range ? (
            <div className="tl-empty">Keine Leistung an diesem Tag. Zum Buchen ziehen.</div>
          ) : null}
          {form ? (
            <div
              ref={formRef}
              data-form="1"
              className="tl-form"
              style={{ top: formTop }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <BookingForm
                key={form.seq}
                meta={props.meta}
                agentReady={props.agentReady}
                initial={form.draft}
                daySupports={today}
                floating
                onCancel={closeForm}
                onRange={(start, minutes) => {
                  if (start === null || !minutes) return;
                  setForm((f) => (f && (f.lo !== start || f.hi !== start + minutes) ? { ...f, lo: start, hi: start + minutes } : f));
                }}
                onDone={() => {
                  closeForm();
                  setVersion((v) => v + 1);
                  props.onChanged();
                }}
                onError={onError}
                onToast={props.onToast}
              />
            </div>
          ) : null}
        </div>

        <aside className="times-aside">
          <div className="aside-head">
            <Icon d={SPARK} size={18} />
            <h2>Vom Agenten vorgeschlagen</h2>
          </div>

          {thinking ? (
            <div className="sugg-empty">
              <span className="row" style={{ gap: 8 }}>
                <span className="dot xs pulse" /> Der Assistent sieht sich den Tag an …
              </span>
            </div>
          ) : ideas === null ? (
            <div className="sugg-empty">
              <span className="pretty">
                Ein Aufruf über den ganzen Tag: gebuchte Zeit, offene Termine und Anrufe, Lücken, Bausteine und was an
                diesem Wochentag wiederkehrt.
              </span>
              <button
                className="btn primary"
                disabled={!props.agentReady}
                title={
                  props.agentReady
                    ? "Termine, Anrufe, Lücken, Bausteine und Wiederkehrendes des Tages prüfen"
                    : "KI nicht eingerichtet (Einstellungen)"
                }
                onClick={() => void askAssistant()}
              >
                <Icon d={SPARK_SMALL} size={14} />
                Assistent fragen
              </button>
            </div>
          ) : visibleIdeas.length === 0 ? (
            <div className="sugg-empty">
              {ideas.length
                ? "Alle Vorschläge bearbeitet."
                : note || "Der Assistent sieht nichts, was fehlt."}
            </div>
          ) : (
            visibleIdeas.map(({ idea, index }) => {
              const raw = ideaMinutes[index] ?? String(idea.minutes);
              const minutes = Math.max(0, Math.round(Number(raw)) || 0);
              return (
                <div key={index} className="sugg">
                  <div className="sugg-top">
                    <span className="kind">{KIND_LABEL[idea.kind] ?? idea.kind}</span>
                    {idea.company ? <span className="ellipsis">{idea.company}</span> : null}
                    <span>{idea.documented ? "belegt" : "ohne Beleg"}</span>
                    <span className="span">
                      {idea.startMinute !== null
                        ? `${formatClock(idea.startMinute)}–${formatClock(idea.startMinute + idea.minutes)}`
                        : "ohne Uhrzeit"}
                    </span>
                  </div>
                  <div className="sugg-text">{idea.text}</div>
                  <div className="sugg-actions">
                    <span className="sugg-min">
                      <input
                        value={raw}
                        inputMode="numeric"
                        aria-label="Minuten"
                        onChange={(e) => setIdeaMinutes({ ...ideaMinutes, [index]: e.target.value })}
                      />
                      <span>min</span>
                    </span>
                    <span className="buttons">
                      <button className="btn" onClick={() => setDismissed([...dismissed, index])}>
                        Verwerfen
                      </button>
                      <button
                        className="btn primary"
                        disabled={!minutes}
                        onClick={() => openDraft(draftFromIdea(day, { ...idea, minutes }))}
                      >
                        Buchen
                      </button>
                    </span>
                  </div>
                  <span className="sugg-evidence">{idea.evidence || "ohne Angabe"}</span>
                </div>
              );
            })
          )}
          {ideas && ideas.length ? (
            <>
              {note && visibleIdeas.length ? <p className="sugg-note">{note}</p> : null}
              <p className="sugg-note">
                Jeder Vorschlag ist ein Entwurf. Kunde und Ticket wählst du selbst — der Assistent kennt nur Namen,
                keine Nummern, und soll sich nicht an den falschen Kunden hängen.
              </p>
            </>
          ) : null}
          {ideas && !thinking ? (
            <button
              className="btn"
              style={{ alignSelf: "flex-start" }}
              disabled={!props.agentReady}
              onClick={() => void askAssistant()}
            >
              <Icon d={SPARK_SMALL} size={14} />
              Erneut fragen
            </button>
          ) : null}

          {templates.length ? (
            <>
              <h3>Termine und Anrufe</h3>
              <span className="sugg-note">Was TANSS kennt — noch nicht gebucht und in keiner Summe.</span>
              <div className="aside-list">
                {templates.map((t) => (
                  <button
                    key={t.key}
                    className="aside-row"
                    title={`${t.title}${t.detail ? ` · ${t.detail}` : ""} · ${t.duration} min`}
                    onClick={() => openDraft(draftFromTemplate(day, t))}
                  >
                    <span className={`dot xs ${t.kind === "call" ? "flat" : "ok"}`} />
                    <span className="c">{formatClock(t.startMinute)}</span>
                    <span className="l">{t.title}</span>
                    <span className="m">{t.kind === "call" ? "Anruf" : "Termin"} · {t.duration} min</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {gaps.length ? (
            <>
              <h3>Offene Zeit</h3>
              <span className="sugg-note">
                Zeiten ohne Leistung in TANSS. „Vorschlag" fragt den Assistenten nur zu dieser Lücke.
              </span>
              <div className="aside-list">
                {gaps.map((gap) => {
                  const fitting = routinesForGap(routines, gap.end - gap.start);
                  return (
                    <div key={gap.start} className="aside-gap">
                      <div className="row1">
                        <span className="c">
                          {formatClock(gap.start)}–{formatClock(gap.end)}
                        </span>
                        <span className="m">{gap.end - gap.start} min</span>
                        <span className="acts">
                          <button className="btn small" onClick={() => openDraft(draftForGap(day, gap.start, gap.end))}>
                            buchen
                          </button>
                          <button
                            className="btn small"
                            disabled={!props.agentReady || thinking}
                            title="Den Assistenten nur zu dieser Lücke fragen"
                            onClick={() => void askAssistant({ start: gap.start, end: gap.end })}
                          >
                            Vorschlag
                          </button>
                        </span>
                      </div>
                      {fitting.length ? (
                        <div className="routines">
                          <span>Baustein:</span>
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

          {outside.length ? (
            <div className="tl-outside">
              Außerhalb des Fensters:{" "}
              {outside
                .map(
                  (s) =>
                    `${formatClock(blocks.find((b) => b.kind === "support" && b.support.id === s.id)!.start)} (${s.duration} min)`,
                )
                .join(", ")}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
