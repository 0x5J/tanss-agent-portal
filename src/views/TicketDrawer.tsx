import { useEffect, useState } from "react";
import { api, type Meta, type TicketDetail } from "../api.ts";
import type { TicketRow } from "../../shared/tickets.ts";
import { formatHours, sumMinutes } from "../../shared/timeline.ts";
import { dayAndClock, fullDate, minutesLabel, nowUnix, todayYmd } from "../format.ts";
import { BookingForm } from "./BookingForm.tsx";
import { DraftButton } from "./DraftButton.tsx";
import { TicketAgentActions } from "./TicketAgentActions.tsx";
import { TicketWebhooks } from "./TicketWebhooks.tsx";
import { Dot, Icon, Segmented, SPARK_SMALL } from "../ui/kit.tsx";
import "../styles/drawer.css";

type Props = {
  ticketId: number;
  meta: Meta | null;
  ticketUrl: string;
  onClose: () => void;
  onError: (error: unknown) => void;
  onToast: (text: string) => void;
  onChanged: () => void;
  agentReady: boolean;
  /** The board's rows — candidates for "similar tickets". */
  boardRows: TicketRow[];
  onOpen: (id: number) => void;
};

const TABS = ["Verlauf", "Zeiten"] as const;

export function TicketDrawer(props: Props) {
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Verlauf");
  const [internal, setInternal] = useState(true);
  const [text, setText] = useState("");
  /** Heading of the posting; set by "Antwort entwerfen", editable, optional. */
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  /** Cleaned mail bodies by thread key; null while the original is shown. */
  const [cleaned, setCleaned] = useState<Record<string, string>>({});
  const [showOriginal, setShowOriginal] = useState<Record<string, boolean>>({});
  const [cleaning, setCleaning] = useState<string | null>(null);
  const [replying, setReplying] = useState<string | null>(null);
  const { ticketId, onError } = props;

  useEffect(() => {
    setTab("Verlauf");
    setText("");
    setTitle("");
    setCleaned({});
    setShowOriginal({});
  }, [ticketId]);

  async function cleanMail(key: string) {
    setCleaning(key);
    try {
      const result = await api.agent.cleanMail(ticketId, key);
      setCleaned((c) => ({ ...c, [key]: result.text }));
      setShowOriginal((o) => ({ ...o, [key]: false }));
    } catch (error) {
      onError(error);
    } finally {
      setCleaning(null);
    }
  }

  async function replyTo(key: string) {
    setReplying(key);
    try {
      const mail = detail?.thread.find((e) => e.key === key);
      const result = await api.agent.draft({ ticketIds: [ticketId], intent: "reply", instruction: "", internal: false, mailKey: key });
      // Saved as an internal note with a telling title: TANSS shows it as the
      // draft it is, ready to be copied into the mail there.
      setInternal(true);
      setTitle(`Mail-Entwurf: Antwort auf „${mail?.title || "Mail"}" an ${mail?.author || "Absender"}`);
      setText(result.text);
      props.onToast("Antwort als Entwurf im Notizfeld — speichern legt ihn als Mail-Entwurf ins Ticket");
      document.getElementById("drawer-reply")?.scrollIntoView({ block: "end", behavior: "smooth" });
    } catch (error) {
      onError(error);
    } finally {
      setReplying(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    api
      .ticket(ticketId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [ticketId, version, onError]);

  async function saveComment() {
    if (!text.trim()) return;
    setSaving(true);
    try {
      await api.comment(ticketId, text.trim(), internal, title.trim());
      props.onToast(internal ? "Interne Notiz gespeichert" : "Kommentar gespeichert");
      setText("");
      setTitle("");
      setVersion((v) => v + 1);
      props.onChanged();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  async function patch(patch: { statusId?: number; assignedToEmployeeId?: number; companyId?: number }, label: string) {
    try {
      await api.patchTicket(ticketId, patch);
      props.onToast(label);
      setVersion((v) => v + 1);
      props.onChanged();
    } catch (error) {
      onError(error);
    }
  }

  const ticket = detail?.ticket;
  const now = nowUnix();
  const due = ticket ? ticket.deadlineDate || ticket.dueDate : 0;
  const total = detail ? sumMinutes(detail.supports) : 0;
  const states = props.meta?.states ?? [];
  const technicians = props.meta?.technicians ?? [];
  const supports = detail ? [...detail.supports].sort((a, b) => a.date - b.date) : [];

  return (
    <>
      <div className="backdrop" onClick={props.onClose} />
      <section className="drawer td" role="dialog" aria-label={`Ticket #${ticketId}`}>
        <header className="td-head">
          <div className="td-meta">
            <span>TANSS</span>
            <span aria-hidden="true">·</span>
            <span className="mono">#{ticketId}</span>
            {ticket?.companyName ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="ellipsis">{ticket.companyName}</span>
              </>
            ) : null}
            {ticket?.projectName ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="ellipsis">{ticket.projectName}</span>
              </>
            ) : null}
            <span className="td-meta-actions">
              {props.ticketUrl ? (
                <a href={`${props.ticketUrl}${ticketId}`} target="_blank" rel="noreferrer">
                  In TANSS öffnen ↗
                </a>
              ) : null}
              <button className="td-close" onClick={props.onClose} title="Schließen (Esc)" aria-label="Schließen">
                <Icon d="M18 6 6 18M6 6l12 12" size={16} />
              </button>
            </span>
          </div>
          <h2 className="td-title">{ticket?.title ?? "lädt …"}</h2>
          {ticket ? (
            <div className="td-pills">
              <span className="td-pill">
                <Dot tone={statusTone(ticket)} />
                {ticket.statusName || "ohne Status"}
              </span>
              {ticket.typeName ? <span className="td-pill">{ticket.typeName}</span> : null}
              {ticket.isProject ? <span className="td-pill">Projekt</span> : null}
              {due ? <DuePill due={due} deadline={Boolean(ticket.deadlineDate)} now={now} /> : null}
              {ticket.assigneeId ? null : <span className="td-pill outline">nicht zugewiesen</span>}
            </div>
          ) : null}
          <div className="td-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`td-tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
                {t}
                {detail ? <span className="count">{t === "Zeiten" ? detail.supports.length : detail.thread.length}</span> : null}
              </button>
            ))}
          </div>
        </header>

        <div className="td-body">
          <div className="td-main">
            {!detail ? <p className="muted">Ticket wird geladen …</p> : null}

            {detail && tab === "Verlauf" ? (
              <>
                {ticket ? (
                  <TicketAgentActions
                    ticketId={ticketId}
                    ready={props.agentReady}
                    entries={detail.thread.length}
                    states={states}
                    boardRows={props.boardRows}
                    onSetStatus={(statusId, name) => void patch({ statusId }, `Status → ${name}`)}
                    onSetCompany={(companyId, name) => void patch({ companyId }, `Kunde → ${name}`)}
                    onOpen={props.onOpen}
                    onError={onError}
                  />
                ) : null}

                <div className="td-thread">
                  {detail.thread.map((entry) => (
                    <article key={entry.key} className="td-msg">
                      <div className="td-msg-head">
                        <span className="author">{entry.author}</span>
                        <span className={`td-kind${entry.kind === "Interne Notiz" ? " dark" : ""}`}>
                          {entry.kind}
                          {entry.kind === "Leistung" ? ` · ${minutesLabel(entry.duration)}` : ""}
                        </span>
                        <span className="ts">{dayAndClock(entry.at)}</span>
                      </div>
                      {entry.title && entry.kind !== "Beschreibung" ? <div className="td-subject">{entry.title}</div> : null}
                      {cleaned[entry.key] && !showOriginal[entry.key] ? (
                        <div className="td-short">
                          <div className="td-short-label">
                            <Icon d={SPARK_SMALL} size={12} />
                            <span>Kurzfassung vom Agenten</span>
                            <button className="linkish muted small" onClick={() => setShowOriginal((o) => ({ ...o, [entry.key]: true }))}>
                              Original zeigen
                            </button>
                          </div>
                          {cleaned[entry.key]}
                        </div>
                      ) : (
                        <p className="td-text">{entry.text}</p>
                      )}
                      {entry.kind.startsWith("Mail") && props.agentReady ? (
                        <div className="td-msg-actions">
                          {cleaned[entry.key] && showOriginal[entry.key] ? (
                            <button className="btn small" onClick={() => setShowOriginal((o) => ({ ...o, [entry.key]: false }))}>
                              Kurzfassung
                            </button>
                          ) : !cleaned[entry.key] && entry.text.length > 200 ? (
                            <button
                              className="btn small"
                              disabled={cleaning === entry.key}
                              onClick={() => void cleanMail(entry.key)}
                              title="Zitate, Signatur und Disclaimer entfernen, Inhalt in wenigen Zeilen"
                            >
                              {cleaning === entry.key ? "kürzt …" : "Kürzen"}
                            </button>
                          ) : null}
                          {entry.kind === "Mail eingehend" ? (
                            <button
                              className="btn small"
                              disabled={replying === entry.key}
                              onClick={() => void replyTo(entry.key)}
                              title="Antwort auf diese Mail als Kommentar-Entwurf"
                            >
                              <Icon d={SPARK_SMALL} size={12} />
                              {replying === entry.key ? "entwirft …" : "Antwort entwerfen"}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>

                <div className="td-reply" id="drawer-reply">
                  <Segmented
                    small
                    onSoft
                    label="Art des Eintrags"
                    options={[
                      { id: "note", label: "Interne Notiz" },
                      { id: "comment", label: "Kommentar" },
                    ]}
                    value={internal ? "note" : "comment"}
                    onChange={(id) => setInternal(id === "note")}
                  />
                  {title ? (
                    <div className="td-reply-title">
                      <span className="td-pill dark">Titel</span>
                      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Titel des Eintrags" />
                      <button className="td-insight-close" onClick={() => setTitle("")} title="Ohne Titel speichern" aria-label="Titel entfernen">
                        ×
                      </button>
                    </div>
                  ) : null}
                  <textarea
                    className="td-reply-text"
                    rows={5}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={internal ? "Interne Notiz – nur für Mitarbeiter sichtbar" : "Kommentar – wird im Ticket gespeichert"}
                  />
                  <div className="td-reply-foot">
                    <DraftButton
                      ticketIds={[ticketId]}
                      internal={internal}
                      ready={props.agentReady}
                      hasText={Boolean(text.trim())}
                      onDraft={setText}
                      onError={onError}
                    />
                    <span className="tiny muted pretty">
                      Geht als {internal ? "interner" : "öffentlicher"} Kommentar an POST /tickets/{ticketId}/comments
                    </span>
                    <button className="btn primary lg" style={{ marginLeft: "auto" }} disabled={saving || !text.trim()} onClick={saveComment}>
                      {saving ? "Speichert …" : internal ? "Notiz speichern" : "Kommentar speichern"}
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            {detail && tab === "Zeiten" ? (
              <>
                <div className="table td-times">
                  {supports.length === 0 ? <div className="td-times-row muted">Noch keine Leistung gebucht.</div> : null}
                  {supports.map((s) => (
                    <div key={s.id} className="td-times-row">
                      <span className="muted">{fullDate(s.date).slice(0, 6)}</span>
                      <span className="strong">{minutesLabel(s.duration)}</span>
                      <span className="ellipsis" title={s.text}>
                        {s.typeName ? <span className="muted">{s.typeName} · </span> : null}
                        {s.text.split("\n")[0]}
                      </span>
                    </div>
                  ))}
                  <div className="td-times-sum">
                    <span>Summe</span>
                    <span>{formatHours(total)}</span>
                  </div>
                </div>
                <div className="td-book">
                  <h3 className="h2" style={{ fontSize: 18, lineHeight: "24px" }}>Leistung buchen</h3>
                  <BookingForm
                    meta={props.meta}
                    agentReady={props.agentReady}
                    initial={{ date: todayYmd(), ticketId, ticketTitle: ticket?.title ?? "" }}
                    compact
                    onDone={() => {
                      setVersion((v) => v + 1);
                      props.onChanged();
                    }}
                    onError={onError}
                    onToast={props.onToast}
                  />
                </div>
              </>
            ) : null}
          </div>

          <aside className="td-side" aria-label="Eigenschaften">
            <div className="td-prop">
              <span className="k">Status</span>
              {states.length && ticket ? (
                <select
                  className="td-select"
                  value={ticket.statusId}
                  onChange={(e) => void patch({ statusId: Number(e.target.value) }, "Status geändert")}
                >
                  {!states.some((s) => s.id === ticket.statusId) ? (
                    <option value={ticket.statusId}>{ticket.statusName || `#${ticket.statusId}`}</option>
                  ) : null}
                  {states.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="v">{ticket?.statusName ?? "—"}</span>
              )}
            </div>
            <div className="td-prop">
              <span className="k">Zuständig</span>
              {ticket && technicians.length ? (
                <select
                  className="td-select"
                  value={ticket.assigneeId}
                  onChange={(e) => void patch({ assignedToEmployeeId: Number(e.target.value) }, "Zuweisung geändert")}
                >
                  <option value={0}>— niemand —</option>
                  {!technicians.some((t) => t.id === ticket.assigneeId) && ticket.assigneeId ? (
                    <option value={ticket.assigneeId}>{ticket.assigneeName}</option>
                  ) : null}
                  {technicians.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="v">{ticket?.assigneeName || "—"}</span>
              )}
              {ticket && props.meta && ticket.assigneeId !== props.meta.employeeId ? (
                <button
                  className="btn small"
                  style={{ alignSelf: "flex-start", marginTop: 6 }}
                  onClick={() => void patch({ assignedToEmployeeId: props.meta!.employeeId }, "Mir zugewiesen")}
                >
                  Mir zuweisen
                </button>
              ) : null}
            </div>
            <Prop k="Kunde" v={ticket?.companyName || "—"} />
            {ticket?.projectName ? <Prop k="Projekt" v={ticket.projectName} /> : null}
            <Prop k="Typ" v={ticket?.typeName || "—"} />
            <Prop k="Abteilung" v={ticket?.departmentName || "—"} />
            <Prop
              k={ticket?.deadlineDate ? "Deadline" : "Fällig"}
              v={due ? dayAndClock(due) : "—"}
              mono
              tone={due && due < now ? "danger" : undefined}
            />
            <Prop k="Erstellt" v={ticket ? dayAndClock(ticket.creationDate) : "—"} mono />
            <Prop k="Geändert" v={ticket ? dayAndClock(ticket.modified) : "—"} mono />
            <Prop k="Zeitsumme" v={formatHours(total)} mono />
            <TicketWebhooks key={ticketId} ticketId={ticketId} onError={onError} onToast={props.onToast} />
            {ticket?.estimatedMinutes ? <Prop k="Geschätzt" v={minutesLabel(ticket.estimatedMinutes)} mono /> : null}
          </aside>
        </div>
      </section>
    </>
  );
}

/** Waiting is the customer's turn (amber); "Neu …" has not been touched yet (grey). */
function statusTone(ticket: TicketRow): "warn" | "flat" | "ink" {
  if (ticket.waiting) return "warn";
  if (/^neu\b/i.test(ticket.statusName)) return "flat";
  return "ink";
}

/** The due date as the prototype's SLA pill: outlined red when overdue, amber within a day. */
function DuePill(props: { due: number; deadline: boolean; now: number }) {
  const left = props.due - props.now;
  const tone = left < 0 ? "danger" : left < 86400 ? "warn" : "";
  const label = props.deadline ? "Deadline" : "Fällig";
  return (
    <span className={`td-pill${tone ? ` outline ${tone}` : ""}`} title={dayAndClock(props.due)}>
      {left < 0 ? `${label} seit ${dayAndClock(props.due)}` : `${label} ${dayAndClock(props.due)}`}
    </span>
  );
}

function Prop(props: { k: string; v: string; mono?: boolean; tone?: "danger" }) {
  return (
    <div className="td-prop">
      <span className="k">{props.k}</span>
      <span className={`v ellipsis${props.mono ? " mono" : ""}`} style={props.tone === "danger" ? { color: "var(--red)" } : undefined}>
        {props.v}
      </span>
    </div>
  );
}
