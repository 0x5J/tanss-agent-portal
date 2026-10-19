import { useEffect, useState } from "react";
import { api, type Meta, type Proposal } from "../api.ts";
import { formatShortDate } from "../../shared/days.ts";
import { formatClock } from "../../shared/timeline.ts";

type Props = {
  meta: Meta | null;
  reload: number;
  onSubtitle: (text: string) => void;
  onError: (error: unknown) => void;
  onToast: (text: string) => void;
  onChanged: () => void;
  onOpen: (id: number) => void;
  onCount: (count: number) => void;
};

/**
 * What the agent proposes and has not been decided yet. Approving books the
 * support through the same route the booking form uses.
 */
export function ApprovalsView(props: Props) {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [version, setVersion] = useState(0);
  const { onSubtitle, onError, onCount } = props;

  useEffect(() => {
    let cancelled = false;
    api.agent
      .proposals()
      .then((r) => {
        if (cancelled) return;
        setProposals(r.proposals);
        onCount(r.proposals.length);
      })
      .catch((error: unknown) => {
        if (!cancelled) onError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [version, props.reload, onError, onCount]);

  useEffect(() => {
    onSubtitle(proposals ? `${proposals.length} offen` : "");
  }, [proposals, onSubtitle]);

  function done() {
    setVersion((v) => v + 1);
    props.onChanged();
  }

  return (
    <div style={{ padding: 16, maxWidth: 920 }}>
      {proposals && proposals.length === 0 ? (
        <div className="empty">
          <div className="title">Inbox leer.</div>
          <div className="small muted pretty" style={{ maxWidth: "68ch" }}>
            Hier landen Buchungsvorschläge des Agenten und warten auf Freigabe. Einen Vorschlag
            erzeugst du in „Zeiten" über „Agent fragen" an einer Lücke. Nichts geht ohne deine
            Freigabe nach TANSS.
          </div>
        </div>
      ) : null}
      {proposals?.map((p) => (
        <ProposalCard key={p.id} proposal={p} meta={props.meta} onDone={done} onError={onError} onToast={props.onToast} onOpen={props.onOpen} />
      ))}
    </div>
  );
}

function ProposalCard(props: {
  proposal: Proposal;
  meta: Meta | null;
  onDone: () => void;
  onError: (error: unknown) => void;
  onToast: (text: string) => void;
  onOpen: (id: number) => void;
}) {
  const { proposal: p } = props;
  const [text, setText] = useState(p.booking.text);
  const [durationText, setDurationText] = useState(String(p.booking.duration));
  const duration = Math.round(Number(durationText)) || 0;
  const durationOk = duration >= 5 && duration <= 24 * 60;
  const [typeId, setTypeId] = useState(p.booking.typeId);
  const [busy, setBusy] = useState(false);
  const types = props.meta?.supportTypes ?? [];

  async function approve() {
    setBusy(true);
    try {
      await api.agent.approve(p.id, { text: text.trim(), duration, typeId });
      props.onToast(`Leistung gebucht: ${p.booking.ticketId ? `#${p.booking.ticketId}` : p.booking.companyName} · ${duration} min`);
      props.onDone();
    } catch (error) {
      props.onError(error);
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    try {
      await api.agent.reject(p.id);
      props.onToast("Vorschlag verworfen");
      props.onDone();
    } catch (error) {
      props.onError(error);
      setBusy(false);
    }
  }

  return (
    <div className="card agent-outline" style={{ padding: "12px 16px", marginBottom: 12 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="badge agent">Buchung</span>
        <span className="mono small">
          {formatShortDate(p.booking.date)} · {formatClock(p.booking.startMinute)}–{formatClock(p.booking.startMinute + duration)}
        </span>
        {p.booking.ticketId ? (
          <button className="btn ghost small mono" onClick={() => props.onOpen(p.booking.ticketId!)}>
            #{p.booking.ticketId}
          </button>
        ) : null}
        <span className="small ellipsis">{p.booking.ticketTitle || p.booking.companyName}</span>
        <span className="tiny muted" style={{ marginLeft: "auto" }}>{p.booking.companyName}</span>
      </div>
      <textarea className="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ marginTop: 8, gap: 10 }}>
        <label className="row small muted" style={{ gap: 6 }}>
          Dauer
          <input
            className="input mono"
            type="number"
            min={5}
            step={5}
            value={durationText}
            onChange={(e) => setDurationText(e.target.value)}
            style={{ width: 72, borderColor: durationOk ? undefined : "var(--danger)" }}
          />
          min
        </label>
        {types.length ? (
          <select className="select" value={typeId} onChange={(e) => setTypeId(Number(e.target.value))}>
            {!types.some((t) => t.id === typeId) ? <option value={typeId}>#{typeId}</option> : null}
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        ) : null}
        <button className="btn ghost" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => void reject()}>
          Verwerfen
        </button>
        <button className="btn primary" disabled={busy || !text.trim() || !durationOk} onClick={() => void approve()}>
          {busy ? "…" : "Freigeben & buchen"}
        </button>
      </div>
      <div className="tiny muted pretty" style={{ marginTop: 10 }}>
        <div style={{ marginBottom: 4 }}>
          <span style={{ color: "var(--agent)" }}>Begründung</span> · {p.reason || "—"}
        </div>
        {p.evidence.map((line, i) => (
          <div key={i}>· {line}</div>
        ))}
      </div>
    </div>
  );
}
