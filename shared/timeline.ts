import { berlinMinuteOfDay, berlinYmd } from "./days.ts";

export type Support = {
  id: number;
  /** Unix seconds. */
  date: number;
  duration: number;
  ticketId: number;
  companyId: number;
  companyName: string;
  text: string;
  typeId: number;
  typeName: string;
  location: string;
  /** Whose booking it is; 0 when TANSS does not say. */
  employeeId: number;
  /** Already invoiced — never editable again. */
  booked: boolean;
  /** "CLEARED" means released for invoicing. */
  clearanceStatus: string;
  /** Attached to a voucher; > 0 locks the booking. */
  voucherId: number;
  /** Internal work, not shown to the customer. */
  internal: boolean;
  /** Minutes of the duration that are not charged. */
  durationNotCharged: number;
  reasonNotChargedText: string;
};

export type Block =
  | { kind: "support"; start: number; end: number; support: Support }
  | { kind: "gap"; start: number; end: number };

/** The visible window of the day chart, in minutes of the day. */
export const WINDOW_START = 7 * 60;
export const WINDOW_END = 19 * 60;
/** Gaps shorter than this are not worth a block. */
export const MIN_GAP = 15;
/** Bookings start on a quarter hour; nobody books at 9:07. */
export const SNAP_MINUTES = 15;
/** Where a booking starts on an empty day. */
export const DAY_START = 8 * 60;
/** A full working day and a full week, in minutes — the target lines. */
export const DAY_TARGET = 8 * 60;
export const WEEK_TARGET = 40 * 60;

export function snapMinute(minute: number): number {
  return Math.round(minute / SNAP_MINUTES) * SNAP_MINUTES;
}

/** Up to the next quarter hour — a start must never fall back into the last booking. */
export function ceilToSnap(minute: number): number {
  return Math.ceil(minute / SNAP_MINUTES) * SNAP_MINUTES;
}

/**
 * Where the next booking of the day most likely starts: after the last one,
 * on the next quarter hour. An empty day starts at eight.
 */
export function nextFreeStart(daySupports: Support[]): number {
  if (daySupports.length === 0) return DAY_START;
  const end = Math.max(...daySupports.map((s) => berlinMinuteOfDay(s.date) + s.duration));
  return Math.min(ceilToSnap(end), WINDOW_END - SNAP_MINUTES);
}

/** Keeps a booking inside the visible window without changing its length. */
export function clampStart(minute: number, duration: number): number {
  const latest = Math.max(0, WINDOW_END - duration);
  return Math.max(0, Math.min(minute, latest));
}

/**
 * The bookings a new one would overlap. Working two things at once is real, so
 * this is said out loud and never prevented — `ignoreId` leaves out the
 * booking that is being edited.
 */
export function findClashes(
  start: number,
  duration: number,
  daySupports: Support[],
  ignoreId = 0,
): Support[] {
  const end = start + duration;
  return daySupports.filter((s) => {
    if (s.id === ignoreId) return false;
    const from = berlinMinuteOfDay(s.date);
    return from < end && from + s.duration > start;
  });
}

export function supportsOfDay(supports: Support[], ymd: string): Support[] {
  return supports
    .filter((s) => berlinYmd(s.date) === ymd)
    .sort((a, b) => a.date - b.date || a.id - b.id);
}

/**
 * Supports of one day as blocks plus the gaps between them inside the window.
 * Overlaps are left as they are — parallel work is booked in parallel.
 */
export function buildBlocks(daySupports: Support[]): Block[] {
  const blocks: Block[] = daySupports.map((support) => {
    const start = berlinMinuteOfDay(support.date);
    return { kind: "support", start, end: start + support.duration, support };
  });
  const gaps: Block[] = [];
  let cursor = WINDOW_START;
  for (const block of [...blocks].sort((a, b) => a.start - b.start)) {
    if (block.start - cursor >= MIN_GAP && block.start > WINDOW_START) {
      gaps.push({ kind: "gap", start: Math.max(cursor, WINDOW_START), end: block.start });
    }
    cursor = Math.max(cursor, block.end);
  }
  if (blocks.length && WINDOW_END - cursor >= MIN_GAP && cursor < WINDOW_END) {
    gaps.push({ kind: "gap", start: cursor, end: WINDOW_END });
  }
  return [...blocks, ...gaps];
}

export function sumMinutes(supports: Support[]): number {
  return supports.reduce((sum, s) => sum + s.duration, 0);
}

/** "2,25 h" — decimal hours the way the design writes them. */
export function formatHours(minutes: number): string {
  return `${(minutes / 60).toFixed(2).replace(".", ",")} h`;
}

export function formatClock(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function toSupport(
  raw: Record<string, unknown>,
  linked: Record<string, Record<string, Record<string, unknown>>>,
): Support {
  const companyId = Number(raw.companyId ?? 0) || 0;
  const typeId = Number(raw.typeId ?? 0) || 0;
  const name = (group: string, id: number) => {
    const entry = linked[group]?.[String(id)];
    const value = entry?.name;
    return typeof value === "string" ? value : "";
  };
  return {
    id: Number(raw.id ?? 0) || 0,
    date: Number(raw.date ?? 0) || 0,
    duration: Number(raw.duration ?? 0) || 0,
    ticketId: Number(raw.ticketId ?? 0) || 0,
    companyId,
    companyName: name("companies", companyId),
    text: String(raw.text ?? ""),
    typeId,
    typeName: name("supportTypes", typeId),
    location: String(raw.location ?? ""),
    employeeId: Number(raw.employeeId ?? 0) || 0,
    booked: raw.booked === true,
    clearanceStatus: String(raw.clearanceStatus ?? ""),
    voucherId: Number(raw.voucherId ?? 0) || 0,
    internal: raw.internal === true,
    durationNotCharged: Number(raw.durationNotCharged ?? 0) || 0,
    reasonNotChargedText: String(raw.reasonNotChargedText ?? ""),
  };
}
