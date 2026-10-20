import type { CSSProperties, ReactNode } from "react";

/**
 * The building blocks of the redesign (docs/design/Agent-Portal-Redesign.dc.html).
 * Every view composes its page from these, so a pill, a tile or a section title
 * looks the same everywhere. The styles live in app.css under "kit".
 */

/** The agent's mark: a four-pointed sparkle. */
export const SPARK = "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 3v4M21 5h-4";
/** The sparkle alone, for small spots where the plus marks would crowd it. */
export const SPARK_SMALL = "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z";

export function Icon({ d, size = 16, stroke = 1.75, style }: { d: string; size?: number; stroke?: number; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none", ...style }}
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

/** Big page title with its subtitle on the left and the page's actions on the right. */
export function PageHeader(props: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        <h1>{props.title}</h1>
        {props.subtitle ? <span className="muted">{props.subtitle}</span> : null}
      </div>
      {props.children ? <div className="page-head-actions">{props.children}</div> : null}
    </div>
  );
}

/** A section heading (20px display) with optional note and controls on the right. */
export function SectionTitle(props: { title: string; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="section-title">
      <h2>{props.title}</h2>
      {props.note ? <span className="note">{props.note}</span> : null}
      {props.children ? <div className="section-title-aside">{props.children}</div> : null}
    </div>
  );
}

export type SegOption<T extends string> = { id: T; label: ReactNode; count?: ReactNode; title?: string };

/** The pill track: one choice out of a few, the active one in black. */
export function Segmented<T extends string>(props: {
  options: SegOption<T>[];
  value: T;
  onChange: (id: T) => void;
  small?: boolean;
  /** On a soft card the track turns white instead of grey. */
  onSoft?: boolean;
  label?: string;
}) {
  return (
    <div className={`seg${props.small ? " small" : ""}${props.onSoft ? " on-soft" : ""}`} role="tablist" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={o.id === props.value}
          className={`seg-item${o.id === props.value ? " active" : ""}`}
          onClick={() => props.onChange(o.id)}
          title={o.title}
        >
          {o.label}
          {o.count !== undefined ? <span className="count">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** On/off switch, 44×26. */
export function Switch(props: { on: boolean; onChange?: (on: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      disabled={props.disabled}
      className={`switch${props.on ? " on" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        props.onChange?.(!props.on);
      }}
    >
      <span className="knob" />
    </button>
  );
}

/** The square checkbox of the redesign. Purely visual; the caller handles the click. */
export function CheckBox(props: { on: boolean; size?: number }) {
  return (
    <span className={`checkbox${props.on ? " on" : ""}`} aria-hidden="true">
      {props.on ? <Icon d="M20 6 9 17l-5-5" size={props.size ?? 12} stroke={3} /> : null}
    </span>
  );
}

/** The agent's inline hint: black sparkle disc, one sentence, a couple of actions. */
export function AgentHint(props: { children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={`hint${props.className ? ` ${props.className}` : ""}`}>
      <span className="hint-icon">
        <Icon d={SPARK_SMALL} size={16} />
      </span>
      <div className="hint-text">{props.children}</div>
      {props.actions ? <div className="hint-actions">{props.actions}</div> : null}
    </div>
  );
}

/** A key figure on a soft card. */
export function Tile(props: { label: string; value: ReactNode; hint?: ReactNode; tone?: "danger" | "warn" | "ok" }) {
  return (
    <div className="tile">
      <span className="tile-label">{props.label}</span>
      <span className={`tile-value${props.tone ? ` ${props.tone}` : ""}`}>{props.value}</span>
      {props.hint ? <span className="tile-hint">{props.hint}</span> : null}
    </div>
  );
}

/** Coloured status dot: ok / warn / danger / flat (grey) / ink. */
export function Dot(props: { tone?: "ok" | "warn" | "danger" | "flat" | "ink"; size?: number }) {
  const size = props.size ?? 8;
  return <span className={`dot${props.tone && props.tone !== "ink" ? ` ${props.tone}` : ""}`} style={{ width: size, height: size }} />;
}

export type RingSegment = { label: string; value: number };

/** Donut as a conic gradient, series coloured along the ink ramp (--v1 … --v6). */
export function Ring(props: { segments: RingSegment[]; total: ReactNode; unit: string; size?: number }) {
  const sum = props.segments.reduce((a, s) => a + s.value, 0);
  let acc = 0;
  const stops = props.segments.map((s, i) => {
    const from = (acc / (sum || 1)) * 100;
    acc += s.value;
    const to = (acc / (sum || 1)) * 100;
    return `var(--v${Math.min(i, 5) + 1}) ${from}% ${to}%`;
  });
  const size = props.size ?? 132;
  return (
    <div
      className="ring"
      style={{ width: size, height: size, background: sum ? `conic-gradient(${stops.join(",")})` : "var(--pressed)" }}
      role="img"
      aria-label={props.segments.map((s) => `${s.label}: ${s.value}`).join(", ")}
    >
      <div className="ring-hole">
        <span className="ring-total">{props.total}</span>
        <span className="ring-unit">{props.unit}</span>
      </div>
    </div>
  );
}

/** Legend key for ring and bar series: slot i of the ink ramp. */
export function KeyDot({ index }: { index: number }) {
  return <span className="key-dot" style={{ background: `var(--v${Math.min(index, 5) + 1})` }} />;
}
