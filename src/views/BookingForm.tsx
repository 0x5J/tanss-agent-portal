import { useEffect, useRef, useState } from "react";
import { api, type Booking, type Meta } from "../api.ts";
import { SNAP_MINUTES, clampStart, findClashes, formatClock, type Support } from "../../shared/timeline.ts";
import { berlinMinuteOfDay } from "../../shared/days.ts";
import { formatHm, parseDuration } from "../../shared/duration.ts";
import { MAX_EXAMPLES } from "../../shared/style.ts";
import { findTargets, type Target } from "../targets.ts";
import type { BookingDraft } from "../../shared/draft.ts";
import { CheckBox, Icon, SPARK_SMALL } from "../ui/kit.tsx";
import "../styles/times.css";

/** The form is filled from a draft; the rules live in shared/draft.ts. */
export type BookingInitial = BookingDraft;

type Props = {
  meta: Meta | null;
  initial: BookingInitial;
  /** One line inside the ticket table instead of the full panel. */
  compact?: boolean;
  onDone: () => void;
  onError: (error: unknown) => void;
  onToast: (text: string) => void;
  /** Lets "Entwurf" ask the agent for the activity text of the chosen ticket. */
  agentReady?: boolean;
  /** The day's bookings — for the overlap hint. */
  daySupports?: Support[];
  /** A card floating over the day timeline: title row with time span and a close button. */
  floating?: boolean;
  /** Closes the floating card without booking. */
  onCancel?: () => void;
  /** Reports start and length while they are edited, so the timeline selection follows. */
  onRange?: (startMinute: number | null, minutes: number | null) => void;
};

