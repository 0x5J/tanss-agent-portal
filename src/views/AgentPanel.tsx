import { useState } from "react";
import { api, type Briefing } from "../api.ts";
import type { Activity } from "../../shared/activity.ts";
import type { PatternGroup } from "../../shared/agent.ts";
import type { TicketRow } from "../../shared/tickets.ts";

type Props = {
  ready: boolean;
  /** Every open ticket — the briefing looks at the whole board. */
  rows: TicketRow[];
  /** What is on screen — the list briefing and the pattern search look at that. */
  visible: TicketRow[];
  /** The open tab or saved list: a stable key for the cache and its name. */
  listKey: string;
  listLabel: string;
  activity: Record<number, Activity>;
  onOpen: (id: number) => void;
  onError: (error: unknown) => void;
};

/**
 * Briefing and pattern search over the board. Both are asked for, never
 * pushed: a click, a wait, a text with ticket numbers to click on.
 */
export function AgentPanel(props: Props) {
  const [open, setOpen] = useState(true);
  const [mine, setMine] = useState<Briefing | null>(null);
  const [mineBusy, setMineBusy] = useState(false);
  const [list, setList] = useState<(Briefing & { key: string; label: string }) | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [patterns, setPatterns] = useState<{ groups: PatternGroup[]; checked: number; truncated: boolean } | null>(null);
  const [patternsBusy, setPatternsBusy] = useState(false);

  async function loadMine(force: boolean) {
    setMineBusy(true);
    try {
      setMine(await api.agent.briefing({ rows: props.rows, activity: props.activity, force, scope: "mine" }));
    } catch (error) {
      props.onError(error);
    } finally {
      setMineBusy(false);
    }
  }

  async function loadList(force: boolean) {
    const key = props.listKey;
    const label = props.listLabel;
    setListBusy(true);
    try {
      const result = await api.agent.briefing({ rows: props.visible, activity: props.activity, force, scope: `list:${key}`, label });
      setList({ ...result, key, label });
    } catch (error) {
      props.onError(error);
    } finally {
      setListBusy(false);
    }
  }

  async function loadPatterns() {
    setPatternsBusy(true);
    try {
      setPatterns(await api.agent.patterns({ rows: props.visible, activity: props.activity }));
    } catch (error) {
      props.onError(error);
    } finally {
      setPatternsBusy(false);
    }
  }

  const title = (id: number) => props.rows.find((r) => r.id === id)?.title ?? "";
  const hint = props.ready ? undefined : "KI nicht eingerichtet (Einstellungen)";

  return (
    <div className="agent-panel">
      <div className="head">
        <span className="dot sm agent" />
        <span className="title">Agent</span>
        <button className="btn agent small" disabled={!props.ready || mineBusy || props.rows.length === 0} title={hint ?? "Briefing über alle Tickets, die mir zugewiesen sind"} onClick={() => void loadMine(false)}>
          {mineBusy ? (
            <>
              <span className="dot xs agent pulse" /> schreibt …
            </>
          ) : (
            "Mein Briefing"
          )}
        </button>
        <button className="btn agent small" disabled={!props.ready || listBusy || props.visible.length === 0} title={hint ?? `Briefing über die Liste „${props.listLabel}" (${props.visible.length} Tickets)`} onClick={() => void loadList(false)}>
          {listBusy ? (
            <>
              <span className="dot xs agent pulse" /> schreibt …
            </>
          ) : (
            `Briefing „${props.listLabel}"`
          )}
        </button>
        <button className="btn agent small" disabled={!props.ready || patternsBusy || props.visible.length < 2} title={hint ?? "Zusammengehörige Fälle in der Ansicht suchen"} onClick={() => void loadPatterns()}>
          {patternsBusy ? (
            <>
              <span className="dot xs agent pulse" /> analysiert …
            </>
          ) : (
            `Muster analysieren (${props.visible.length})`
          )}
        </button>
        <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={() => setOpen((o) => !o)}>
          {open ? "Zuklappen" : "Aufklappen"}
        </button>
      </div>
      {open && mine ? (
        <BriefingBlock title="Meine Tickets" briefing={mine} mine onOpen={props.onOpen} onRefresh={() => void loadMine(true)} onClose={() => setMine(null)} />
      ) : null}
      {open && list ? (
        <BriefingBlock
          title={`Liste „${list.label}"${list.key !== props.listKey ? " (andere Liste)" : ""}`}
          briefing={list}
          onOpen={props.onOpen}
          onRefresh={() => void loadList(true)}
          onClose={() => setList(null)}
        />
      ) : null}
      {open && patterns ? (
        patterns.groups.length === 0 ? (
          <div className="body muted">Keine zusammengehörigen Fälle in den {patterns.checked} geprüften Tickets erkannt.</div>
        ) : (
          <div>
            {patterns.groups.map((g, i) => (
              <div key={i} className="pattern-group">
                <div className="ids">
                  {g.ticketIds.map((id) => (
                    <button key={id} className="btn ghost small" onClick={() => props.onOpen(id)} title={title(id)}>
                      #{id}
                    </button>
                  ))}
                  <span className="tiny muted ellipsis" style={{ alignSelf: "center" }}>{g.ticketIds.map(title).filter(Boolean).join(" · ")}</span>
                </div>
                <div className="muted">{g.reason || "ohne Begründung"}</div>
              </div>
            ))}
            {patterns.truncated ? <div className="tiny muted" style={{ marginTop: 6 }}>Nur die ersten {patterns.checked} Zeilen wurden geprüft.</div> : null}
          </div>
        )
      ) : null}
    </div>
  );
}

function BriefingBlock(props: {
  title: string;
  briefing: Briefing;
  mine?: boolean;
  onOpen: (id: number) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const f = props.briefing.facts;
  return (
    <div className="briefing">
      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <span className="tiny" style={{ color: "var(--agent)" }}>{props.title}</span>
        <span className="tiny muted">{props.briefing.cached ? "von heute" : "eben erzeugt"}</span>
        <button className="btn ghost small" onClick={props.onRefresh} title="Verwerfen und neu erzeugen">
          neu
        </button>
        <button className="btn ghost small" onClick={props.onClose}>
          ausblenden
        </button>
      </div>
      <div className="body" style={{ marginTop: 4 }}>{linkIds(props.briefing.text, props.onOpen)}</div>
      <div className="facts">
        <span><b>{f.total}</b> {props.mine ? "bei mir" : "in der Liste"}</span>
        {!props.mine ? <span><b>{f.mine}</b> bei mir</span> : null}
        <span><b>{f.newSinceYesterday.length}</b> neu seit gestern</span>
        <span><b>{f.overdue.length}</b> überfällig</span>
        <span><b>{f.stale.length}</b> ≥7 d inaktiv</span>
        {!props.mine ? <span><b>{f.unassigned.length}</b> unzugewiesen</span> : null}
        <span><b>{f.waiting.length}</b> wartet auf Kunde</span>
      </div>
    </div>
  );
}

/** "#4711" in the text becomes a click that opens the ticket. */
function linkIds(text: string, onOpen: (id: number) => void) {
  const parts = text.split(/(#\d{2,})/g);
  return parts.map((part, i) => {
    const m = /^#(\d{2,})$/.exec(part);
    if (!m) return <span key={i}>{part}</span>;
    return (
      <button key={i} className="btn ghost small mono" style={{ padding: "0 4px", verticalAlign: "baseline" }} onClick={() => onOpen(Number(m[1]))}>
        {part}
      </button>
    );
  });
}
