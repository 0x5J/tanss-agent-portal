import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import type { ChatTurn } from "../shared/agent.ts";
import type { Activity } from "../shared/activity.ts";
import type { TicketRow } from "../shared/tickets.ts";

type Props = {
  open: boolean;
  onToggle: () => void;
  ready: boolean;
  model: string;
  employeeId: number;
  /** What the board knows — goes along as context. */
  rows: TicketRow[];
  activity: Record<number, Activity>;
  openTicketId: number | null;
  onClearContext: () => void;
  onOpen: (id: number) => void;
  onView: (view: "settings") => void;
  onError: (error: unknown) => void;
};

const MAX_KEPT = 40;

// A tool call the server made while answering — kept only long enough to build the source line.
type Step = { tool: string; arg: string; result: string; ok: boolean };
// The stored source line, not the raw steps: steps[].result carries the full ticket history
// (up to ~22.6k chars per read), which would blow localStorage's ~5 MB quota within a few turns.
type Message = ChatTurn & { source?: string };

function storageKey(employeeId: number) {
  return `agent-portal:chat:${employeeId}`;
}

/**
 * navigator.clipboard needs a secure context; over plain http (e.g. the
 * container's ALLOW_ALL_INTERFACES=1 mode) it is undefined, and the copy
 * button — the whole point of this feature — would silently do nothing.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path below
    }
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

function loadChat(employeeId: number): Message[] {
  try {
    const raw = localStorage.getItem(storageKey(employeeId));
    const parsed = raw ? (JSON.parse(raw) as Message[]) : [];
    return Array.isArray(parsed) ? parsed.slice(-MAX_KEPT) : [];
  } catch {
    return [];
  }
}

/**
 * The agent sidebar of the artboard: a chat over the board, today's bookings
 * and the tickets a question names. Stateless on the server; the history
 * lives in this browser.
 */