export function BookingForm(props: Props) {
  const { initial } = props;
  const [start, setStart] = useState(formatClock(initial.startMinute ?? 9 * 60));
  const [duration, setDuration] = useState(formatHm(initial.duration ?? 30));
  const [typeId, setTypeId] = useState(initial.typeId ?? 0);
  const [location, setLocation] = useState<Booking["location"]>(initial.location ?? "OFFICE");
  const [text, setText] = useState(initial.text ?? "");
  const [target, setTarget] = useState<Target | null>(
    initial.ticketId
      ? {
          kind: "ticket",
          id: initial.ticketId,
          label: initial.ticketLabel || `#${initial.ticketId} ${initial.ticketTitle ?? ""}`.trim(),
        }
      : initial.companyId
        ? { kind: "company", id: initial.companyId, label: initial.companyName ?? `Kunde ${initial.companyId}` }
        : null,
  );
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<Target[]>([]);
  const [internal, setInternal] = useState(false);
  const [notCharged, setNotCharged] = useState("");
  const [notChargedReason, setNotChargedReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const types = props.meta?.supportTypes ?? [];
  const minutes = parseDuration(duration);
  const notChargedMinutes = Math.max(0, Math.round(Number(notCharged)) || 0);
  const notChargedOk = notCharged.trim() === "" || (notChargedMinutes >= 0 && notChargedMinutes <= (minutes ?? 0));
  const startMinute = parseStart();
  const clashes =
    startMinute !== null && minutes
      ? findClashes(startMinute, minutes, props.daySupports ?? [], initial.supportId ?? 0)
      : [];
  const complete = startMinute !== null && Boolean(minutes) && Boolean(target) && Boolean(typeId) && Boolean(text.trim()) && notChargedOk;

  // The callback is read through a ref, so a parent passing a fresh function
  // each render does not re-fire the report.
  const onRange = useRef(props.onRange);
  onRange.current = props.onRange;
  useEffect(() => {
    onRange.current?.(startMinute, minutes);
  }, [startMinute, minutes]);

  /** Take this text over as one of the three style examples. */
  async function keepAsExample() {
    try {
      const current = (await api.style()).style;
      const value = text.trim();
      if (current.examples.some((e) => e.trim() === value)) {
        return props.onToast("Steht schon in den Beispielen");
      }
      // Three is the cap; the oldest makes room for the newest.
      const examples = [...current.examples, value].slice(-MAX_EXAMPLES);
      await api.saveStyle({ ...current, examples });
      props.onToast(`Als Musterbeispiel gemerkt (${examples.length} von ${MAX_EXAMPLES})`);
    } catch (error) {
      props.onError(error);
    }
  }

  async function draftText() {
    if (!target || target.kind !== "ticket") return;
    setDrafting(true);
    try {
      const result = await api.agent.draft({ ticketIds: [target.id], intent: "support", instruction: "", internal: true });
      setText(result.text);
    } catch (error) {
      props.onError(error);
    } finally {
      setDrafting(false);
    }
  }

  useEffect(() => {
    if (!typeId && types.length) setTypeId(types[0].id);
  }, [types, typeId]);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const handle = window.setTimeout(() => {
      void findTargets(q).then(setHits).catch(() => setHits([]));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [search]);

  /** ←/→ move the start by a quarter hour, with Shift by an hour. */
  function nudgeStart(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const current = parseStart();
    if (current === null) return;
    event.preventDefault();
    const step = (event.shiftKey ? 60 : SNAP_MINUTES) * (event.key === "ArrowRight" ? 1 : -1);
    setStart(formatClock(clampStart(current + step, minutes ?? 30)));
  }

  function parseStart(): number | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(start.trim());
    if (!match) return null;
    const minute = Number(match[1]) * 60 + Number(match[2]);
    return minute >= 0 && minute < 24 * 60 ? minute : null;
  }

  async function submit() {
    const startMinute = parseStart();
    const minutes = parseDuration(duration);
  const notChargedMinutes = Math.max(0, Math.round(Number(notCharged)) || 0);
  const notChargedOk = notCharged.trim() === "" || (notChargedMinutes >= 0 && notChargedMinutes <= (minutes ?? 0));
    if (startMinute === null) return props.onToast("Beginn als HH:MM angeben");
    if (minutes === null || minutes <= 0) return props.onToast("Dauer angeben — z. B. 90, 1:30 oder 1,5h");
    if (!target) return props.onToast("Ticket oder Kunde wählen");
    if (!typeId) return props.onToast("Leistungstyp fehlt");
    if (!text.trim()) return props.onToast("Tätigkeitstext fehlt");
    if (!notChargedOk) return props.onToast("Nicht berechnete Zeit ist länger als die Leistung");
    setSaving(true);
    try {
      const payload = {
        date: initial.date,
        startMinute,
        duration: minutes,
        ticketId: target.kind === "ticket" ? target.id : undefined,
        companyId: target.kind === "company" ? target.id : undefined,
        typeId,
        location,
        text: text.trim(),
        internal,
        ...(initial.fromTemplate ? { fromTemplate: initial.fromTemplate } : {}),
        ...(notChargedMinutes > 0
          ? { durationNotCharged: notChargedMinutes, reasonNotChargedText: notChargedReason.trim() }
          : {}),
      };
      if (initial.supportId) {
        await api.editSupport(initial.supportId, payload);
        props.onToast(`Leistung geändert · ${minutes} min · ${target.label.slice(0, 40)}`);
      } else {
        await api.book(payload);
        props.onToast(`Leistung gebucht · ${minutes} min · ${target.label.slice(0, 40)}`);
        setText("");
      }
      props.onDone();
    } catch (error) {
      props.onError(error);
    } finally {
      setSaving(false);
    }
  }

  const targetPicker = (
    <div className="field full">
      <label>Zuweisung</label>
      {target ? (
        <div className="row" style={{ minWidth: 0 }}>
          <span className="chip agent ellipsis bf-target" title={target.label}>
            {target.label}
          </span>
          {!initial.ticketId ? (
            <button className="linkish small" onClick={() => setTarget(null)}>
              ändern
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <input
            className="input"
            value={search}
            autoFocus={props.floating && !initial.supportId}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Ticketnummer, Betreff oder Kunde suchen …"
          />
          {hits.length ? (
            <div className="bf-hits">
              {hits.map((hit) => (
                <button
                  key={`${hit.kind}:${hit.id}`}
                  className="bf-hit"
                  onClick={() => {
                    setTarget(hit);
                    setSearch("");
                  }}
                >
                  <span className="bf-kind">{hit.kind === "ticket" ? "TICKET" : "KUNDE"}</span>
                  <span className="ellipsis">{hit.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );

  const dateLabel = initial.date.split("-").reverse().join(".");
  const endMinute = startMinute !== null && minutes ? startMinute + minutes : null;

  return (
    <div className={`booking-form${props.compact ? " compact" : ""}${props.floating ? " floating" : ""}`}>
      {props.floating ? (
        <div className="bf-head full">
          <span className="bf-title">{initial.supportId ? "Leistung ändern" : "Leistung buchen"}</span>
          <span className="muted mono">
            {startMinute !== null ? formatClock(startMinute) : "--:--"}–{endMinute !== null ? formatClock(endMinute % (24 * 60)) : "--:--"}
          </span>
          <button className="bf-close" onClick={props.onCancel} title="Abbrechen (Esc)" aria-label="Abbrechen">
            <Icon d="M18 6 6 18M6 6l12 12" size={14} stroke={2} />
          </button>
        </div>
      ) : null}
      <div className="field">
        <label>Beginn</label>
        <input
          className="input mono"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          onKeyDown={nudgeStart}
          placeholder="09:00"
          title="←/→ verschiebt um 15 Minuten, mit Shift um eine Stunde"
        />
      </div>
      <div className="field">
        <label className="bf-label-row">
          <span>Dauer</span>
          <span className="bf-label-hint">{minutes ? `= ${minutes} min` : "90 · 1:30 · 1,5h"}</span>
        </label>
        <input
          className={`input mono${duration.trim() && minutes === null ? " bad" : ""}`}
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          onBlur={() => (minutes ? setDuration(formatHm(minutes)) : undefined)}
          placeholder="1:30"
          title="90, 1:30, 1,5h oder 45min"
        />
      </div>
      <div className="field">
        <label>Typ</label>
        <select className="select" value={typeId} onChange={(e) => setTypeId(Number(e.target.value))}>
          {types.length === 0 ? <option value={0}>— keine Typen —</option> : null}
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Ort</label>
        <select className="select" value={location} onChange={(e) => setLocation(e.target.value as Booking["location"])}>
          <option value="OFFICE">Büro</option>
          <option value="REMOTE">Remote</option>
          <option value="CUSTOMER">Beim Kunden</option>
        </select>
      </div>
      {props.compact && initial.ticketId ? null : targetPicker}
      <div className="field full">
        <div className="row">
          <label>Tätigkeitstext</label>
          {props.agentReady && target?.kind === "ticket" ? (
            <button
              className="btn small bf-draft"
              style={{ marginLeft: "auto" }}
              disabled={drafting}
              title="Tätigkeitstext aus dem Ticketverlauf entwerfen"
              onClick={() => void draftText()}
            >
              <Icon d={SPARK_SMALL} size={12} />
              {drafting ? "entwirft …" : "Aus dem Verlauf entwerfen"}
            </button>
          ) : null}
        </div>
        <textarea className="textarea" rows={props.compact || props.floating ? 2 : 4} value={text} onChange={(e) => setText(e.target.value)} />
        {initial.supportId && text.trim() ? (
          <button
            className="btn ghost small"
            style={{ alignSelf: "flex-start" }}
            title="Diesen Text als Musterbeispiel für erzeugte Leistungstexte merken"
            onClick={() => void keepAsExample()}
          >
            als Beispiel
          </button>
        ) : null}
      </div>
      <div className="row full bf-options">
        <button
          type="button"
          className="bf-check"
          role="checkbox"
          aria-checked={internal}
          onClick={() => setInternal(!internal)}
        >
          <CheckBox on={internal} size={11} />
          intern
        </button>
        <label className="row muted" style={{ gap: 8 }}>
          davon nicht berechnet
          <input
            className={`input mono bf-nc${notChargedOk ? "" : " bad"}`}
            value={notCharged}
            onChange={(e) => setNotCharged(e.target.value)}
            placeholder="0"
          />
          min
        </label>
        {notChargedMinutes > 0 ? (
          <input
            className="input"
            value={notChargedReason}
            onChange={(e) => setNotChargedReason(e.target.value)}
            placeholder="Grund (steht in TANSS)"
            style={{ flex: "1 1 160px", width: "auto", minWidth: 0 }}
          />
        ) : null}
      </div>
      {clashes.length ? (
        <div className="full bf-clash">
          <span className="dot warn" />
          <span className="pretty">
            Überschneidet sich mit{" "}
            {clashes
              .map((c) => `${formatClock(berlinMinuteOfDay(c.date))} ${c.ticketId ? `#${c.ticketId}` : c.companyName}`)
              .join(", ")}
            . Wird trotzdem gebucht — paralleles Arbeiten wird parallel gebucht.
          </span>
        </div>
      ) : null}
      {initial.lockText ? (
        <div className="full bf-lock">
          <span className="dot warn" />
          <span>{initial.lockText} Änderungen sind nicht mehr möglich.</span>
        </div>
      ) : null}
      <div className="row full bf-foot">
        <span
          className="tiny muted"
          title={`${initial.supportId ? `PUT /supports/${initial.supportId}` : "POST /supports"} · Zuweisung ${
            target ? (target.kind === "ticket" ? "Ticket (11)" : "Kunde (2)") : "fehlt"
          }`}
        >
          {dateLabel} · Zuweisung {target ? (target.kind === "ticket" ? "Ticket" : "Kunde") : "fehlt"}
        </span>
        <button
          className={`btn primary bf-book${complete ? "" : " dim"}`}
          style={{ marginLeft: "auto" }}
          disabled={saving || Boolean(initial.lockText)}
          onClick={submit}
        >
          {saving ? (initial.supportId ? "Speichert …" : "Bucht …") : initial.supportId ? "Speichern" : "Buchen"}
        </button>
      </div>
    </div>
  );
}
