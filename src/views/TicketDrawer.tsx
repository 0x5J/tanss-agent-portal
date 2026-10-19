import { useEffect, useState } from "react";
import { api, type Meta, type TicketDetail } from "../api.ts";
import type { ThreadEntry } from "../../shared/thread.ts";
import type { TicketRow } from "../../shared/tickets.ts";
import { formatHours, sumMinutes } from "../../shared/timeline.ts";
import { dayAndClock, fullDate, minutesLabel, nowUnix, todayYmd } from "../format.ts";
import { BookingForm } from "./BookingForm.tsx";
import { DraftButton } from "./DraftButton.tsx";
import { TicketAgentActions } from "./TicketAgentActions.tsx";

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

const TABS = ["Thread", "Zeiten"] as const;

function msgClass(entry: ThreadEntry): string {
  switch (entry.kind) {
    case "Interne Notiz":
      return "note";
    case "Mail eingehend":
      return "inbound";
    case "Beschreibung":
      return "description";
    case "Leistung":
      return "support";
    default:
      return "";
  }
}

export function TicketDrawer(props: Props) {
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Thread");
  const [internal, setInternal] = useState(true);
  const [text, setText] = useState("");
  /** Heading of the posting; set by "Antwort entwerfen", editable, optional. */
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  const [summary, setSummary] = useState<string | null>(null);
  const [summarising, setSummarising] = useState(false);
  /** Cleaned mail bodies by thread key; null while the original is shown. */
  const [cleaned, setCleaned] = useState<Record<string, string>>({});
  const [showOriginal, setShowOriginal] = useState<Record<string, boolean>>({});
  const [cleaning, setCleaning] = useState<string | null>(null);
  const [replying, setReplying] = useState<string | null>(null);
  const { ticketId, onError } = props;

  useEffect(() => {
    setSummary(null);
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

  async function summarise() {
    setSummarising(true);
    try {
      const result = await api.agent.summary(ticketId);
      setSummary(result.text);
    } catch (error) {
      onError(error);
    } finally {
      setSummarising(false);
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

  return (
    <>
      <div className="backdrop" onClick={props.onClose} />
      <section className="drawer" role="dialog" aria-label={`Ticket #${ticketId}`}>
        <header className="drawer-head">
          <span className="badge">TANSS</span>
          <span className="mono small muted">#{ticketId}</span>
          <span className="title ellipsis">{ticket?.title ?? "lädt …"}</span>
          {props.ticketUrl ? (
            <a
              className="btn muted"
              style={{ marginLeft: "auto" }}
              href={`${props.ticketUrl}${ticketId}`}
              target="_blank"
              rel="noreferrer"
            >
              In TANSS öffnen ↗
            </a>
          ) : null}
          <button className="btn muted" style={props.ticketUrl ? {} : { marginLeft: "auto" }} onClick={props.onClose}>
            Esc
          </button>
        </header>
        <div className="drawer-tabs">
          {TABS.map((t) => (
            <button key={t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
              {t}
              {t === "Zeiten" && detail ? <span className="count">{detail.supports.length}</span> : null}
            </button>
          ))}
        </div>

        <div className="drawer-body">
          <div className="drawer-main">
            {!detail ? <p className="muted">Ticket wird geladen …</p> : null}

            {detail && tab === "Thread" ? (
              <>
                {summary ? (
                  <div className="agent-box">
                    <div className="label">
                      <span>Stand der Dinge · Entwurf vom Agenten</span>
                      <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={() => setSummary(null)}>
                        ausblenden
                      </button>
                    </div>
                    {summary}
                  </div>
                ) : (
                  <div className="row" style={{ marginBottom: 10 }}>
                    <button
                      className="btn agent small"
                      disabled={summarising || !props.agentReady}
                      title={props.agentReady ? "Thread in fünf Zeilen zusammenfassen" : "KI nicht eingerichtet (Einstellungen)"}
                      onClick={() => void summarise()}
                    >
                      {summarising ? (
                        <>
                          <span className="dot xs agent pulse" /> fasst zusammen …
                        </>
                      ) : (
                        "Zusammenfassen"
                      )}
                    </button>
                    <span className="tiny muted">{detail.thread.length} Einträge</span>
                  </div>
                )}
                {detail.thread.map((entry) => (
                  <div key={entry.key} className={`msg ${msgClass(entry)}`}>
                    <div className="msg-head">
                      <span className="author">{entry.author}</span>
                      <span className="kind">
                        {entry.kind}
                        {entry.kind === "Leistung" ? ` · ${minutesLabel(entry.duration)}` : ""}
                      </span>
                      <span className="ts">{dayAndClock(entry.at)}</span>
                    </div>
                    {entry.title && entry.kind !== "Beschreibung" ? (
                      <div className="subject">{entry.title}</div>
                    ) : null}
                    {cleaned[entry.key] && !showOriginal[entry.key] ? (
                      <div className="agent-box" style={{ marginBottom: 6 }}>
                        <div className="label">
                          <span>Kurzfassung vom Agenten</span>
                          <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={() => setShowOriginal((o) => ({ ...o, [entry.key]: true }))}>
                            Original
                          </button>
                        </div>
                        {cleaned[entry.key]}
                      </div>
                    ) : (
                      <p>{entry.text}</p>
                    )}
                    {entry.kind.startsWith("Mail") && props.agentReady ? (
                      <div className="row" style={{ marginTop: 8, gap: 6 }}>
                        {cleaned[entry.key] && showOriginal[entry.key] ? (
                          <button className="btn ghost small" onClick={() => setShowOriginal((o) => ({ ...o, [entry.key]: false }))}>
                            Kurzfassung
                          </button>
                        ) : !cleaned[entry.key] && entry.text.length > 200 ? (
                          <button className="btn ghost small" disabled={cleaning === entry.key} onClick={() => void cleanMail(entry.key)} title="Zitate, Signatur und Disclaimer entfernen, Inhalt in wenigen Zeilen">
                            {cleaning === entry.key ? "kürzt …" : "Kürzen"}
                          </button>
                        ) : null}
                        {entry.kind === "Mail eingehend" ? (
                          <button className="btn agent small" disabled={replying === entry.key} onClick={() => void replyTo(entry.key)} title="Antwort auf diese Mail als Kommentar-Entwurf">
                            {replying === entry.key ? (
                              <>
                                <span className="dot xs agent pulse" /> entwirft …
                              </>
                            ) : (
                              "Antwort entwerfen"
                            )}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ))}

                <div className="reply" id="drawer-reply">
                  <div className="reply-tabs">
                    <button className={`tab${internal ? " active" : ""}`} onClick={() => setInternal(true)}>
                      Interne Notiz
                    </button>
                    <button className={`tab${!internal ? " active" : ""}`} onClick={() => setInternal(false)}>
                      Kommentar
                    </button>
                  </div>
                  <div className="reply-body">
                    {title ? (
                      <div className="row" style={{ marginBottom: 6, gap: 6 }}>
                        <span className="badge agent">Titel</span>
                        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} />
                        <button className="btn ghost small" onClick={() => setTitle("")} title="Ohne Titel speichern">
                          ×
                        </button>
                      </div>
                    ) : null}
                    <textarea
                      className="textarea"
                      rows={3}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder={
                        internal
                          ? "Interne Notiz – nur für Mitarbeiter sichtbar"
                          : "Kommentar – wird im Ticket gespeichert"
                      }
                    />
                    <div className="row">
                      <DraftButton
                        ticketIds={[ticketId]}
                        internal={internal}
                        ready={props.agentReady}
                        hasText={Boolean(text.trim())}
                        onDraft={setText}
                        onError={onError}
                      />
                      <span className="tiny muted">
                        Geht als {internal ? "interner" : "öffentlicher"} Kommentar an
                        POST /tickets/{ticketId}/comments
                      </span>
                      <button
                        className="btn primary"
                        style={{ marginLeft: "auto" }}
                        disabled={saving || !text.trim()}
                        onClick={saveComment}
                      >
                        {saving ? "Speichert …" : internal ? "Notiz speichern" : "Kommentar speichern"}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            {detail && tab === "Zeiten" ? (
              <>
                <h3 style={{ fontSize: 15, marginBottom: 8 }}>
                  Zeiten des Tickets <span className="mono muted small">{formatHours(total)}</span>
                </h3>
                <div className="times-table">
                  {detail.supports.length === 0 ? (
                    <div className="line muted">Noch keine Leistung gebucht.</div>
                  ) : null}
                  {[...detail.supports]
                    .sort((a, b) => a.date - b.date)
                    .map((s) => (
                      <div key={s.id} className="line">
                        <span className="mono muted">{fullDate(s.date).slice(0, 6)}</span>
                        <span className="mono">{minutesLabel(s.duration)}</span>
                        <span className="muted ellipsis">
                          {s.typeName ? `${s.typeName} · ` : ""}
                          {s.text.split("\n")[0]}
                        </span>
                      </div>
                    ))}
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
            <div style={{ height: 40 }} />
          </div>

          <div className="drawer-side">
            <div className="prop">
              <span className="k">Status</span>
              {states.length && ticket ? (
                <select
                  className="select"
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
            <div className="prop">
              <span className="k">Zuständig</span>
              {ticket && technicians.length ? (
                <select
                  className="select"
                  value={ticket.assigneeId}
                  onChange={(e) =>
                    void patch({ assignedToEmployeeId: Number(e.target.value) }, "Zuweisung geändert")
                  }
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
            </div>
            {ticket && props.meta && ticket.assigneeId !== props.meta.employeeId ? (
              <div className="prop" style={{ borderBottom: 0, paddingTop: 4 }}>
                <span className="k" />
                <button
                  className="btn agent"
                  onClick={() =>
                    void patch({ assignedToEmployeeId: props.meta!.employeeId }, "Mir zugewiesen")
                  }
                >
                  Mir zuweisen
                </button>
              </div>
            ) : null}
            {ticket ? (
              <TicketAgentActions
                ticketId={ticketId}
                ready={props.agentReady}
                states={states}
                boardRows={props.boardRows}
                onSetStatus={(statusId, name) => void patch({ statusId }, `Status → ${name}`)}
                onSetCompany={(companyId, name) => void patch({ companyId }, `Kunde → ${name}`)}
                onOpen={props.onOpen}
                onError={onError}
              />
            ) : null}
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
            {ticket?.estimatedMinutes ? (
              <Prop k="Geschätzt" v={minutesLabel(ticket.estimatedMinutes)} mono />
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}

function Prop(props: { k: string; v: string; mono?: boolean; tone?: "danger" }) {
  return (
    <div className="prop">
      <span className="k">{props.k}</span>
      <span
        className={`v ellipsis${props.mono ? " mono" : ""}`}
        style={props.tone === "danger" ? { color: "var(--danger)" } : undefined}
      >
        {props.v}
      </span>
    </div>
  );
}
