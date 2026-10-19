import type { ListId, TicketRow } from "./tickets.ts";
import { LISTS } from "./tickets.ts";

export const FILTER_COLUMNS = [
  { key: "company", label: "Kunde" },
  { key: "status", label: "Status" },
  { key: "type", label: "Typ" },
  { key: "assignee", label: "Zuständig" },
  { key: "department", label: "Abteilung" },
] as const;

export type FilterKey = (typeof FILTER_COLUMNS)[number]["key"];

/** Selected values per column; an empty array means "alle". */
export type ColumnFilters = Record<FilterKey, string[]>;

export const EMPTY_FILTERS: ColumnFilters = {
  company: [],
  status: [],
  type: [],
  assignee: [],
  department: [],
};

/** A saved filter set, shown as its own tab next to the fixed lists. */
export type SavedView = {
  id: string;
  name: string;
  list: ListId;
  filters: ColumnFilters;
};

export const NO_VALUE = "—";
export const OPEN = "offen";

/** The value of a row in a column, as the filter sees it. */
export function columnValue(row: TicketRow, key: FilterKey): string {
  switch (key) {
    case "company":
      return row.companyName || NO_VALUE;
    case "status":
      return row.statusName || NO_VALUE;
    case "type":
      return row.typeName || NO_VALUE;
    case "assignee":
      // What the column shows: the employee, an unlinked id, or "offen".
      if (row.assigneeName) return row.assigneeName;
      if (row.assigneeId) return `#${row.assigneeId}`;
      return OPEN;
    case "department":
      return row.departmentName || NO_VALUE;
  }
}

/** Distinct values per column, sorted, with counts — what the dropdown offers. */
export function columnOptions(rows: TicketRow[], key: FilterKey): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = columnValue(row, key);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    // The "no value" entry goes last, whatever the locale thinks of a dash.
    .sort((a, b) =>
      a.value === NO_VALUE ? 1 : b.value === NO_VALUE ? -1 : a.value.localeCompare(b.value, "de"),
    );
}

export function applyFilters(rows: TicketRow[], filters: ColumnFilters): TicketRow[] {
  return rows.filter((row) =>
    FILTER_COLUMNS.every(({ key }) => {
      const wanted = filters[key];
      return wanted.length === 0 || wanted.includes(columnValue(row, key));
    }),
  );
}

export function hasFilters(filters: ColumnFilters): boolean {
  return FILTER_COLUMNS.some(({ key }) => filters[key].length > 0);
}

export function toggleValue(filters: ColumnFilters, key: FilterKey, value: string): ColumnFilters {
  const current = filters[key];
  return {
    ...filters,
    [key]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
  };
}

/** Tolerant reader for what was stored — a broken entry is dropped, not thrown. */
export function parseSavedViews(raw: unknown, lists: readonly string[]): SavedView[] {
  if (!Array.isArray(raw)) return [];
  const views: SavedView[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const v = item as Record<string, unknown>;
    if (typeof v.id !== "string" || typeof v.name !== "string" || !v.name.trim()) continue;
    if (typeof v.list !== "string" || !lists.includes(v.list)) continue;
    const f = (typeof v.filters === "object" && v.filters !== null ? v.filters : {}) as Record<string, unknown>;
    const filters = { ...EMPTY_FILTERS };
    for (const { key } of FILTER_COLUMNS) {
      const values = f[key];
      filters[key] = Array.isArray(values) ? values.filter((x): x is string => typeof x === "string") : [];
    }
    views.push({ id: v.id, name: v.name.trim(), list: v.list as ListId, filters });
  }
  return views;
}

/**
 * What a tab means, spelled out as filter values over the loaded rows — so
 * "Meine offenen" is visibly "Zuständig = <mein Name>" and can be loosened.
 */
export function presetFilters(
  list: ListId,
  rows: TicketRow[],
  me: { id: number; name: string },
): ColumnFilters {
  const mine = rows.find((r) => r.assigneeId === me.id);
  const myValue = me.name || (mine ? columnValue(mine, "assignee") : me.id ? `#${me.id}` : "");
  switch (list) {
    case "own":
      return { ...EMPTY_FILTERS, assignee: myValue ? [myValue] : [] };
    case "general":
      return { ...EMPTY_FILTERS, assignee: [OPEN] };
    case "waiting":
      return {
        ...EMPTY_FILTERS,
        status: [...new Set(rows.filter((r) => r.waiting).map((r) => columnValue(r, "status")))],
      };
    case "technician":
      return {
        ...EMPTY_FILTERS,
        assignee: [
          ...new Set(
            rows
              .filter((r) => r.assigneeId && r.assigneeId !== me.id)
              .map((r) => columnValue(r, "assignee")),
          ),
        ],
      };
    case "all":
    case "projects":
      // The projects tab is defined by `rowsForList`, not by a column value —
      // it shows every project, unfiltered.
      return EMPTY_FILTERS;
  }
}

export const LIST_IDS: readonly string[] = LISTS.map((l) => l.id);
