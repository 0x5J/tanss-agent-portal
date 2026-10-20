import { describe, expect, it } from "vitest";
import { berlinUnixAtMinute } from "./days.ts";
import type { TicketRow } from "./tickets.ts";
import { byUrgency, dueLabel, dueState, dueToday, firstName, greeting, ownOpen } from "./today.ts";

const TODAY = "2026-10-20";
const NOW = berlinUnixAtMinute(TODAY, 10 * 60);

function row(id: number, patch: Partial<TicketRow> = {}): TicketRow {
  return {
    id,
    title: `Ticket ${id}`,
    companyId: 1,
    companyName: "Kunde",
    projectId: 0,
    projectName: "",
    statusId: 1,
    statusName: "Neu",
    typeName: "",
    assigneeId: 7,
    assigneeName: "Sören Jacobsen",
    departmentName: "",
    modified: NOW,
    creationDate: NOW - 86_400,
    dueDate: 0,
    deadlineDate: 0,
    waiting: false,
    isProject: false,
    estimatedMinutes: 0,
    ...patch,
  };
}

describe("greeting", () => {
  it("follows the time of day", () => {
    expect(greeting(8 * 60)).toBe("Guten Morgen");
    expect(greeting(13 * 60)).toBe("Hallo");
    expect(greeting(19 * 60)).toBe("Guten Abend");
  });
});

describe("firstName", () => {
  it("takes the first word, or the part after the comma", () => {
    expect(firstName("Sören Jacobsen")).toBe("Sören");
    expect(firstName("Jacobsen, Sören")).toBe("Sören");
    expect(firstName("  ")).toBe("");
  });
});

describe("ownOpen", () => {
  it("keeps my day-to-day tickets only", () => {
    const rows = [row(1), row(2, { assigneeId: 8 }), row(3, { isProject: true })];
    expect(ownOpen(rows, 7).map((r) => r.id)).toEqual([1]);
  });
});

describe("due", () => {
  const overdue = row(1, { dueDate: berlinUnixAtMinute("2026-10-18", 17 * 60) });
  const later = row(2, { dueDate: berlinUnixAtMinute(TODAY, 17 * 60) });
  const earlier = row(3, { deadlineDate: berlinUnixAtMinute(TODAY, 8 * 60) });
  const tomorrow = row(4, { dueDate: berlinUnixAtMinute("2026-10-21", 9 * 60) });

  it("classifies the date", () => {
    expect(dueState(overdue, NOW)).toBe("overdue");
    expect(dueState(later, NOW)).toBe("today");
    expect(dueState(tomorrow, NOW)).toBe("later");
    expect(dueState(row(5), NOW)).toBe("none");
  });

  it("lists what is due by tonight, missed dates first", () => {
    expect(dueToday([tomorrow, later, earlier, overdue], NOW).map((r) => r.id)).toEqual([1, 3, 2]);
  });

  it("labels missed and coming dates", () => {
    expect(dueLabel(overdue, NOW)).toBe("seit 18.10.");
    expect(dueLabel(earlier, NOW)).toBe("seit 08:00");
    expect(dueLabel(later, NOW)).toBe("bis 17:00");
  });
});

describe("byUrgency", () => {
  it("puts missed dates first, then the longest without a trace", () => {
    const fresh = row(1, { creationDate: NOW - 3_600 });
    const stale = row(2, { creationDate: NOW - 20 * 86_400 });
    const overdue = row(3, { dueDate: NOW - 60 });
    const traced = row(4, { creationDate: NOW - 30 * 86_400 });
    const activity = { 4: { at: NOW - 600, kind: "comment" as const, historyRead: true } };
    expect(byUrgency([fresh, stale, overdue, traced], activity, NOW, TODAY, "2025-10-20").map((r) => r.id)).toEqual([3, 2, 1, 4]);
  });
});
