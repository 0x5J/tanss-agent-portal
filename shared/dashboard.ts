import { ticketAgeDays } from "./activity.ts";
import { berlinMinuteOfDay, berlinWeekday, berlinYmd, shiftYmd } from "./days.ts";
import { applyFilters, columnValue, presetFilters, type FilterKey, type SavedView } from "./filters.ts";
import { LISTS, type ListId, type TicketRow } from "./tickets.ts";

/**
 * The dashboard counts tickets per list over the day. A "list" is either one
 * of the fixed board tabs or a saved view; both are addressed by a ListKey so
 * samples survive renames.
 */
export type ListKey = string;

export type DashboardSample = {
  /** Berlin minute of the day (0–1439). */
  minute: number;
  counts: Record<ListKey, number>;
};

/** A ticket changing hands: unassigned → someone, or someone → someone else. */
export type Claim = {
  id: number;
  title: string;
  /** Berlin minute of the day the change was first measured. */
  minute: number;
  assigneeId: number;
  assigneeName: string;
  /** 0 = was unassigned before. */
  fromId: number;
  fromName: string;
};

/**
 * One takeover, kept for good. The day's measurement file forgets after two
 * weeks; this is the running history, so "who took which ticket" survives the
 * next morning. The lists a ticket belonged to at that moment travel with it,
 * because the day's membership set is not kept forever either.
 */
export type ClaimEntry = Claim & { day: string; lists: ListKey[] };

export type DashboardDay = {
  /** Berlin day, YYYY-MM-DD. */
  day: string;
  samples: DashboardSample[];
  /**
   * Every ticket the list contained at any sample of the day, id → creation
   * date (unix seconds). This keeps tickets countable that were closed before
   * evening — the open-ticket lists alone would forget them.
   */
  seen: Record<ListKey, Record<string, number>>;
  /** Assignee changes measured this day, in order. */
  claims: Claim[];
  /** Last known assignee per board ticket (0 = unassigned) — the diff base. */
  assignees: Record<string, number>;
  /** Employee names seen on the board, for naming the "from" side. */
  names: Record<string, string>;
};

/** What the background collector is doing — shown in the dashboard. */
export type CollectorHealth = {
  /** Unix seconds of the last stored measurement; 0 when there was none. */
  lastSampleAt: number;
  /** Why the last measurement failed; empty when it worked. */
  lastError: string;
  /** Consecutive failed measurements. */
  failures: number;
  /** Consecutive failed automatic logins. */
  loginFailures: number;
  /** Unix seconds of the last successful automatic login. */
  lastLoginAt: number;
  /** Unix seconds before which no login is attempted; 0 when free. */
  retryAfter: number;
  /** The automatic login gave up and waits for an operator. */
  stopped: boolean;
};

/** Samples and claims keep two weeks; the compact intake data (seen) longer. */
export const DASHBOARD_RETENTION_DAYS = 14;
export const INTAKE_RETENTION_DAYS = 56;
export const SAMPLE_INTERVAL_MINUTES = 5;

export function fixedListKey(id: ListId): ListKey {
  return `list:${id}`;
}

export function viewListKey(viewId: string): ListKey {
  return `view:${viewId}`;
}

/** Every countable list with label and current members, fixed tabs first. */
export function listMembers(
  rows: TicketRow[],
  views: SavedView[],
  me: { id: number; name: string },
): { key: ListKey; label: string; rows: TicketRow[] }[] {
  const result: { key: ListKey; label: string; rows: TicketRow[] }[] = [];
  // Projects are deliberately not counted. They run for months, so a curve
  // over them says nothing about the day's load — and letting them into the
  // other lists would change what every existing chart and day report means.
  const daily = rows.filter((row) => !row.isProject);
  for (const list of LISTS.filter((l) => l.id !== "projects")) {
    result.push({
      key: fixedListKey(list.id),
      label: list.label,
      rows: applyFilters(daily, presetFilters(list.id, daily, me)),
    });
  }
  for (const view of views) {
    result.push({ key: viewListKey(view.id), label: view.name, rows: applyFilters(daily, view.filters) });
  }
  return result;
}

/**
 * Adds one measurement to the stored days: the current count per list, the
 * member tickets into the day's seen set, and assignee changes on the whole
 * board as claims. A second sample in the same minute replaces the first;
 * days beyond the retention fall off (old days keep only the intake data).
 */
