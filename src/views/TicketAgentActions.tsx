import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import type { TicketRow } from "../../shared/tickets.ts";
import { Dot, Icon, SPARK_SMALL } from "../ui/kit.tsx";

type Props = {
  ticketId: number;
  ready: boolean;
  /** How many entries the thread has — shown while the agent has not been asked yet. */
  entries: number;
  states: { id: number; name: string }[];
  boardRows: TicketRow[];
  onSetStatus: (statusId: number, name: string) => void;
  onSetCompany: (companyId: number, name: string) => void;
  onOpen: (id: number) => void;
  onError: (error: unknown) => void;
};

type Next = Awaited<ReturnType<typeof api.agent.next>>;
type Similar = Awaited<ReturnType<typeof api.agent.similar>>;
type Check = Awaited<ReturnType<typeof api.agent.company>>;

/**
 * "Einschätzung des Agenten": the card on top of the thread. It holds the
 * agent's questions about a ticket — where it stands, what next, was there
 * something like it, is it filed under the right customer — and shows each
 * answer as one insight. Every change stays a click of the person; nothing
 * here writes by itself.
 */
export function TicketAgentActions(props: Props) {
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [next, setNext] = useState<Next | null>(null);
  const [nextBusy, setNextBusy] = useState(false);
  const [similar, setSimilar] = useState<Similar | null>(null);
  const [similarBusy, setSimilarBusy] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const [checkBusy, setCheckBusy] = useState(false);

  useEffect(() => {
    setSummary(null);
    setNext(null);
    setSimilar(null);
    setCheck(null);
  }, [props.ticketId]);

  async function run<T>(busy: (b: boolean) => void, load: () => Promise<T>, done: (value: T) => void) {
    busy(true);
    try {
      done(await load());
    } catch (error) {
      props.onError(error);
    } finally {
      busy(false);
    }
  }

  const hint = props.ready ? undefined : "KI nicht eingerichtet (Einstellungen)";
  const asked = summary !== null || next !== null || similar !== null || check !== null;

  return (
    <div className="td-agent">
      <div className="td-agent-head">
        <span className="td-agent-disc">
          <Icon d={SPARK_SMALL} size={14} />
        </span>
        <span className="title">Einschätzung des Agenten</span>
        {!props.ready ? <span className="tiny muted">KI nicht eingerichtet</span> : null}
      </div>

      {asked ? (
        <div className="td-insights">
          {summary !== null ? (
            <Insight tone="ink" title="Stand der Dinge" onClose={() => setSummary(null)}>
              <span className="pre">{summary}</span>
            </Insight>
          ) : null}

          {next ? (
            <Insight tone="ink" title={`Nächster Schritt${next.owner ? ` · am Zug: ${next.owner}` : ""}`} onClose={() => setNext(null)}>
              {next.text}
              {next.statusName && next.statusId && !next.unchanged ? (
                <div className="td-insight-action">
                  <span className="tiny muted">Status passt nicht mehr ({next.currentStatus || "—"})</span>
                  <button className="btn small" onClick={() => props.onSetStatus(next.statusId!, next.statusName!)}>
                    → {next.statusName}
                  </button>
                </div>
              ) : null}
            </Insight>
          ) : null}

          {similar ? (
            <Insight
              tone="flat"
              title={`Ähnliche Tickets · ${similar.checked} geprüft${similar.searched ? ` · Suche „${similar.searched}"` : ""}`}
              onClose={() => setSimilar(null)}
            >
              {similar.similar.length === 0 ? (
                "Nichts Vergleichbares gefunden."
              ) : (
                <div className="td-hits">
                  {similar.similar.map((hit) => (
                    <div key={hit.ticketId} className="td-hit">
                      <div className="row" style={{ gap: 8 }}>
                        <button className="linkish mono" onClick={() => props.onOpen(hit.ticketId)}>
                          #{hit.ticketId}
                        </button>
                        <span className="ellipsis" style={{ color: "var(--ink)" }}>{hit.title}</span>
                        <span className="tiny muted" style={{ marginLeft: "auto", flex: "none" }}>
                          {hit.statusName}
                        </span>
                      </div>
                      <div className="tiny muted pretty">
                        {hit.companyName ? `${hit.companyName} · ` : ""}
                        {hit.reason}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Insight>
          ) : null}

          {check ? <CompanyCheck check={check} onClose={() => setCheck(null)} onSetCompany={props.onSetCompany} /> : null}
        </div>
      ) : (
        <p className="small muted pretty">
          {props.entries} {props.entries === 1 ? "Eintrag" : "Einträge"} im Verlauf. Der Agent liest erst, wenn du fragst — und
          ändert nichts von selbst.
        </p>
      )}

      <div className="td-agent-actions">
        <button
          className="btn primary"
          disabled={!props.ready || summaryBusy}
          title={hint ?? "Verlauf in fünf Zeilen zusammenfassen"}
          onClick={() => void run(setSummaryBusy, () => api.agent.summary(props.ticketId), (r) => setSummary(r.text))}
        >
          {summaryBusy ? <Busy>fasst zusammen …</Busy> : "Zusammenfassen"}
        </button>
        <button
          className="btn"
          disabled={!props.ready || nextBusy}
          title={hint ?? "Was ist als Nächstes zu tun?"}
          onClick={() => void run(setNextBusy, () => api.agent.next(props.ticketId), setNext)}
        >
          {nextBusy ? <Busy>prüft …</Busy> : "Nächster Schritt"}
        </button>
        <button
          className="btn"
          disabled={!props.ready || similarBusy}
          title={hint ?? "Gab es das schon? Board und TANSS-Suche"}
          onClick={() =>
            void run(setSimilarBusy, () => api.agent.similar({ ticketId: props.ticketId, rows: props.boardRows, activity: {} }), setSimilar)
          }
        >
          {similarBusy ? <Busy>sucht …</Busy> : "Ähnliche Tickets"}
        </button>
        <button
          className="btn"
          disabled={!props.ready || checkBusy}
          title={hint ?? "Passt der Kunde zu dem, was im Ticket steht?"}
          onClick={() => void run(setCheckBusy, () => api.agent.company(props.ticketId), setCheck)}
        >
          {checkBusy ? <Busy>prüft …</Busy> : "Kunde prüfen"}
        </button>
      </div>
    </div>
  );
}

function Busy({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="dot xs pulse" style={{ background: "currentColor" }} /> {children}
    </>
  );
}

/** One answer of the agent: dot, bold title, muted text, a quiet × to dismiss it. */
function Insight(props: { tone: "ink" | "flat" | "ok" | "warn"; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="td-insight">
      <Dot tone={props.tone} />
      <div className="td-insight-body">
        <span className="td-insight-title">{props.title}.</span> {props.children}
      </div>
      <button className="td-insight-close" onClick={props.onClose} title="Ausblenden" aria-label="Ausblenden">
        ×
      </button>
    </div>
  );
}

/**
 * What the company check found. The verdicts that need nothing from the
 * person stay one quiet line; only a real mismatch offers the change — and it
 * is a button, never something that already happened.
 */
function CompanyCheck(props: { check: Check; onClose: () => void; onSetCompany: (companyId: number, name: string) => void }) {
  const { check } = props;
  const others = check.candidates.filter((c) => c.id !== check.suggestion?.companyId);
  const mismatch = check.verdict !== "matches" && check.verdict !== "none-named" && check.verdict !== "not-found";
  return (
    <Insight tone={check.verdict === "matches" ? "ok" : mismatch ? "warn" : "flat"} title="Kunde" onClose={props.onClose}>
      {check.verdict === "matches" ? (
        <>Passt: im Text ist „{check.mentioned}“ genannt.</>
      ) : check.verdict === "none-named" ? (
        <>Im Ticket ist keine Firma genannt — nichts zu vergleichen.</>
      ) : check.verdict === "not-found" ? (
        <>
          Im Text genannt: <b>{check.mentioned}</b> — dazu kennt TANSS keinen Kunden.
        </>
      ) : (
        <>
          Im Text genannt: <b>{check.mentioned}</b> · zugewiesen: {check.currentCompanyName || "—"}
          {check.evidence ? <span className="td-quote">„{check.evidence}“</span> : null}
          {check.suggestion ? (
            <span className="td-insight-action">
              <span className="tiny muted">{check.suggestion.reason}</span>
              <button className="btn small" onClick={() => props.onSetCompany(check.suggestion!.companyId, check.suggestion!.name)}>
                → {check.suggestion.name}
              </button>
            </span>
          ) : (
            <span className="td-quote">Kein Kunde passt eindeutig.</span>
          )}
          {others.length > 0 ? (
            <span className="td-insight-action" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
              <span className="tiny muted">weitere:</span>
              {others.map((c) => (
                <button key={c.id} className="btn small" onClick={() => props.onSetCompany(c.id, c.name)}>
                  {c.name}
                  {c.city ? ` · ${c.city}` : ""}
                </button>
              ))}
            </span>
          ) : null}
        </>
      )}
    </Insight>
  );
}
