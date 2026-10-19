const nf = new Intl.NumberFormat("de-DE");

export const VIZ_SLOTS = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)", "var(--viz-6)"];

export function StatTile(props: { label: string; value: string; hint?: string; tone?: "danger" | "warn" }) {
  return (
    <div className="stat-tile">
      <div className="tiny muted">{props.label}</div>
      <div className="stat-value" style={props.tone ? { color: `var(--${props.tone})` } : undefined}>
        {props.value}
      </div>
      {props.hint ? <div className="tiny muted">{props.hint}</div> : null}
    </div>
  );
}

export function HBars(props: {
  rows: { id?: string; label: string; title?: string; count: number }[];
  format?: (value: number) => string;
  empty?: string;
  onPick?: (id: string) => void;
  activeId?: string;
  valueWidth?: number;
}) {
  const format = props.format ?? ((value: number) => nf.format(value));
  const valueWidth = props.valueWidth ?? 32;
  if (props.rows.length === 0) {
    return <div className="small muted" style={{ padding: "18px 0" }}>{props.empty ?? "Keine Tickets in dieser Liste."}</div>;
  }
  // All rows at zero would divide by zero and hand every bar a width of
  // "NaN%". Bookings of zero minutes make that reachable, so the floor of 1
  // keeps the arithmetic honest: every bar then draws at zero width.
  const max = Math.max(1, ...props.rows.map((r) => r.count));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 2 }}>
      {props.rows.map((r) => {
        const pick = props.onPick && r.id ? () => props.onPick?.(r.id as string) : undefined;
        return (
          <div
            key={r.id ?? r.label}
            className="row"
            style={{ gap: 8, cursor: pick ? "pointer" : undefined, opacity: props.activeId && props.activeId !== r.id ? 0.5 : 1 }}
            onClick={pick}
          >
            <span className="small ellipsis" style={{ flex: "none", width: 150 }} title={r.title ?? r.label}>
              {r.label}
            </span>
            <span className="hbar-track">
              <span className="hbar" style={{ width: `${(r.count / max) * 100}%` }} />
            </span>
            <span className="small mono muted" style={{ flex: "none", width: valueWidth, textAlign: "right" }}>
              {format(r.count)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Part-to-whole at a glance, max six segments (the tail is already folded).
 * The legend carries every label and number — the donut is never the only
 * way to read a value.
 *
 * Picking works like it does in `HBars`: a segment is a click target only
 * when it carries an `id` and the caller wants picks. Callers that pass
 * neither render exactly as before — no cursor, no dimming, no handler.
 */
export function DonutCard(props: {
  title: string;
  segments: { id?: string; label: string; count: number }[];
  total: number;
  format?: (value: number) => string;
  unit?: string;
  empty?: string;
  centerFontSize?: number;
  onPick?: (id: string) => void;
  activeId?: string;
}) {
  const format = props.format ?? ((value: number) => nf.format(value));
  const unit = props.unit ?? "Tickets";
  const centerFontSize = props.centerFontSize ?? 26;
  const { segments, total } = props;
  const r = 64;
  const cx = 85;
  const cy = 85;
  const gapAngle = total > 0 ? Math.min(0.06, (2 * Math.PI * 0.02) / Math.max(segments.length, 1)) : 0;
  let angle = -Math.PI / 2;
  const arcs = segments.map((s, i) => {
    const sweep = total > 0 ? (s.count / total) * 2 * Math.PI : 0;
    const from = angle + gapAngle / 2;
    const to = angle + sweep - gapAngle / 2;
    angle += sweep;
    return { ...s, from, to: Math.max(from, to), color: VIZ_SLOTS[i % VIZ_SLOTS.length] };
  });
  const { onPick, activeId } = props;
  const pickOf = (id: string | undefined) => (onPick && id ? () => onPick(id) : undefined);
  // Undefined, not 1: a caller without a facet must not even get the
  // attribute, so its markup stays byte-for-byte what it was.
  const dimOf = (id: string | undefined) => (activeId && activeId !== id ? 0.5 : undefined);
  return (
    <div className="viz-card">
      <div className="viz-title" style={{ marginBottom: 8 }}>{props.title}</div>
      {total === 0 ? (
        <div className="small muted" style={{ padding: "18px 0" }}>
          {props.empty ?? "Keine Tickets in dieser Liste."}
        </div>
      ) : (
        <div className="row" style={{ gap: 16, alignItems: "center" }}>
          <svg width="170" height="170" viewBox="0 0 170 170" role="img" aria-label={props.title}>
            {arcs.map((a) => (
              <path
                key={a.label}
                d={arcPath(cx, cy, r, a.from, a.to)}
                fill="none"
                stroke={a.color}
                strokeWidth="18"
                strokeLinecap="butt"
                opacity={dimOf(a.id)}
                style={pickOf(a.id) ? { cursor: "pointer" } : undefined}
                onClick={pickOf(a.id)}
              >
                <title>{`${a.label}: ${format(a.count)}`}</title>
              </path>
            ))}
            <text x={cx} y={cy - 2} textAnchor="middle" fontSize={centerFontSize} fontWeight="600" fill="var(--text)">
              {format(total)}
            </text>
            <text x={cx} y={cy + 17} textAnchor="middle" fontSize="11" fill="var(--text2)">
              {unit}
            </text>
          </svg>
          <div className="donut-legend">
            {arcs.map((a) => (
              <div
                key={a.label}
                className="row"
                style={{ gap: 6, cursor: pickOf(a.id) ? "pointer" : undefined, opacity: dimOf(a.id) }}
                onClick={pickOf(a.id)}
              >
                <span className="viz-key" style={{ background: a.color }} />
                <span className="small ellipsis" style={{ minWidth: 0 }}>{a.label}</span>
                <span className="small mono muted" style={{ marginLeft: "auto" }}>
                  {format(a.count)} · {total ? Math.round((a.count / total) * 100) : 0}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const large = to - from > Math.PI ? 1 : 0;
  const x0 = cx + r * Math.cos(from);
  const y0 = cy + r * Math.sin(from);
  const x1 = cx + r * Math.cos(to);
  const y1 = cy + r * Math.sin(to);
  // A full circle collapses to nothing as one arc — draw it as two halves.
  if (to - from >= 2 * Math.PI - 0.001) {
    const xm = cx + r * Math.cos(from + Math.PI);
    const ym = cy + r * Math.sin(from + Math.PI);
    return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${xm} ${ym} A ${r} ${r} 0 0 1 ${x0} ${y0}`;
  }
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}