export function recordSample(
  days: DashboardDay[],
  nowUnixSeconds: number,
  members: { key: ListKey; rows: TicketRow[] }[],
  board: TicketRow[],
): DashboardDay[] {
  const day = berlinYmd(nowUnixSeconds);
  const minute = berlinMinuteOfDay(nowUnixSeconds);
  const counts: Record<ListKey, number> = {};
  for (const m of members) counts[m.key] = m.rows.length;

  // A new day starts from yesterday's last known assignees, so a ticket taken
  // before the first measurement of the day still shows up as a claim.
  const previous = [...days].sort((a, b) => a.day.localeCompare(b.day)).filter((d) => d.day < day).pop();
  const current =
    days.find((d) => d.day === day) ??
    ({
      day,
      samples: [],
      seen: {},
      claims: [],
      assignees: { ...previous?.assignees },
      names: { ...previous?.names },
    } satisfies DashboardDay);
  const samples = [...current.samples.filter((s) => s.minute !== minute), { minute, counts }].sort(
    (a, b) => a.minute - b.minute,
  );
  const seen: DashboardDay["seen"] = { ...current.seen };
  for (const m of members) {
    const merged = { ...seen[m.key] };
    for (const row of m.rows) merged[String(row.id)] = row.creationDate;
    seen[m.key] = merged;
  }

  const assignees = { ...current.assignees };
  const names = { ...current.names };
  const claims = [...(current.claims ?? [])];
  for (const row of board) {
    if (row.assigneeId > 0 && row.assigneeName) names[String(row.assigneeId)] = row.assigneeName;
    const known = assignees[String(row.id)];
    // First sighting is a baseline, not a claim — only a measured change counts.
    if (known !== undefined && known !== row.assigneeId && row.assigneeId > 0) {
      claims.push({
        id: row.id,
        title: row.title,
        minute,
        assigneeId: row.assigneeId,
        assigneeName: row.assigneeName || `#${row.assigneeId}`,
        fromId: known,
        fromName: known > 0 ? (names[String(known)] ?? `#${known}`) : "",
      });
    }
    assignees[String(row.id)] = row.assigneeId;
  }

  const oldestFull = shiftYmd(day, -(DASHBOARD_RETENTION_DAYS - 1));
  const oldestIntake = shiftYmd(day, -(INTAKE_RETENTION_DAYS - 1));
  return [...days.filter((d) => d.day !== day), { day, samples, seen, claims, assignees, names }]
    .filter((d) => d.day >= oldestIntake)
    .map((d) =>
      d.day >= oldestFull ? d : { day: d.day, samples: [], seen: d.seen, claims: [], assignees: {}, names: {} },
    )
    .sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Ticket creations for one list and day: the day's seen set, merged with the
 * live board rows (so the chart works before the first poll), reduced to
 * tickets created on that day, id → creation date.
 */
export function createdOnDay(
  dayEntry: DashboardDay | null,
  key: ListKey,
  liveRows: TicketRow[],
  day: string,
): Map<number, number> {
  const merged = new Map<number, number>();
  for (const [id, created] of Object.entries(dayEntry?.seen[key] ?? {})) {
    merged.set(Number(id), created);
  }
  for (const row of liveRows) merged.set(row.id, row.creationDate);
  for (const [id, created] of merged) {
    if (!created || berlinYmd(created) !== day) merged.delete(id);
  }
  return merged;
}

/** 24 buckets: how many of the given creation instants fall into each Berlin hour. */
export function intakeByHour(creations: Iterable<number>): number[] {
  const hours = new Array<number>(24).fill(0);
  for (const created of creations) {
    hours[Math.floor(berlinMinuteOfDay(created) / 60)]++;
  }
  return hours;
}

/** Intake per day for the last `count` days ending today, oldest first. */
export function intakeByDay(
  days: DashboardDay[],
  key: ListKey,
  liveRows: TicketRow[],
  today: string,
  count = 7,
): { day: string; count: number }[] {
  const result: { day: string; count: number }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const day = shiftYmd(today, -i);
    const entry = days.find((d) => d.day === day) ?? null;
    result.push({ day, count: createdOnDay(entry, key, day === today ? liveRows : [], day).size });
  }
  return result;
}

/** The day-course of one list: minute → count, from the day's samples. */
export function dayCurve(dayEntry: DashboardDay | null, key: ListKey): { minute: number; count: number }[] {
  if (!dayEntry) return [];
  return dayEntry.samples
    .filter((s) => s.counts[key] !== undefined)
    .map((s) => ({ minute: s.minute, count: s.counts[key] }));
}

/** The headline numbers over the selected list's current rows. */
export function dashboardTiles(rows: TicketRow[], today: string) {
  return {
    total: rows.length,
    unassigned: rows.filter((r) => !r.assigneeId).length,
    newToday: rows.filter((r) => r.creationDate && berlinYmd(r.creationDate) === today).length,
    waiting: rows.filter((r) => r.waiting).length,
  };
}

