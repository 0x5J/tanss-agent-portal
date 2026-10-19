const TIME_ZONE = "Europe/Berlin";

export function berlinYmd(unixSeconds: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(unixSeconds * 1000));
}

export function berlinNoonUnix(ymd: string): number {
  return berlinInstantUnix(ymd, 12, 0, 0);
}

export function berlinDayRangeUnix(ymd: string): { from: number; to: number } {
  return {
    from: berlinInstantUnix(ymd, 0, 0, 0),
    to: berlinInstantUnix(ymd, 23, 59, 59),
  };
}

export function sumMinutesByDay(
  supports: { date: number; duration: number }[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const support of supports) {
    const day = berlinYmd(support.date);
    totals[day] = (totals[day] ?? 0) + support.duration;
  }
  return totals;
}

export function buildFourteenDayWindow(nowMs: number): string[] {
  const today = berlinYmd(Math.floor(nowMs / 1000));
  const days: string[] = [];
  for (let offset = -13; offset <= 0; offset++) {
    days.push(shiftYmd(today, offset));
  }
  return days;
}

export function shiftYmd(ymd: string, days: number): string {
  const noon = berlinNoonUnix(ymd);
  return berlinYmd(noon + days * 24 * 60 * 60);
}

const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const MONTHS = [
  "Januar",
  "Februar",
  "März",
  "April",
  "Mai",
  "Juni",
  "Juli",
  "August",
  "September",
  "Oktober",
  "November",
  "Dezember",
];

/** Minute of the Berlin day a support starts at — 9:30 becomes 570. */
export function berlinMinuteOfDay(unixSeconds: number): number {
  const parts = berlinClock(unixSeconds);
  return parts.hour * 60 + parts.minute;
}

/** The instant a given Berlin day reaches the given minute of the day. */
export function berlinUnixAtMinute(ymd: string, minuteOfDay: number): number {
  const safe = Math.max(0, Math.min(24 * 60 - 1, Math.round(minuteOfDay)));
  return berlinInstantUnix(ymd, Math.floor(safe / 60), safe % 60, 0);
}

/** 0 = Sunday … 6 = Saturday, evaluated in Berlin. */
export function berlinWeekday(ymd: string): number {
  const day = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: TIME_ZONE,
  }).format(new Date(berlinNoonUnix(ymd) * 1000));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(day);
}

export function isBerlinWeekend(ymd: string): boolean {
  const weekday = berlinWeekday(ymd);
  return weekday === 0 || weekday === 6;
}

export function weekdayLabel(ymd: string): string {
  return WEEKDAYS[berlinWeekday(ymd)] ?? "";
}

/** "Mi, 19. August 2026" — the heading form used across the day sheet. */
export function formatLongDate(ymd: string): string {
  const [year, month, day] = ymd.split("-");
  return `${weekdayLabel(ymd)}, ${Number(day)}. ${MONTHS[Number(month) - 1]} ${year}`;
}

/** "19.08.2026" — the compact form the ticket table needs in a cell. */
export function formatShortDate(ymd: string): string {
  const [year, month, day] = ymd.split("-");
  return `${day}.${month}.${year}`;
}

/** The Berlin Monday-to-Sunday week that contains the given day. */
export function berlinWeekDays(ymd: string): string[] {
  const mondayOffset = (berlinWeekday(ymd) + 6) % 7;
  const days: string[] = [];
  for (let index = 0; index < 7; index++) {
    days.push(shiftYmd(ymd, index - mondayOffset));
  }
  return days;
}

function berlinInstantUnix(
  ymd: string,
  hour: number,
  minute: number,
  second: number,
): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new Error("Ungültiges Datum");
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(hour)}:${pad(minute)}:${pad(second)}`;
  for (const offset of ["+02:00", "+01:00"]) {
    const unix = Math.floor(Date.parse(`${ymd}T${clock}${offset}`) / 1000);
    if (!Number.isFinite(unix)) continue;
    const parts = berlinClock(unix);
    if (
      parts.ymd === ymd &&
      parts.hour === hour &&
      parts.minute === minute &&
      parts.second === second
    ) {
      return unix;
    }
  }
  throw new Error(`Ungültige Berlin-Zeit ${ymd} ${clock}`);
}

function berlinClock(unixSeconds: number): {
  ymd: string;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(unixSeconds * 1000));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "0";
  const month = get("month");
  const day = get("day");
  return {
    ymd: `${get("year")}-${month}-${day}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
  };
}
