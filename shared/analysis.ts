import { berlinWeekDays, berlinYmd, isBerlinWeekend, shiftYmd, weekdayLabel } from "./days.ts";
import { DAY_TARGET, type Support } from "./timeline.ts";

/** A closed Berlin day range, both ends included. */
export type Range = { from: string; to: string };

export type Preset = "week" | "lastWeek" | "month" | "lastMonth" | "quarter" | "year";

export const PRESETS: { id: Preset; label: string }[] = [
  { id: "week", label: "Diese Woche" },
  { id: "lastWeek", label: "Letzte Woche" },
  { id: "month", label: "Dieser Monat" },
  { id: "lastMonth", label: "Letzter Monat" },
  { id: "quarter", label: "Quartal" },
  { id: "year", label: "Jahr" },
];

/**
 * A year of bookings is one TANSS call; more than that is neither needed nor
 * kind to the API. The route refuses beyond this, the presets stay below it.
 */
export const MAX_RANGE_DAYS = 366;

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1];
}

function firstOfMonth(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

function lastOfMonth(ymd: string): string {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(5, 7));
  return `${ymd.slice(0, 7)}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
}

/** Month arithmetic on the string, so no time zone can shift a day. */
function addMonths(ymd: string, delta: number): string {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(5, 7));
  const total = year * 12 + (month - 1) + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12) + 1;
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`;
}

export function presetRange(preset: Preset, today: string): Range {
  if (preset === "week" || preset === "lastWeek") {
    const week = berlinWeekDays(preset === "week" ? today : shiftYmd(today, -7));
    return { from: week[0], to: week[6] };
  }
  if (preset === "month") {
    return { from: firstOfMonth(today), to: lastOfMonth(today) };
  }
  if (preset === "lastMonth") {
    const previous = addMonths(firstOfMonth(today), -1);
    return { from: previous, to: lastOfMonth(previous) };
  }
  if (preset === "quarter") {
    const month = Number(today.slice(5, 7));
    const first = Math.floor((month - 1) / 3) * 3 + 1;
    const from = `${today.slice(0, 4)}-${String(first).padStart(2, "0")}-01`;
    return { from, to: lastOfMonth(addMonths(from, 2)) };
  }
  const year = today.slice(0, 4);
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/** The shape a Berlin day has to have before we walk a range with it. */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** True for a well-formed `YYYY-MM-DD`; says nothing about the calendar. */
export function isYmd(value: string): boolean {
  return YMD.test(value);
}

/**
 * Every Berlin day of the range, in order; empty when the range is reversed
 * or when an end is not a day at all. A date field hands over `""` while it
 * is being cleared or retyped, and `shiftYmd` would throw on that — one
 * render deep in a chart is no place to lose the whole page, so a range we
 * cannot walk simply has no days.
 */
export function rangeDays(range: Range): string[] {
  if (!YMD.test(range.from) || !YMD.test(range.to)) return [];
  if (range.from > range.to) return [];
  const days: string[] = [];
  for (let day = range.from; day <= range.to; day = shiftYmd(day, 1)) {
    days.push(day);
    // A guard, not a rule: the route refuses longer ranges before we get here.
    if (days.length > MAX_RANGE_DAYS + 1) break;
  }
  return days;
}

export function rangeLength(range: Range): number {
  return rangeDays(range).length;
}

export type BucketSize = "day" | "week" | "month";

/**
 * Bars must stay readable. Up to ten weeks one bar is one day; up to half a
 * year one bar is a week; beyond that a month. The thresholds sit below
 * MAX_RANGE_DAYS, so every allowed range has a resolution.
 */
export function bucketSize(range: Range): BucketSize {
  const days = rangeLength(range);
  if (days <= 70) return "day";
  if (days <= 180) return "week";
  return "month";
}

export type Slot = {
  /** Stable identity of the bucket — the day, its Monday, or "YYYY-MM". */
  key: string;
  label: string;
  /** The Berlin day the bar jumps to when clicked. */
  day: string;
  minutes: number;
  weekend: boolean;
};

function slotKey(day: string, size: BucketSize): string {
  if (size === "day") return day;
  if (size === "week") return berlinWeekDays(day)[0];
  return day.slice(0, 7);
}

function slotLabel(key: string, size: BucketSize): string {
  if (size === "day") return `${weekdayLabel(key)} ${key.slice(8)}.${key.slice(5, 7)}.`;
  if (size === "week") return `${key.slice(8)}.${key.slice(5, 7)}.`;
  return `${key.slice(5, 7)}/${key.slice(2, 4)}`;
}

/**
 * The bars of the range — every bucket present, empty ones included. Seeing
 * the empty days is the point of the chart, so they are never dropped.
 */
export function series(supports: Support[], range: Range, size: BucketSize): Slot[] {
  const slots: Slot[] = [];
  const index = new Map<string, number>();
  for (const day of rangeDays(range)) {
    const key = slotKey(day, size);
    if (index.has(key)) continue;
    index.set(key, slots.length);
    const bucketStart = size === "day" ? day : key.length === 7 ? `${key}-01` : key;
    slots.push({
      key,
      label: slotLabel(key, size),
      // Clamped to range.from: a click must land inside the evaluated range,
      // never on a Monday or month-first that sits before it.
      day: bucketStart < range.from ? range.from : bucketStart,
      minutes: 0,
      weekend: size === "day" ? isBerlinWeekend(day) : false,
    });
  }
  for (const support of supports) {
    const day = berlinYmd(support.date);
    if (day < range.from || day > range.to) continue;
    const at = index.get(slotKey(day, size));
    if (at === undefined) continue;
    slots[at].minutes += support.duration;
  }
  return slots;
}

export type GroupKey = "ticket" | "company" | "type";

export type Group = {
  id: string;
  label: string;
  /**
   * The most common booking text of the group. A booking carries no ticket
   * title, so this is the closest thing to "what was this about" we have; the
   * view shows it on hover.
   */
  hint: string;
  minutes: number;
  count: number;
  /** > 0 only for ticket groups — what a click opens in the drawer. */
  ticketId: number;
};

/** The folded tail carries this id; it is not a thing you can drill into. */
export const REST_ID = "rest";

function groupOf(support: Support, key: GroupKey): { id: string; label: string; ticketId: number } {
  if (key === "ticket") {
    // The booking carries no ticket title — number and customer are what we
    // honestly have; the drawer fetches the title when it opens.
    const label = support.ticketId
      ? `#${support.ticketId}${support.companyName ? ` · ${support.companyName}` : ""}`
      : "ohne Ticket";
    return { id: String(support.ticketId), label, ticketId: support.ticketId };
  }
  if (key === "company") {
    return { id: String(support.companyId), label: support.companyName || "ohne Kunde", ticketId: 0 };
  }
  return { id: String(support.typeId), label: support.typeName || "ohne Art", ticketId: 0 };
}

/**
 * The text used most often in a group; the longer one breaks a tie, and
 * between equally long ties the first one seen wins. Supports arrive
 * sorted by date, so that makes the oldest text the winner.
 */
function pickHint(texts: string[]): string {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const trimmed = text.trim();
    if (trimmed) counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [text, count] of counts) {
    if (count > bestCount || (count === bestCount && text.length > best.length)) {
      best = text;
      bestCount = count;
    }
  }
  return best;
}

