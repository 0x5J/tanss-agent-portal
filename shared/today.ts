import { ticketIdleDays, type Activity } from "./activity.ts";
import { berlinMinuteOfDay, berlinYmd } from "./days.ts";
import type { TicketRow } from "./tickets.ts";

/** The start page's greeting by Berlin time of day. */
export function greeting(minuteOfDay: number): string {
  if (minuteOfDay < 11 * 60) return "Guten Morgen";
  if (minuteOfDay < 18 * 60) return "Hallo";
  return "Guten Abend";
}

/** "Sören Jacobsen" → "Sören"; TANSS sometimes delivers "Jacobsen, Sören". */
export function firstName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (trimmed.includes(",")) return trimmed.split(",")[1]?.trim().split(/\s+/)[0] ?? "";
  return trimmed.split(/\s+/)[0];
}

/** The day-to-day tickets assigned to me — projects live on their own tab. */
export function ownOpen(rows: TicketRow[], employeeId: number): TicketRow[] {
  return rows.filter((row) => !row.isProject && row.assigneeId === employeeId);
}

function dueOf(row: TicketRow): number {
  return row.deadlineDate || row.dueDate;
}

export type DueState = "overdue" | "today" | "later" | "none";

export function dueState(row: TicketRow, nowUnix: number): DueState {
  const due = dueOf(row);
  if (!due) return "none";
  if (due < nowUnix) return "overdue";
  return berlinYmd(due) === berlinYmd(nowUnix) ? "today" : "later";
}

/** What is due by the end of today, the missed dates first, then by the hour. */
export function dueToday(rows: TicketRow[], nowUnix: number): TicketRow[] {
  return rows
    .filter((row) => {
      const state = dueState(row, nowUnix);
      return state === "overdue" || state === "today";
    })
    .sort((a, b) => dueOf(a) - dueOf(b) || a.id - b.id);
}

/** "seit 18.10." for a missed date, "bis 17:00" for one later today. */
export function dueLabel(row: TicketRow, nowUnix: number): string {
  const due = dueOf(row);
  if (!due) return "";
  const minute = berlinMinuteOfDay(due);
  const clock = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  if (due >= nowUnix) return `bis ${clock}`;
  const day = berlinYmd(due);
  if (day === berlinYmd(nowUnix)) return `seit ${clock}`;
  return `seit ${day.slice(8, 10)}.${day.slice(5, 7)}.`;
}

const RANK: Record<DueState, number> = { overdue: 0, today: 1, later: 2, none: 2 };

/**
 * My open tickets in the order they need me: missed dates, then today's, then
 * the longest without a trace. Without a known history the age stands in.
 */
export function byUrgency(
  rows: TicketRow[],
  activity: Record<number, Activity>,
  nowUnix: number,
  todayYmd: string,
  sinceYmd: string,
): TicketRow[] {
  const idle = (row: TicketRow) => {
    const a = activity[row.id];
    if (!a) return row.creationDate ? nowUnix - row.creationDate : 0;
    const days = ticketIdleDays(row.creationDate, a, todayYmd, sinceYmd);
    return days.at ? nowUnix - days.at : days.days * 86_400;
  };
  return [...rows].sort(
    (a, b) =>
      RANK[dueState(a, nowUnix)] - RANK[dueState(b, nowUnix)] ||
      (dueState(a, nowUnix) !== "none" && dueState(b, nowUnix) !== "none" ? dueOf(a) - dueOf(b) : 0) ||
      idle(b) - idle(a) ||
      b.id - a.id,
  );
}
