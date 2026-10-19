import { useEffect, useState } from "react";
import { api, type Booking, type Meta } from "../api.ts";
import { SNAP_MINUTES, clampStart, findClashes, formatClock, type Support } from "../../shared/timeline.ts";
import { berlinMinuteOfDay } from "../../shared/days.ts";
import { formatHm, parseDuration } from "../../shared/duration.ts";
import { MAX_EXAMPLES } from "../../shared/style.ts";
import { findTargets, type Target } from "../targets.ts";
import type { BookingDraft } from "../../shared/draft.ts";

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
        <div className="row">
          <span className="chip agent ellipsis" style={{ maxWidth: 360 }}>
            {target.label}
          </span>
          {!initial.ticketId ? (
            <button className="btn ghost small" onClick={() => setTarget(null)}>
              ändern
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <input
            className="input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Ticketnummer, Betreff oder Kunde suchen …"
          />
          {hits.length ? (
            <div className="card" style={{ maxHeight: 180, overflow: "auto" }}>
              {hits.map((hit) => (
                <button
                  key={`${hit.kind}:${hit.id}`}
                  className="palette-item"
                  onClick={() => {
                    setTarget(hit);
                    setSearch("");
                  }}
                >
                  <span className="badge" style={{ flex: "none" }}>
                    {hit.kind === "ticket" ? "TICKET" : "KUNDE"}
                  </span>
                  <span className="ellipsis">{hit.label}</span>
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );

  return (
    <div className={`booking-form${props.compact ? " compact" : ""}`}>
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
        <label>Dauer</label>
        <input
          className="input mono"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          onBlur={() => (minutes ? setDuration(formatHm(minutes)) : undefined)}
          placeholder="1:30"
          style={{ borderColor: duration.trim() && minutes === null ? "var(--danger)" : undefined }}
          title="90, 1:30, 1,5h oder 45min"
        />
        <span className="tiny muted">{minutes ? `${minutes} min` : "90 · 1:30 · 1,5h · 45min"}</span>
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
              className="btn agent small"
              style={{ marginLeft: "auto" }}
              disabled={drafting}
              title="Tätigkeitstext aus dem Ticketverlauf entwerfen"
              onClick={() => void draftText()}
            >
              {drafting ? (
                <>
                  <span className="dot xs agent pulse" /> entwirft …
                </>
              ) : (
                "Aus dem Verlauf entwerfen"
              )}
            </button>
          ) : null}
        </div>
        <textarea className="textarea" rows={props.compact ? 2 : 4} value={text} onChange={(e) => setText(e.target.value)} />
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
      <div className="row full" style={{ gap: 12, flexWrap: "wrap" }}>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
          intern
        </label>
        <label className="row small muted" style={{ gap: 6 }}>
          davon nicht berechnet
          <input
            className="input mono"
            value={notCharged}
            onChange={(e) => setNotCharged(e.target.value)}
            placeholder="0"
            style={{ width: 70, borderColor: notChargedOk ? undefined : "var(--danger)" }}
          />
          min
        </label>
        {notChargedMinutes > 0 ? (
          <input
            className="input"
            value={notChargedReason}
            onChange={(e) => setNotChargedReason(e.target.value)}
            placeholder="Grund (steht in TANSS)"
            style={{ flex: 1, minWidth: 160 }}
          />
        ) : null}
      </div>
      {clashes.length ? (
        <div className="row full tiny muted" style={{ gap: 6 }}>
          <span className="dot xs warn" />
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
        <div className="row full banner" style={{ borderRadius: 6, marginBottom: 0 }}>
          <span className="dot sm warn" />
          <span className="small">{initial.lockText} Änderungen sind nicht mehr möglich.</span>
        </div>
      ) : null}
      <div className="row full">
        <span className="tiny muted">
          {initial.date} ·{" "}
          {initial.supportId ? `PUT /supports/${initial.supportId}` : "POST /supports"} · Zuweisung{" "}
          {target ? (target.kind === "ticket" ? "Ticket (11)" : "Kunde (2)") : "fehlt"}
        </span>
        <button
          className="btn primary"
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
