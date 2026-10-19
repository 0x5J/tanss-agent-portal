import type { Support } from "./timeline.ts";

/**
 * Why a booking may not be changed any more. TANSS accepts the write and then
 * quietly breaks the accounting, so the portal refuses first and says why.
 */
export type LockReason = "booked" | "cleared" | "voucher" | "foreign";

export const LOCK_TEXT: Record<LockReason, string> = {
  booked: "Diese Leistung ist bereits abgerechnet.",
  cleared: "Diese Leistung ist freigegeben.",
  voucher: "Diese Leistung hängt an einem Beleg.",
  foreign: "Diese Leistung gehört einem anderen Mitarbeiter.",
};

/** The first reason that applies, or null when the booking is still editable. */
export function lockReason(support: Support, employeeId: number): LockReason | null {
  if (support.employeeId > 0 && support.employeeId !== employeeId) return "foreign";
  if (support.booked) return "booked";
  if (support.clearanceStatus === "CLEARED") return "cleared";
  if (support.voucherId > 0) return "voucher";
  return null;
}

export function lockText(reason: LockReason | null): string {
  return reason ? LOCK_TEXT[reason] : "";
}
