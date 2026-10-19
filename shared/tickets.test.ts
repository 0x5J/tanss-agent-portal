import { describe, expect, it } from "vitest";
import { formatUpdated, matchesQuery, rowTone, rowsForList, toTicketRow } from "./tickets.ts";

const linked = {
  companies: { "100": { name: "Müller GmbH" } },
  ticketStates: { "2": { name: "gesichtet" }, "6": { name: "Wartet auf Kunde" } },
  ticketTypes: { "3": { name: "Störung" } },
  employees: { "8094": { name: "Mitarbeiter, Test", initials: "tm" } },
  departments: { "1": { name: "Technik" } },
  tickets: { "500": { title: "Projekt Süd" } },
};

const raw = {
  id: 4711,
  companyId: 100,
  title: "FortiEDR blockiert Backup-Agent",
  statusId: 6,
  typeId: 3,
  assignedToEmployeeId: 8094,
  assignedToDepartmentId: 1,
  projectId: 500,
  modified: 1_755_700_000,
  dueDate: 1_755_000_000,
};

describe("toTicketRow", () => {
  it("resolves linked names and waiting state", () => {
    const row = toTicketRow(raw, linked, [6, 7]);
    expect(row.companyName).toBe("Müller GmbH");
    expect(row.statusName).toBe("Wartet auf Kunde");
    expect(row.typeName).toBe("Störung");
    expect(row.assigneeName).toBe("Mitarbeiter, Test");
    expect(row.projectName).toBe("Projekt Süd");
    expect(row.waiting).toBe(true);
  });

  it("tolerates missing linked entries", () => {
    const row = toTicketRow({ id: 1, statusId: 99 }, {}, []);
    expect(row.statusName).toBe("");
    expect(row.companyName).toBe("");
    expect(row.waiting).toBe(false);
  });
});

describe("matchesQuery", () => {
  const row = toTicketRow(raw, linked, []);
  it("matches id with and without hash, and every word", () => {
    expect(matchesQuery(row, "#4711")).toBe(true);
    expect(matchesQuery(row, "4711")).toBe(true);
    expect(matchesQuery(row, "müller backup")).toBe(true);
    expect(matchesQuery(row, "müller linear")).toBe(false);
    expect(matchesQuery(row, "")).toBe(true);
  });
});

describe("rowTone", () => {
  it("overdue beats waiting", () => {
    const row = toTicketRow(raw, linked, [6]);
    expect(rowTone(row, 1_755_700_000)).toBe("overdue");
    expect(rowTone({ ...row, dueDate: 0 }, 1_755_700_000)).toBe("waiting");
    expect(rowTone({ ...row, dueDate: 0, waiting: false }, 1_755_700_000)).toBe("none");
  });
});

describe("formatUpdated", () => {
  // 2026-08-21 08:12 Berlin (CEST, UTC+2)
  const now = Date.parse("2026-08-21T10:00:00+02:00") / 1000;
  it("shows clock today, short date this year, full date otherwise", () => {
    expect(formatUpdated(Date.parse("2026-08-21T08:12:00+02:00") / 1000, now)).toBe("08:12");
    expect(formatUpdated(Date.parse("2026-08-20T08:12:00+02:00") / 1000, now)).toBe("20.08.");
    expect(formatUpdated(Date.parse("2025-12-24T08:12:00+01:00") / 1000, now)).toBe("24.12.2025");
    expect(formatUpdated(0, now)).toBe("—");
  });
});

describe("rowsForList", () => {
  const ticket = toTicketRow({ id: 1, project: false }, {}, []);
  const project = toTicketRow({ id: 2, project: true }, {}, []);
  const rows = [ticket, project];

  it("gives the projects tab the projects and nothing else", () => {
    expect(rowsForList(rows, "projects").map((r) => r.id)).toEqual([2]);
  });

  it("keeps projects out of every other tab", () => {
    for (const list of ["own", "general", "waiting", "technician", "all"] as const) {
      expect(rowsForList(rows, list).map((r) => r.id)).toEqual([1]);
    }
  });
});
