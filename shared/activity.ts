import { berlinNoonUnix, berlinYmd } from "./days.ts";

/** What last happened in a ticket. "none" means nothing was found at all. */
export type ActivityKind = "support" | "comment" | "none";

export type Activity = {
  /** Unix seconds of the last comment or support; 0 when none was found. */
  at: number;
  kind: ActivityKind;
  /**
   * True when the ticket's own history was read. The history has no time
   * window, so "nothing found" is then a fact rather than a blind spot.
   */
  historyRead: boolean;
};

/**
 * Days of inactivity. `atLeast` says the true number is only bounded from
 * below — the fallback lookup has a fixed window and the ticket is older.
 */
export type Idle = {
  days: number;
  atLeast: boolean;
  /**
   * Unix seconds the idleness started at — the last trace, or the creation
   * when there was never one. 0 where only a lower bound exists: then there
   * is no moment to point at, and the display stays day-coarse.
   */
  at: number;
};

export const ACTIVITY_LOOKBACK_DAYS = 365;

export function daysBetween(fromYmd: string, toYmd: string): number {
  const day = 24 * 60 * 60;
  return Math.round((berlinNoonUnix(toYmd) - berlinNoonUnix(fromYmd)) / day);
}

export function ticketAgeDays(createdAt: number, todayYmd: string): number {
  if (createdAt <= 0) return 0;
  return Math.max(0, daysBetween(berlinYmd(createdAt), todayYmd));
}

export function ticketIdleDays(
  createdAt: number,
  activity: Activity,
  todayYmd: string,
  sinceYmd: string,
): Idle {
  if (activity.at > 0) {
    return { days: Math.max(0, daysBetween(berlinYmd(activity.at), todayYmd)), atLeast: false, at: activity.at };
  }
  const created = createdAt > 0 ? berlinYmd(createdAt) : "";
  // Where the history was read, "never touched" is the truth: idle = age.
  if (activity.historyRead && created) {
    return { days: Math.max(0, daysBetween(created, todayYmd)), atLeast: false, at: createdAt };
  }
  // Fallback only: the windowed lookup found nothing. Younger than the window
  // means idle since creation; older means we can only give a lower bound.
  if (created && daysBetween(sinceYmd, created) >= 0) {
    return { days: Math.max(0, daysBetween(created, todayYmd)), atLeast: false, at: createdAt };
  }
  return { days: Math.max(0, daysBetween(sinceYmd, todayYmd)), atLeast: true, at: 0 };
}

/**
 * The newest comment and the newest support of one ticket history. Mails are
 * in the same answer but do not count — a mail is neither a comment nor a
 * booked hour.
 */
export function historyActivity(content: Record<string, unknown>): Activity {
  const comment = newestDate(content.comments);
  const support = newestDate(content.supports);
  if (comment <= 0 && support <= 0) return { at: 0, kind: "none", historyRead: true };
  // A tie goes to the comment — the write-up usually follows the work.
  return comment >= support
    ? { at: comment, kind: "comment", historyRead: true }
    : { at: support, kind: "support", historyRead: true };
}

/** Newest support per ticket from a bulk support list, by anyone. */
export function supportActivity(supports: Record<string, unknown>[]): Map<number, number> {
  const latest = new Map<number, number>();
  for (const support of supports) {
    const ticketId = Number(support.ticketId ?? 0);
    const at = Number(support.date ?? 0);
    if (ticketId <= 0 || at <= 0) continue;
    if (at > (latest.get(ticketId) ?? 0)) latest.set(ticketId, at);
  }
  return latest;
}

/**
 * Seconds since `fromUnix` — the exact distance, for sorting. Unknown and
 * future timestamps are 0: a clock skew is not a negative age.
 */
export function elapsedSeconds(fromUnix: number, nowUnix: number): number {
  if (fromUnix <= 0) return 0;
  return Math.max(0, nowUnix - fromUnix);
}

/**
 * Elapsed time in the coarsest unit that still says something: minutes up to
 * an hour, hours up to a day, then days. Always rounded down — "1 h" for 90
 * minutes claims less than it knows, which is the safer direction.
 */
export function formatElapsed(fromUnix: number, nowUnix: number): string {
  if (fromUnix <= 0) return "—";
  const seconds = elapsedSeconds(fromUnix, nowUnix);
  if (seconds < 60) return "jetzt";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} h`;
  return `${Math.floor(seconds / 86_400)} d`;
}

export function activityLabel(kind: ActivityKind): string {
  if (kind === "support") return "Leistung";
  if (kind === "comment") return "Kommentar";
  return "keine Spur";
}

function newestDate(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let newest = 0;
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const at = Number((item as Record<string, unknown>).date ?? 0);
    if (at > newest) newest = at;
  }
  return newest;
}
