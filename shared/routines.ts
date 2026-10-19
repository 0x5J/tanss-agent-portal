/**
 * Work that recurs but leaves no trace: reading mail, watching monitoring,
 * triaging the queue. It never shows up in a ticket history, so nothing can
 * derive it — the list is kept by hand. The duration is a *range*, because
 * "mail" is twenty minutes on one day and an hour on the next.
 */
export type Routine = {
  id: string;
  text: string;
  minMinutes: number;
  maxMinutes: number;
  /** Where it is booked; null means the target is picked each time. */
  companyId: number | null;
  companyLabel: string;
  ticketId: number | null;
  ticketLabel: string;
  /** null keeps whatever the booking form already has. */
  typeId: number | null;
};

export const MAX_ROUTINES = 20;
export const MAX_ROUTINE_MINUTES = 8 * 60;

/** A range that came in the wrong way round is corrected, not rejected. */
export function normaliseRange(min: number, max: number): { minMinutes: number; maxMinutes: number } {
  const clamp = (n: number) => Math.max(1, Math.min(MAX_ROUTINE_MINUTES, Math.round(n) || 1));
  const a = clamp(min);
  const b = clamp(max);
  return { minMinutes: Math.min(a, b), maxMinutes: Math.max(a, b) };
}

/**
 * How long this routine would run in a gap of `gapMinutes` — as much as it
 * may take, but never longer than the gap. Null when the gap is too short to
 * hold even the shortest form of it.
 */
export function durationForGap(routine: Routine, gapMinutes: number): number | null {
  if (gapMinutes < routine.minMinutes) return null;
  return Math.min(routine.maxMinutes, gapMinutes);
}

/** The routines worth offering for a gap of that length. */
export function routinesForGap(routines: Routine[], gapMinutes: number): Routine[] {
  return routines.filter((r) => durationForGap(r, gapMinutes) !== null);
}

/**
 * What the server keeps and what stays here. A routine without text is not
 * one yet — the server drops it by design, so a row that is still being
 * filled in has to survive the round trip locally.
 */
export function splitRoutines(routines: Routine[]): { complete: Routine[]; pending: Routine[] } {
  return {
    complete: routines.filter((r) => r.text.trim() !== ""),
    pending: routines.filter((r) => r.text.trim() === ""),
  };
}

/** The saved list plus the rows the user is still typing into. */
export function mergeSavedRoutines(saved: Routine[], pending: Routine[]): Routine[] {
  const known = new Set(saved.map((r) => r.id));
  return [...saved, ...pending.filter((r) => !known.has(r.id))];
}

export function newRoutineId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Tolerant reader for what was stored or sent — a broken entry is dropped. */
export function parseRoutines(raw: unknown): Routine[] {
  if (!Array.isArray(raw)) return [];
  const routines: Routine[] = [];
  for (const item of raw.slice(0, MAX_ROUTINES)) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!text) continue;
    const range = normaliseRange(Number(r.minMinutes ?? 0) || 1, Number(r.maxMinutes ?? 0) || 1);
    const ticketId = Number(r.ticketId ?? 0) || 0;
    const companyId = Number(r.companyId ?? 0) || 0;
    routines.push({
      id: typeof r.id === "string" && r.id ? r.id : newRoutineId(),
      text: text.slice(0, 500),
      ...range,
      // A routine points at one target or none — never at both.
      ticketId: ticketId > 0 ? ticketId : null,
      ticketLabel: ticketId > 0 ? String(r.ticketLabel ?? "").slice(0, 200) : "",
      companyId: ticketId > 0 || companyId <= 0 ? null : companyId,
      companyLabel: ticketId > 0 || companyId <= 0 ? "" : String(r.companyLabel ?? "").slice(0, 200),
      typeId: Number(r.typeId ?? 0) > 0 ? Number(r.typeId) : null,
    });
  }
  return routines;
}