/** Donut segments for one column: biggest first, the tail folded into "weitere". */
export function donutSegments(
  rows: TicketRow[],
  key: FilterKey,
  maxSegments = 6,
): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = columnValue(row, key);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const sorted = [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "de"));
  if (sorted.length <= maxSegments) return sorted;
  const head = sorted.slice(0, maxSegments - 1);
  const rest = sorted.slice(maxSegments - 1).reduce((sum, s) => sum + s.count, 0);
  return [...head, { label: "weitere", count: rest }];
}

/**
 * The claims that concern one list, newest first: an assignee change counts
 * when the ticket was in the list that day (seen set) or is in it right now.
 */
/**
 * The measured days as history entries. The log only holds what was written
 * since it existed; everything still in the measurement file belongs in the
 * same view, and the lists follow from that day's membership sets.
 */
export function claimsFromDays(days: DashboardDay[], sinceDay: string): ClaimEntry[] {
  const entries: ClaimEntry[] = [];
  for (const day of days) {
    if (day.day < sinceDay) continue;
    for (const claim of day.claims ?? []) {
      entries.push({ ...claim, day: day.day, lists: listsOfDay(day, claim.id) });
    }
  }
  return entries;
}

/**
 * Which lists a ticket belonged to on that day — the day's membership set,
 * not the membership right now. A takeover moves a ticket out of the list it
 * was taken from, so asking the current lists would drop exactly the one the
 * takeover happened in. The one rule for both sources of the history.
 */
export function listsOfDay(day: DashboardDay | undefined, ticketId: number): ListKey[] {
  return Object.entries(day?.seen ?? {})
    .filter(([, ids]) => ids[String(ticketId)] !== undefined)
    .map(([key]) => key);
}

/**
 * One list of entries out of both sources, without counting one twice. The
 * lists are pooled instead of taken from the first source: a log line written
 * at midday knows only the memberships measured until then, the day's set
 * knows all of them, and a takeover belongs under every list it touched.
 */
export function mergeClaimEntries(...sources: ClaimEntry[][]): ClaimEntry[] {
  const seen = new Map<string, ClaimEntry>();
  for (const source of sources) {
    for (const entry of source) {
      const key = `${entry.day}|${entry.id}|${entry.minute}|${entry.assigneeId}`;
      const known = seen.get(key);
      if (!known) seen.set(key, { ...entry, lists: [...entry.lists] });
      else for (const list of entry.lists) if (!known.lists.includes(list)) known.lists.push(list);
    }
  }
  return [...seen.values()];
}

/** History entries for one list, newest first. */
export function historyForList(entries: ClaimEntry[], key: ListKey | "all"): ClaimEntry[] {
  return entries
    .filter((e) => key === "all" || e.lists.includes(key))
    .sort((a, b) => b.day.localeCompare(a.day) || b.minute - a.minute);
}