export function AgentSidebar(props: Props) {
  const [chat, setChat] = useState<Message[]>(() => loadChat(props.employeeId));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedAt, setCopiedAt] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  async function copyAnswer(text: string, index: number) {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedAt(index);
      setTimeout(() => setCopiedAt((c) => (c === index ? null : c)), 1500);
    } else {
      props.onError(new Error("Kopieren war nicht möglich — bitte den Text markieren und selbst kopieren."));
    }
  }

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(props.employeeId), JSON.stringify(chat.slice(-MAX_KEPT)));
    } catch {
      /* ignore */
    }
  }, [chat, props.employeeId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chat, busy, props.open]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const next = [...chat, { role: "user" as const, content }];
    setChat(next);
    setDraft("");
    setBusy(true);
    try {
      const result = await api.agent.chat({
        // Server schema caps content at 8000 chars and silently strips unknown fields — send only role/content.
        messages: next.slice(-12).map((m) => ({ role: m.role, content: m.content })),
        rows: props.rows,
        activity: props.activity,
        openTicketId: props.openTicketId,
      });
      const source = sourceLine(result.steps);
      setChat((c) => [...c, { role: "assistant", content: result.text, source: source || undefined }]);
    } catch (error) {
      props.onError(error);
      setChat((c) => [...c, { role: "assistant", content: `⚠ ${error instanceof Error ? error.message : "Fehler"}` }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  if (!props.open) {
    return (
      <button className="agent-rail" onClick={props.onToggle} title="Agent-Sidebar öffnen (g a)">
        <span className={`dot sm ${props.ready ? "agent" : "flat"}`} />
        <span className="label">Agent</span>
      </button>
    );
  }

  const suggestions = [
    "Was ist liegengeblieben?",
    "Was lief heute?",
    "Mail über zwei Tickets",
    ...(props.openTicketId ? [`Was ist bei #${props.openTicketId} zuletzt passiert?`] : ["Welche Tickets gehören zusammen?"]),
  ];

  return (
    <aside className="agent-sidebar">
      <div className="agent-sidebar-head">
        <span className={`dot sm ${props.ready ? "agent" : "flat"}`} />
        <span style={{ fontWeight: 500 }}>Agent</span>
        <span className="mono tiny muted ellipsis">{props.ready ? props.model : "nicht eingerichtet"}</span>
        {chat.length ? (
          <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={() => setChat([])} title="Verlauf leeren">
            leeren
          </button>
        ) : null}
        <button className="btn ghost small" style={chat.length ? {} : { marginLeft: "auto" }} onClick={props.onToggle} title="Einklappen (g a)">
          ›
        </button>
      </div>

      <div className="agent-sidebar-list" ref={listRef}>
        {chat.length === 0 ? (
          <div className="tiny muted pretty" style={{ padding: "4px 2px" }}>
            Fragen zu deinen Tickets, dem Tag und einzelnen Verläufen. Der Agent sucht und liest selbst in TANSS nach —
            eine Ticketnummer hilft, ist aber nicht nötig. Er antwortet nur; buchen und kommentieren bleibt bei dir.
          </div>
        ) : null}
        {chat.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="who">
              {m.role === "user" ? "Du" : "Agent"}
              {m.role === "assistant" && m.content ? (
                <button
                  className="btn ghost small"
                  style={{ marginLeft: "auto" }}
                  onClick={() => void copyAnswer(m.content, i)}
                  title="Antwort kopieren"
                >
                  {copiedAt === i ? "kopiert ✓" : "kopieren"}
                </button>
              ) : null}
            </div>
            <div className="text">{m.role === "assistant" ? linkIds(m.content, props.onOpen) : m.content}</div>
            {m.source ? <div className="chat-source tiny muted">{linkIds(m.source, props.onOpen)}</div> : null}
          </div>
        ))}
        {busy ? (
          <div className="chat-msg assistant">
            <div className="who">Agent</div>
            <div className="text muted">
              <span className="dot xs agent pulse" /> denkt …
            </div>
          </div>
        ) : null}
      </div>

      <div className="agent-sidebar-foot">
        {props.openTicketId ? (
          <div className="row tiny" style={{ marginBottom: 6 }}>
            <span className="badge agent">Kontext</span>
            <span className="mono">Ticket #{props.openTicketId}</span>
            <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={props.onClearContext}>
              ×
            </button>
          </div>
        ) : null}
        <div className="row" style={{ flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
          {suggestions.map((s) => (
            <button key={s} className="btn ghost small" disabled={!props.ready || busy} onClick={() => void send(s)}>
              {s}
            </button>
          ))}
        </div>
        {props.ready ? (
          <textarea
            ref={inputRef}
            className="textarea"
            rows={2}
            value={draft}
            placeholder={busy ? "Antwort kommt … die nächste Frage kannst du schon tippen" : "Frage an den Agenten … ⏎ sendet"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
          />
        ) : (
          <button className="btn agent" onClick={() => props.onView("settings")}>
            KI einrichten
          </button>
        )}
      </div>
    </aside>
  );
}

/** What the answer rests on, in one line: what was searched, which histories were read, and which support entries were pulled. */
function sourceLine(steps: Step[]): string {
  const searched = steps.filter((s) => s.tool === "tickets_suchen" && s.ok && s.arg).map((s) => `„${s.arg}"`);
  const read = steps.filter((s) => s.tool === "ticket_lesen" && s.ok).map((s) => s.arg);
  const supports = steps.filter((s) => s.tool === "leistungen_ticket" && s.ok).map((s) => s.arg);
  const parts = [
    searched.length ? `gesucht: ${[...new Set(searched)].join(", ")}` : "",
    read.length ? `gelesen: ${[...new Set(read)].join(", ")}` : "",
    supports.length ? `Leistungen: ${[...new Set(supports)].join(", ")}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

function linkIds(text: string, onOpen: (id: number) => void) {
  return text.split(/(#\d{2,})/g).map((part, i) => {
    const m = /^#(\d{2,})$/.exec(part);
    if (!m) return <span key={i}>{part}</span>;
    return (
      <button key={i} className="btn ghost small mono" style={{ padding: "0 4px", verticalAlign: "baseline" }} onClick={() => onOpen(Number(m[1]))}>
        {part}
      </button>
    );
  });
}
