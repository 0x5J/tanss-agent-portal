import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { TicketRow } from "../../shared/tickets.ts";

type Props = {
  ticketId: number;
  ready: boolean;
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
 * The agent's questions about a ticket — what next, was there something like
 * it, and is it filed under the right customer — in the properties column.
 * Every change stays a click of the person; nothing here writes by itself.
 */
export function TicketAgentActions(props: Props) {
  const [next, setNext] = useState<Next | null>(null);
  const [nextBusy, setNextBusy] = useState(false);
  const [similar, setSimilar] = useState<Similar | null>(null);
  const [similarBusy, setSimilarBusy] = useState(false);
  const [check, setCheck] = useState<Check | null>(null);
  const [checkBusy, setCheckBusy] = useState(false);

  useEffect(() => {
    setNext(null);
    setSimilar(null);
    setCheck(null);
  }, [props.ticketId]);

  async function loadNext() {
    setNextBusy(true);
    try {
      setNext(await api.agent.next(props.ticketId));
    } catch (error) {
      props.onError(error);
    } finally {
      setNextBusy(false);
    }
  }

  async function loadCheck() {
    setCheckBusy(true);
    try {
      setCheck(await api.agent.company(props.ticketId));
    } catch (error) {
      props.onError(error);
    } finally {
      setCheckBusy(false);
    }
  }

  async function loadSimilar() {
    setSimilarBusy(true);
    try {
      setSimilar(await api.agent.similar({ ticketId: props.ticketId, rows: props.boardRows, activity: {} }));
    } catch (error) {
      props.onError(error);
    } finally {
      setSimilarBusy(false);
    }
  }

  const hint = props.ready ? undefined : "KI nicht eingerichtet (Einstellungen)";

  return (
    <div className="prop" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <button className="btn agent small" disabled={!props.ready || nextBusy} title={hint ?? "Was ist als Nächstes zu tun?"} onClick={() => void loadNext()}>
          {nextBusy ? (
            <>
              <span className="dot xs agent pulse" /> prüft …
            </>
          ) : (
            "Nächster Schritt"
          )}
        </button>
        <button className="btn agent small" disabled={!props.ready || similarBusy} title={hint ?? "Gab es das schon? Board und TANSS-Suche"} onClick={() => void loadSimilar()}>
          {similarBusy ? (
            <>
              <span className="dot xs agent pulse" /> sucht …
            </>
          ) : (
            "Ähnliche Tickets"
          )}
        </button>
        <button className="btn agent small" disabled={!props.ready || checkBusy} title={hint ?? "Passt der Kunde zu dem, was im Ticket steht?"} onClick={() => void loadCheck()}>
          {checkBusy ? (
            <>
              <span className="dot xs agent pulse" /> prüft …
            </>
          ) : (
            "Kunde prüfen"
          )}
        </button>
      </div>

      {check ? <CompanyCheckBox check={check} onClose={() => setCheck(null)} onSetCompany={props.onSetCompany} /> : null}

      {next ? (
        <div className="agent-box" style={{ marginBottom: 0 }}>
          <div className="label">
            <span>Nächster Schritt{next.owner ? ` · am Zug: ${next.owner}` : ""}</span>
            <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={() => setNext(null)}>
              ×
            </button>
          </div>
          {next.text}
          {next.statusName && next.statusId && !next.unchanged ? (
            <div className="row" style={{ marginTop: 8 }}>
              <span className="tiny muted">Status passt nicht mehr ({next.currentStatus || "—"})</span>
              <button className="btn small" style={{ marginLeft: "auto" }} onClick={() => props.onSetStatus(next.statusId!, next.statusName!)}>
                → {next.statusName}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {similar ? (
        <div className="agent-box" style={{ marginBottom: 0 }}>
          <div className="label">
            <span>
              Ähnliche Tickets · {similar.checked} geprüft{similar.searched ? ` · Suche „${similar.searched}"` : ""}
            </span>
            <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={() => setSimilar(null)}>
              ×
            </button>
          </div>
          {similar.similar.length === 0 ? (
            <span className="muted">Nichts Vergleichbares gefunden.</span>
          ) : (
            similar.similar.map((hit) => (
              <div key={hit.ticketId} style={{ marginTop: 6 }}>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn ghost small mono" onClick={() => props.onOpen(hit.ticketId)}>
                    #{hit.ticketId}
                  </button>
                  <span className="ellipsis small">{hit.title}</span>
                  <span className="tiny muted" style={{ marginLeft: "auto", flex: "none" }}>{hit.statusName}</span>
                </div>
                <div className="tiny muted pretty">{hit.companyName ? `${hit.companyName} · ` : ""}{hit.reason}</div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the check found. The verdicts that need nothing from the person stay
 * one quiet line; only a real mismatch offers the change — and it is a button,
 * never something that already happened.
 */
function CompanyCheckBox(props: {
  check: Check;
  onClose: () => void;
  onSetCompany: (companyId: number, name: string) => void;
}) {
  const { check } = props;
  const others = check.candidates.filter((c) => c.id !== check.suggestion?.companyId);
  return (
    <div className="agent-box" style={{ marginBottom: 0 }}>
      <div className="label">
        <span>Kunde prüfen</span>
        <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={props.onClose}>
          ×
        </button>
      </div>
      {check.verdict === "matches" ? (
        <>Kunde passt: im Text ist „{check.mentioned}“ genannt.</>
      ) : check.verdict === "none-named" ? (
        <>Im Ticket ist keine Firma genannt — nichts zu vergleichen.</>
      ) : check.verdict === "not-found" ? (
        <>
          Im Text genannt: <b>{check.mentioned}</b> — dazu kennt TANSS keinen Kunden.
        </>
      ) : (
        <>
          <div>
            Im Text genannt: <b>{check.mentioned}</b> · zugewiesen: {check.currentCompanyName || "—"}
          </div>
          {check.evidence ? (
            <div className="tiny muted" style={{ marginTop: 4 }}>
              „{check.evidence}“
            </div>
          ) : null}
          {check.suggestion ? (
            <div className="row" style={{ marginTop: 8 }}>
              <span className="tiny muted">{check.suggestion.reason}</span>
              <button
                className="btn small"
                style={{ marginLeft: "auto" }}
                onClick={() => props.onSetCompany(check.suggestion!.companyId, check.suggestion!.name)}
              >
                → {check.suggestion.name}
              </button>
            </div>
          ) : (
            <div className="tiny muted" style={{ marginTop: 8 }}>Kein Kunde passt eindeutig.</div>
          )}
          {others.length > 0 ? (
            <div className="row" style={{ marginTop: 6, gap: 4, flexWrap: "wrap" }}>
              <span className="tiny muted">weitere:</span>
              {others.map((c) => (
                <button key={c.id} className="btn ghost small" onClick={() => props.onSetCompany(c.id, c.name)}>
                  {c.name}
                  {c.city ? ` · ${c.city}` : ""}
                </button>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
