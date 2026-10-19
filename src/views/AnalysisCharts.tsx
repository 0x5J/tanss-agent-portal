import { useRef, useState } from "react";
import type { Slot } from "../../shared/analysis.ts";
import { formatHours } from "../../shared/timeline.ts";

/**
 * One bar per bucket, with the target as a line across. Empty buckets keep
 * their slot — a day without a booking is the thing you came here to see.
 *
 * `targetPerSlot` is drawn only when a bucket has one honest target. A day
 * does (eight hours); a week or a month does not, because how many working
 * days it holds varies — so above the daily resolution the line stays away
 * rather than inventing a number.
 */
export function TimeBars(props: { slots: Slot[]; targetPerSlot?: number; onPick?: (day: string) => void }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  if (props.slots.length === 0) {
    return <div className="small muted" style={{ padding: "18px 0" }}>Keine Buchungen in diesem Zeitraum.</div>;
  }
  const width = 900;
  const height = 220;
  const pad = { left: 34, right: 8, top: 10, bottom: 26 };
  const max = Math.max(props.targetPerSlot ?? 0, ...props.slots.map((s) => s.minutes), 60);
  const slot = (width - pad.left - pad.right) / props.slots.length;
  const plot = height - pad.top - pad.bottom;
  const y = (minutes: number) => pad.top + plot - (plot * minutes) / max;
  // A tick every so many bars, so the axis never turns into a smear.
  const every = Math.max(1, Math.ceil(props.slots.length / 14));

  function show(event: React.MouseEvent, s: Slot) {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTip({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top - 28,
      text: `${s.label} · ${formatHours(s.minutes)}`,
    });
  }

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Gebuchte Zeit über den Zeitraum" onMouseLeave={() => setTip(null)}>
        <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} stroke="var(--viz-axis)" />
        {props.targetPerSlot ? (
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={y(props.targetPerSlot)}
            y2={y(props.targetPerSlot)}
            stroke="var(--warn)"
            strokeDasharray="4 4"
          />
        ) : null}
        <text x={pad.left - 6} y={y(max) + 9} fontSize="9" textAnchor="end" fill="var(--text2)">
          {formatHours(max)}
        </text>
        {props.slots.map((s, i) => {
          const x = pad.left + i * slot;
          const top = y(s.minutes);
          return (
            <g key={s.key}>
              {/*
                The hit target, not the bar: a day without a booking draws a
                rect of height 0, which is neither painted nor pointable — and
                the empty days are exactly the ones worth clicking. So every
                slot gets a transparent rect over the full plot height behind
                the bar, and the bar itself stays out of the way of events.
              */}
              <rect
                x={x}
                y={pad.top}
                width={slot}
                height={plot}
                fill="transparent"
                style={{ cursor: props.onPick ? "pointer" : undefined }}
                onMouseMove={(event) => show(event, s)}
                onClick={() => props.onPick?.(s.day)}
              />
              <rect
                x={x + slot * 0.15}
                y={top}
                width={slot * 0.7}
                height={Math.max(0, y(0) - top)}
                rx="2"
                fill={s.weekend ? "var(--viz-dim)" : "var(--viz-1)"}
                pointerEvents="none"
              />
              {i % every === 0 ? (
                <text x={x + slot / 2} y={height - 8} fontSize="9" textAnchor="middle" fill="var(--text2)">
                  {s.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {tip ? (
        <div className="viz-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      ) : null}
    </div>
  );
}
