import { berlinYmd, formatShortDate, berlinMinuteOfDay } from "./days.ts";

export type Linked = Record<string, Record<string, Record<string, unknown>>>;

/** One row of the ticket table — what the UI needs, nothing it has to resolve. */
export type TicketRow = {
  id: number;
  title: string;
  companyId: number;
  companyName: string;
  projectId: number;
  projectName: string;
  statusId: number;
  statusName: string;
  typeName: string;
  assigneeId: number;
  assigneeName: string;
  departmentName: string;
  /** Unix seconds of the last change; 0 when TANSS does not say. */
  modified: number;
  creationDate: number;
  dueDate: number;
  deadlineDate: number;
  waiting: boolean;
  isProject: boolean;
  estimatedMinutes: number;
};

/** The tabs of the board: filter presets over the complete ticket set. */
export const LISTS = [
  { id: "own", label: "Meine offenen" },
  { id: "general", label: "Unzugewiesen" },
  { id: "waiting", label: "Wartet auf Kunde" },
  { id: "technician", label: "Techniker" },
  { id: "all", label: "Alle" },
  { id: "projects", label: "Projekte" },
] as const;

export type ListId = (typeof LISTS)[number]["id"];

/**
 * The half of the set a tab is about. Projects run for months and would
 * distort every operational list they appear in — the age chart, the counts,
 * "Alle". So they live on their own tab and nowhere else, and the other tabs
 * are about day-to-day tickets only.
 */
export function rowsForList(rows: TicketRow[], list: ListId): TicketRow[] {
  return rows.filter((row) => (list === "projects" ? row.isProject : !row.isProject));
}

function linkedName(linked: Linked, group: string, id: number): string {
  if (!id) return "";
  const entry = linked[group]?.[String(id)];
  if (!entry) return "";
  const name = entry.name ?? entry.title;
  return typeof name === "string" ? name : "";
}

export function toTicketRow(
  raw: Record<string, unknown>,
  linked: Linked,
  waitingStates: number[],
): TicketRow {
  const num = (key: string) => Number(raw[key] ?? 0) || 0;
  const statusId = num("statusId");
  const projectId = num("projectId");
  return {
    id: num("id"),
    title: String(raw.title ?? ""),
    companyId: num("companyId"),
    companyName: linkedName(linked, "companies", num("companyId")),
    projectId,
    projectName: linkedName(linked, "tickets", projectId),
    statusId,
    statusName: linkedName(linked, "ticketStates", statusId),
    typeName: linkedName(linked, "ticketTypes", num("typeId")),
    assigneeId: num("assignedToEmployeeId"),
    assigneeName: linkedName(linked, "employees", num("assignedToEmployeeId")),
    departmentName: linkedName(linked, "departments", num("assignedToDepartmentId")),
    modified: num("modified") || num("modifiedTime"),
    creationDate: num("creationDate"),
    dueDate: num("dueDate"),
    deadlineDate: num("deadlineDate"),
    waiting: waitingStates.includes(statusId),
    isProject: Boolean(raw.project),
    estimatedMinutes: num("estimatedMinutes"),
  };
}

/** Client-side filter over the visible columns. */
export function matchesQuery(row: TicketRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    `#${row.id}`,
    String(row.id),
    row.title,
    row.companyName,
    row.projectName,
    row.statusName,
    row.typeName,
    row.assigneeName,
  ]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((part) => haystack.includes(part));
}

/**
 * "08:12" for today, "20.08." for this year, "20.08.2025" otherwise — the
 * compact "Aktual." column of the board.
 */
export function formatUpdated(unixSeconds: number, nowUnix: number): string {
  if (!unixSeconds) return "—";
  const day = berlinYmd(unixSeconds);
  const today = berlinYmd(nowUnix);
  if (day === today) {
    const minute = berlinMinuteOfDay(unixSeconds);
    return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  }
  if (day.slice(0, 4) === today.slice(0, 4)) {
    return formatShortDate(day).slice(0, 6);
  }
  return formatShortDate(day);
}

/** Overdue outranks waiting: a missed date is the worse news. */
export type RowTone = "overdue" | "waiting" | "none";

export function rowTone(row: TicketRow, nowUnix: number): RowTone {
  const due = row.deadlineDate || row.dueDate;
  if (due && due < nowUnix) return "overdue";
  if (row.waiting) return "waiting";
  return "none";
}

export function sortRows(rows: TicketRow[]): TicketRow[] {
  return [...rows].sort((a, b) => b.modified - a.modified || b.id - a.id);
}
