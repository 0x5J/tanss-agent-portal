import { useState } from "react";
import { api, type Briefing } from "../api.ts";
import type { Activity } from "../../shared/activity.ts";
import type { PatternGroup } from "../../shared/agent.ts";
import type { TicketRow } from "../../shared/tickets.ts";
import { AgentHint, Icon, SPARK_SMALL } from "../ui/kit.tsx";

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
  const results = Boolean(mine || list || patterns);
  const n = props.visible.length;
  const sentence = !props.ready
    ? "Die lokale KI ist noch nicht eingerichtet — unter Einstellungen → Lokale KI."
    : `Der Agent fasst deine Tickets oder „${props.listLabel}" zusammen und findet Fälle, die zusammengehören.`;

  return (
    <div className="tk-agent">
      <AgentHint
        actions={
          <>
            <button className="btn primary" disabled={!props.ready || mineBusy || props.rows.length === 0} title={hint ?? "Briefing über alle Tickets, die mir zugewiesen sind"} onClick={() => void loadMine(false)}>
              {mineBusy ? <Busy text="schreibt …" /> : "Mein Briefing"}
            </button>
            <button className="btn" disabled={!props.ready || listBusy || n === 0} title={hint ?? `Briefing über die Liste „${props.listLabel}" (${n} Tickets)`} onClick={() => void loadList(false)}>
              {listBusy ? <Busy text="schreibt …" /> : "Liste zusammenfassen"}
            </button>
            <button className="btn" disabled={!props.ready || patternsBusy || n < 2} title={hint ?? "Zusammengehörige Fälle in der Ansicht suchen"} onClick={() => void loadPatterns()}>
              {patternsBusy ? <Busy text="analysiert …" /> : `Muster analysieren (${n})`}
            </button>
            {results ? (
              <button className="btn ghost" onClick={() => setOpen((o) => !o)}>
                {open ? "Ausblenden" : "Einblenden"}
              </button>
            ) : null}
          </>
        }
      >
        {sentence}
      </AgentHint>
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
        <div className="tk-answer">
          <AnswerHead title="Zusammengehörige Fälle" meta={`${patterns.checked} Tickets geprüft`} onClose={() => setPatterns(null)} />
          {patterns.groups.length === 0 ? (
            <div className="muted">Keine zusammengehörigen Fälle in den {patterns.checked} geprüften Tickets erkannt.</div>
          ) : (
            <div className="tk-groups">
              {patterns.groups.map((g, i) => (
                <div key={i} className="tk-group">
                  <div className="ids">
                    {g.ticketIds.map((id) => (
                      <button key={id} className="chip mono tk-id" onClick={() => props.onOpen(id)} title={title(id)}>
                        #{id}
                      </button>
                    ))}
                    <span className="small muted ellipsis">{g.ticketIds.map(title).filter(Boolean).join(" · ")}</span>
                  </div>
                  <div className="pretty">{g.reason || "ohne Begründung"}</div>
                </div>
              ))}
              {patterns.truncated ? <div className="tiny muted">Nur die ersten {patterns.checked} Zeilen wurden geprüft.</div> : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Busy({ text }: { text: string }) {
  return (
    <>
      <span className="dot xs pulse" style={{ background: "currentColor" }} /> {text}
    </>
  );
}

function AnswerHead(props: { title: string; meta: string; onRefresh?: () => void; onClose: () => void }) {
  return (
    <div className="tk-answer-head">
      <span className="tk-disc">
        <Icon d={SPARK_SMALL} size={14} />
      </span>
      <span className="title">{props.title}</span>
      <span className="small muted">{props.meta}</span>
      <span className="actions">
        {props.onRefresh ? (
          <button className="btn small" onClick={props.onRefresh} title="Verwerfen und neu erzeugen">
            Neu erzeugen
          </button>
        ) : null}
        <button className="btn ghost small" onClick={props.onClose}>
          Schließen
        </button>
      </span>
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
  const facts: [number, string, "danger" | "warn" | null][] = [
    [f.total, props.mine ? "bei mir" : "in der Liste", null],
    ...(!props.mine ? ([[f.mine, "bei mir", null]] as [number, string, null][]) : []),
    [f.newSinceYesterday.length, "neu seit gestern", null],
    [f.overdue.length, "überfällig", "danger"],
    [f.stale.length, "≥7 d inaktiv", "warn"],
    ...(!props.mine ? ([[f.unassigned.length, "unzugewiesen", null]] as [number, string, null][]) : []),
    [f.waiting.length, "wartet auf Kunde", null],
  ];
  return (
    <div className="tk-answer">
      <AnswerHead
        title={`Briefing · ${props.title}`}
        meta={props.briefing.cached ? "von heute" : "eben erzeugt"}
        onRefresh={props.onRefresh}
        onClose={props.onClose}
      />
      <div className="tk-answer-body">{linkIds(props.briefing.text, props.onOpen)}</div>
      <div className="tk-facts">
        {facts.map(([value, label, tone]) => (
          <span key={label} className="chip">
            {tone && value > 0 ? <span className={`dot ${tone}`} style={{ width: 6, height: 6 }} /> : null}
            <b>{value}</b> {label}
          </span>
        ))}
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
      <button key={i} className="tk-link" onClick={() => onOpen(Number(m[1]))}>
        {part}
      </button>
    );
  });
}