/** How often each person took something, over the entries given. */
export function claimsByEmployee(entries: ClaimEntry[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const name = entry.assigneeName || `#${entry.assigneeId}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "de"));
}

export function claimsForList(
  days: DashboardDay[],
  key: ListKey,
  liveRows: TicketRow[],
  fromDay: string,
): { day: string; claim: Claim }[] {
  const liveIds = new Set(liveRows.map((r) => r.id));
  const result: { day: string; claim: Claim }[] = [];
  for (const entry of days) {
    if (entry.day < fromDay) continue;
    const inList = entry.seen[key] ?? {};
    for (const claim of entry.claims ?? []) {
      if (inList[String(claim.id)] === undefined && !liveIds.has(claim.id)) continue;
      result.push({ day: entry.day, claim });
    }
  }
  return result.sort((a, b) => b.day.localeCompare(a.day) || b.claim.minute - a.claim.minute);
}

export const AGE_BUCKETS = [
  { label: "heute", max: 0 },
  { label: "1–3 Tage", max: 3 },
  { label: "4–7 Tage", max: 7 },
  { label: "8–30 Tage", max: 30 },
  { label: "älter", max: Infinity },
] as const;

/** How old the list's tickets are, bucketed — the backlog at a glance. */
export function ageBuckets(rows: TicketRow[], today: string): { label: string; count: number }[] {
  const counts = AGE_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  for (const row of rows) {
    const age = ticketAgeDays(row.creationDate, today);
    counts[AGE_BUCKETS.findIndex((b) => age <= b.max)].count++;
  }
  return counts;
}

/** Due dates of the list: already late, due today, due within the week. */
export function dueSummary(rows: TicketRow[], today: string): { overdue: number; dueToday: number; dueWeek: number } {
  const weekEnd = shiftYmd(today, 6);
  let overdue = 0;
  let dueToday = 0;
  let dueWeek = 0;
  for (const row of rows) {
    const due = row.deadlineDate || row.dueDate;
    if (!due) continue;
    const day = berlinYmd(due);
    if (day < today) overdue++;
    else if (day === today) dueToday++;
    else if (day <= weekEnd) dueWeek++;
  }
  return { overdue, dueToday, dueWeek };
}

/**
 * Intake by weekday × hour over everything stored (up to 8 weeks):
 * grid[weekday][hour], weekday 0 = Monday.
 */
export function weekHeatmap(
  days: DashboardDay[],
  key: ListKey,
  liveRows: TicketRow[],
  today: string,
): number[][] {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const allDays = days.some((d) => d.day === today) ? days : [...days, { day: today, samples: [], seen: {}, claims: [], assignees: {}, names: {} }];
  for (const entry of allDays) {
    const weekday = (berlinWeekday(entry.day) + 6) % 7;
    const created = createdOnDay(entry, key, entry.day === today ? liveRows : [], entry.day);
    for (const instant of created.values()) {
      grid[weekday][Math.floor(berlinMinuteOfDay(instant) / 60)]++;
    }
  }
  return grid;
}

/** The companies filling the list, biggest first. */
export function topCompanies(rows: TicketRow[], max = 8): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const name = row.companyName || "—";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        (a.label === "—" ? 1 : b.label === "—" ? -1 : a.label.localeCompare(b.label, "de")),
    )
    .slice(0, max);
}

/** Tolerant reader for stored dashboard days — a broken entry is dropped. */
export function parseDashboardDays(raw: unknown): DashboardDay[] {
  if (!Array.isArray(raw)) return [];
  const days: DashboardDay[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const d = item as Record<string, unknown>;
    if (typeof d.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d.day)) continue;
    const samples: DashboardSample[] = [];
    for (const s of Array.isArray(d.samples) ? d.samples : []) {
      if (typeof s !== "object" || s === null) continue;
      const sample = s as Record<string, unknown>;
      const minute = Number(sample.minute);
      if (!Number.isInteger(minute) || minute < 0 || minute >= 24 * 60) continue;
      const counts: Record<string, number> = {};
      if (typeof sample.counts === "object" && sample.counts !== null) {
        for (const [k, v] of Object.entries(sample.counts)) {
          const n = Number(v);
          if (Number.isFinite(n)) counts[k] = n;
        }
      }
      samples.push({ minute, counts });
    }
    const seen: DashboardDay["seen"] = {};
    if (typeof d.seen === "object" && d.seen !== null) {
      for (const [key, ids] of Object.entries(d.seen)) {
        if (typeof ids !== "object" || ids === null) continue;
        const clean: Record<string, number> = {};
        for (const [id, created] of Object.entries(ids)) {
          const n = Number(created);
          if (Number.isFinite(n)) clean[id] = n;
        }
        seen[key] = clean;
      }
    }
    const claims: Claim[] = [];
    for (const c of Array.isArray(d.claims) ? d.claims : []) {
      if (typeof c !== "object" || c === null) continue;
      const claim = c as Record<string, unknown>;
      const id = Number(claim.id);
      const minute = Number(claim.minute);
      const assigneeId = Number(claim.assigneeId);
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(minute) || !Number.isInteger(assigneeId)) continue;
      claims.push({
        id,
        minute,
        assigneeId,
        title: String(claim.title ?? ""),
        assigneeName: String(claim.assigneeName ?? ""),
        fromId: Number(claim.fromId) || 0,
        fromName: String(claim.fromName ?? ""),
      });
    }
    const numberMap = (raw: unknown): Record<string, number> => {
      const clean: Record<string, number> = {};
      if (typeof raw === "object" && raw !== null) {
        for (const [k, v] of Object.entries(raw)) {
          const n = Number(v);
          if (Number.isFinite(n)) clean[k] = n;
        }
      }
      return clean;
    };
    const names: Record<string, string> = {};
    if (typeof d.names === "object" && d.names !== null) {
      for (const [k, v] of Object.entries(d.names)) {
        if (typeof v === "string") names[k] = v;
      }
    }
    days.push({
      day: d.day,
      samples: samples.sort((a, b) => a.minute - b.minute),
      seen,
      claims,
      assignees: numberMap(d.assignees),
      names,
    });
  }
  return days.sort((a, b) => a.day.localeCompare(b.day));
}
