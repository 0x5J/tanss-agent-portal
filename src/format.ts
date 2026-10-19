import { berlinMinuteOfDay, berlinYmd, formatShortDate } from "../shared/days.ts";
import { formatClock } from "../shared/timeline.ts";

/** "20.08. 14:22" — a timestamp a person can compare with TANSS. */
export function dayAndClock(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  return `${formatShortDate(berlinYmd(unixSeconds)).slice(0, 6)} ${formatClock(berlinMinuteOfDay(unixSeconds))}`;
}

export function fullDate(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  return formatShortDate(berlinYmd(unixSeconds));
}

export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

export function todayYmd(): string {
  return berlinYmd(nowUnix());
}

export function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