export function groupBy(supports: Support[], key: GroupKey): Group[] {
  const collected = new Map<string, { group: Group; texts: string[] }>();
  for (const support of supports) {
    const { id, label, ticketId } = groupOf(support, key);
    const found = collected.get(id);
    if (found) {
      found.group.minutes += support.duration;
      found.group.count += 1;
      found.texts.push(support.text);
    } else {
      collected.set(id, {
        group: { id, label, hint: "", minutes: support.duration, count: 1, ticketId },
        texts: [support.text],
      });
    }
  }
  return [...collected.values()]
    .map(({ group, texts }) => ({ ...group, hint: pickHint(texts) }))
    .sort((a, b) => b.minutes - a.minutes || a.label.localeCompare(b.label, "de"));
}

/** What the view is drilled into; null is the whole range. */
export type Facet = { key: GroupKey; id: string } | null;

/**
 * The drill-down filter. The folded tail has no identity of its own, so a
 * facet on it changes nothing — the view does not offer that click either.
 */
export function applyFacet(supports: Support[], facet: Facet): Support[] {
  if (!facet || facet.id === REST_ID) return supports;
  return supports.filter((s) => groupOf(s, facet.key).id === facet.id);
}

export type Totals = {
  /** Everything booked in the range. */
  minutes: number;
  /** Not internal, minus what was marked as not charged. */
  billable: number;
  /** Marked as not charged on bookings that are not internal. */
  notCharged: number;
  internal: number;
  cleared: number;
  open: number;
  workdays: number;
  targetMinutes: number;
  /** Working days without a single booking — an observation, not a charge. */
  daysWithout: string[];
};

export function totals(supports: Support[], range: Range): Totals {
  const inRange = supports.filter((s) => {
    const day = berlinYmd(s.date);
    return day >= range.from && day <= range.to;
  });
  const minutes = inRange.reduce((n, s) => n + s.duration, 0);
  const internal = inRange.filter((s) => s.internal).reduce((n, s) => n + s.duration, 0);
  // Internal time is not billable anyway; counting its "not charged" share
  // again would subtract the same minutes twice.
  const notCharged = inRange
    .filter((s) => !s.internal)
    .reduce((n, s) => n + s.durationNotCharged, 0);
  const cleared = inRange
    .filter((s) => s.clearanceStatus === "CLEARED")
    .reduce((n, s) => n + s.duration, 0);
  const workdayList = rangeDays(range).filter((day) => !isBerlinWeekend(day));
  const booked = new Set(inRange.map((s) => berlinYmd(s.date)));
  return {
    minutes,
    billable: minutes - internal - notCharged,
    notCharged,
    internal,
    cleared,
    open: minutes - cleared,
    workdays: workdayList.length,
    targetMinutes: workdayList.length * DAY_TARGET,
    daysWithout: workdayList.filter((day) => !booked.has(day)),
  };
}

/** Top n plus one folded rest, so the bars stay countable and the sum holds. */
export function topWithRest(groups: Group[], limit: number): Group[] {
  if (groups.length <= limit) return groups;
  const head = groups.slice(0, limit);
  const tail = groups.slice(limit);
  return [
    ...head,
    {
      id: REST_ID,
      label: "übrige",
      hint: "",
      minutes: tail.reduce((n, g) => n + g.minutes, 0),
      count: tail.reduce((n, g) => n + g.count, 0),
      ticketId: 0,
    },
  ];
}
