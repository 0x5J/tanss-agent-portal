import type { Slot } from "../../shared/analysis.ts";
import { formatHours } from "../../shared/timeline.ts";
import { VBars } from "../ui/charts.tsx";

/**
 * One bar per bucket, with the target as a dashed line across. Empty buckets
 * keep their slot — a day without a booking is the thing you came here to see.
 *
 * `targetPerSlot` is drawn only when a bucket has one honest target. A day
 * does (eight hours); a week or a month does not, because how many working
 * days it holds varies — so above the daily resolution the line stays away
 * rather than inventing a number.
 */
export function TimeBars(props: { slots: Slot[]; targetPerSlot?: number; onPick?: (day: string) => void }) {
  const { slots } = props;
  // A tick every so many bars, so the axis never turns into a smear.
  const every = Math.max(1, Math.ceil(slots.length / 14));
  return (
    <VBars
      values={slots.map((s) => s.minutes)}
      labelOf={(i) => slots[i].label}
      tickOf={(i) => (i % every === 0 ? slots[i].label : "")}
      format={formatHours}
      height={220}
      maxBar={36}
      barWidth="70%"
      dim={(i) => slots[i].weekend}
      minScale={60}
      target={props.targetPerSlot ? { value: props.targetPerSlot, label: `Soll ${hoursShort(props.targetPerSlot)}` } : undefined}
      onPick={props.onPick ? (i) => props.onPick?.(slots[i].day) : undefined}
      pickHint="Tag öffnen"
      empty="Keine Buchungen in diesem Zeitraum."
      ariaLabel="Gebuchte Zeit über den Zeitraum"
    />
  );
}

/** "8 h", "7,5 h" — the target reads as a round figure, not "8,00 h". */
function hoursShort(minutes: number): string {
  return `${String(Math.round((minutes / 60) * 100) / 100).replace(".", ",")} h`;
}
