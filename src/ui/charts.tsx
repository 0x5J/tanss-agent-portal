import type { ReactNode } from "react";
import { KeyDot, Ring } from "./kit.tsx";

const nf = new Intl.NumberFormat("de-DE");

/**
 * Columns on an ink baseline (the redesign's bar chart). One series, one hue;
 * only the peak carries its number, every bar carries its exact value on
 * hover. Empty buckets keep their slot — a day without anything is often the
 * thing you came to see.
 */
export function VBars(props: {
  values: number[];
  /** Hover text of a bar, e.g. "14 Uhr". */
  labelOf: (index: number) => string;
  /** Tick under a bar; empty string leaves the slot blank. */
  tickOf: (index: number) => string;
  format?: (value: number) => string;
  /** Plot height in px. */
  height?: number;
  /** Widest a bar may get. */
  maxBar?: number;
  /** Bar width as share of its slot, e.g. "70%". */
  barWidth?: string;
  empty?: ReactNode;
  /** Grey bars (weekends) instead of ink. */
  dim?: (index: number) => boolean;
  onPick?: (index: number) => void;
  /** Extra hover suffix for clickable bars. */
  pickHint?: string;
  /** A dashed amber line at this value, labelled. */
  target?: { value: number; label: string };
  /** Scale floor, so a quiet range does not blow single minutes up to full height. */
  minScale?: number;
  ariaLabel?: string;
}) {
  const { values } = props;
  const format = props.format ?? ((v: number) => nf.format(v));
  const total = values.reduce((a, b) => a + b, 0);
  if (values.length === 0 || (total === 0 && !props.target)) {
    return <div className="empty-inline">{props.empty ?? "Keine Daten."}</div>;
  }
  const height = props.height ?? 180;
  const peakValue = Math.max(...values);
  const peak = values.indexOf(peakValue);
  // Headroom above the tallest bar for its number (and above the target line).
  const top = Math.max(props.minScale ?? 1, peakValue, props.target?.value ?? 0) * 1.08;
  return (
    <div className="vbars">
      <div className="vbars-plot" style={{ height }} role="img" aria-label={props.ariaLabel}>
        {props.target ? (
          <div className="vbars-target" style={{ bottom: `${(props.target.value / top) * 100}%` }}>
            <span>{props.target.label}</span>
          </div>
        ) : null}
        {values.map((v, i) => {
          const title = `${props.labelOf(i)} · ${format(v)}${props.onPick && props.pickHint ? ` · ${props.pickHint}` : ""}`;
          const body = (
            <>
              <span className="v" style={{ visibility: i === peak && v > 0 ? "visible" : "hidden" }}>
                {format(v)}
              </span>
              <span
                className="b"
                style={{
                  height: `${(v / top) * 100}%`,
                  minHeight: v > 0 ? 2 : 0,
                  maxWidth: props.maxBar ?? 28,
                  width: props.barWidth ?? "100%",
                  background: props.dim?.(i) ? "var(--v5)" : undefined,
                }}
              />
            </>
          );
          return props.onPick ? (
            <button key={i} className="vbar" title={title} onClick={() => props.onPick?.(i)}>
              {body}
            </button>
          ) : (
            <div key={i} className="vbar" title={title}>
              {body}
            </div>
          );
        })}
      </div>
      <div className="vbars-ticks">
        {values.map((_, i) => (
          <span key={i}>{props.tickOf(i)}</span>
        ))}
      </div>
    </div>
  );
}

export type RankRow = { id?: string; label: string; title?: string; value: number };

/**
 * Ranked rows with a thin ink bar under each label (Top-Kunden, Top-Tickets).
 * A row is a click target only when it carries an `id` and the caller picks;
 * the folded tail has no id and stays plain.
 */
export function RankRows(props: {
  rows: RankRow[];
  format?: (value: number) => string;
  empty?: ReactNode;
  activeId?: string;
  onPick?: (id: string) => void;
}) {
  const format = props.format ?? ((v: number) => nf.format(v));
  if (props.rows.length === 0) {
    return (
      <div className="table">
        <div className="empty-inline">{props.empty ?? "Keine Daten."}</div>
      </div>
    );
  }
  // All rows at zero would divide by zero; the floor keeps every bar at 0 %.
  const max = Math.max(1, ...props.rows.map((r) => r.value));
  return (
    <div className="table">
      {props.rows.map((r) => {
        const active = props.activeId !== undefined && props.activeId === r.id;
        const inner = (
          <>
            <span className="line">
              <span className="label">{r.label}</span>
              <span className="val">{format(r.value)}</span>
            </span>
            <span className="track">
              <span className="bar" style={{ width: `${(r.value / max) * 100}%` }} />
            </span>
          </>
        );
        const key = r.id ?? r.label;
        return props.onPick && r.id ? (
          <button
            key={key}
            className={`rank-row${active ? " active" : ""}`}
            title={r.title ?? r.label}
            onClick={() => props.onPick?.(r.id as string)}
          >
            {inner}
          </button>
        ) : (
          <div key={key} className="rank-row" title={r.title ?? r.label}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Part-to-whole on a soft card: the ring and a legend that carries every
 * label and number — the ring is never the only way to read a value.
 */
export function RingCard(props: {
  title: string;
  segments: { label: string; count: number }[];
  total: number;
  unit?: string;
  empty?: string;
}) {
  const { segments, total } = props;
  return (
    <div className="soft-card">
      <span className="card-title">{props.title}</span>
      {total === 0 ? (
        <span className="muted small">{props.empty ?? "Keine Tickets in dieser Liste."}</span>
      ) : (
        <div className="ring-wrap">
          <Ring segments={segments.map((s) => ({ label: s.label, value: s.count }))} total={nf.format(total)} unit={props.unit ?? "Tickets"} />
          <div className="ring-legend">
            {segments.map((s, i) => (
              <div key={s.label} className="ring-legend-row">
                <KeyDot index={i} />
                <span className="label">{s.label}</span>
                <span className="val">
                  {nf.format(s.count)}
                  <span className="muted"> · {total ? Math.round((s.count / total) * 100) : 0} %</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
