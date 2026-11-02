/**
 * Confirming one's own day in TANSS. The address is not in the published API;
 * the web interface uses it, so an answer it cannot read counts as "no duty"
 * and the portal simply shows nothing.
 */

export type DayStatus = {
  /** TANSS expects this employee to confirm their days. */
  mustConfirm: boolean;
  /** Days still open, oldest first; TANSS takes them in this order only. */
  openDays: string[];
};

export type DayConfirmState =
  | { kind: "none" }
  | { kind: "open" }
  | { kind: "blocked"; oldest: string }
  | { kind: "confirmed" };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function parseDayStatus(content: unknown): DayStatus {
  const raw = (content ?? {}) as { hasToConfirm?: unknown; notConfirmedDays?: unknown };
  if (raw.hasToConfirm !== true) return { mustConfirm: false, openDays: [] };
  const days = Array.isArray(raw.notConfirmedDays) ? raw.notConfirmedDays : [];
  return {
    mustConfirm: true,
    openDays: days.filter((d): d is string => typeof d === "string" && YMD.test(d)).sort(),
  };
}

/**
 * What the day sheet offers for `day`. TANSS only lists the open days, so a day
 * outside the list counts as confirmed only with bookings on it: a weekend
 * without any looks just the same.
 */
export function dayConfirmState(
  status: DayStatus | null,
  day: string,
  today: string,
  hasBookings: boolean,
): DayConfirmState {
  if (!status?.mustConfirm) return { kind: "none" };
  if (status.openDays.includes(day)) {
    const oldest = status.openDays[0];
    return oldest === day ? { kind: "open" } : { kind: "blocked", oldest };
  }
  return day <= today && hasBookings ? { kind: "confirmed" } : { kind: "none" };
}

/** The start page's line about forgotten days; today is still running and does not count. */
export function openDaysHint(status: DayStatus | null, today: string): { oldest: string; text: string } | null {
  if (!status?.mustConfirm) return null;
  const past = status.openDays.filter((d) => d < today);
  if (past.length === 0) return null;
  const oldest = past[0];
  const text =
    past.length === 1
      ? `Der ${shortYmd(oldest)} ist noch nicht bestätigt.`
      : `${past.length} Tage sind noch nicht bestätigt, der älteste ist der ${shortYmd(oldest)}`;
  return { oldest, text };
}

/** "2026-10-26" → "26.10." */
export function shortYmd(ymd: string): string {
  return `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.`;
}
