import { describe, expect, it } from "vitest";
import {
  ageBuckets,
  claimsForList,
  createdOnDay,
  dashboardTiles,
  dayCurve,
  donutSegments,
  dueSummary,
  fixedListKey,
  intakeByDay,
  intakeByHour,
  listMembers,
  parseDashboardDays,
  recordSample,
  topCompanies,
  viewListKey,
  weekHeatmap,
  type DashboardDay,
} from "./dashboard.ts";
import { berlinUnixAtMinute } from "./days.ts";
import { EMPTY_FILTERS, type SavedView } from "./filters.ts";
import { toTicketRow, type TicketRow } from "./tickets.ts";

const at = (day: string, hour: number, minute = 0) => berlinUnixAtMinute(day, hour * 60 + minute);

function row(id: number, extra: Partial<TicketRow> = {}): TicketRow {
  return {
    ...toTicketRow({ id, statusId: 1 }, {}, []),
    companyName: "Kranz",
    statusName: "Neu",
    ...extra,
  };
}

const me = { id: 7, name: "Sören" };

describe("listMembers", () => {
  it("counts fixed tabs and saved views over the same rows", () => {
    const rows = [
      row(1, { assigneeId: 7, assigneeName: "Sören" }),
      row(2, { departmentName: "SOC" }),
      row(3, { departmentName: "SOC", assigneeId: 7, assigneeName: "Sören" }),
    ];
    const soc: SavedView = { id: "v1", name: "SOC", list: "all", filters: { ...EMPTY_FILTERS, department: ["SOC"] } };
    const members = listMembers(rows, [soc], me);
    const byKey = Object.fromEntries(members.map((m) => [m.key, m.rows.map((r) => r.id)]));
    expect(byKey[fixedListKey("own")]).toEqual([1, 3]);
    expect(byKey[fixedListKey("general")]).toEqual([2]);
    expect(byKey[viewListKey("v1")]).toEqual([2, 3]);
    expect(members.find((m) => m.key === viewListKey("v1"))?.label).toBe("SOC");
  });

  it("leaves projects out of the counted lists", () => {
    // The collector samples every countable list every five minutes and the
    // day report is built from those samples. Projects run for months; a
    // "Projekte" curve would say nothing about the day's load and would
    // change what the existing charts mean.
    const all: SavedView = { id: "v2", name: "Alles", list: "all", filters: EMPTY_FILTERS };
    const members = listMembers([row(1), row(2, { isProject: true })], [all], me);
    expect(members.some((m) => m.key === fixedListKey("projects"))).toBe(false);
    // A saved list must not be the back door either.
    expect(members.find((m) => m.key === viewListKey("v2"))?.rows.map((r) => r.id)).toEqual([1]);
    for (const member of members) {
      expect(member.rows.some((r) => r.isProject)).toBe(false);
    }
  });
});

describe("recordSample", () => {
  it("appends samples, replaces the same minute and remembers seen tickets", () => {
    const members = [{ key: "view:v1", rows: [row(1, { creationDate: at("2026-08-24", 9) })] }];
    let days = recordSample([], at("2026-08-24", 10, 0), members, []);
    days = recordSample(
      days,
      at("2026-08-24", 10, 5),
      [
        { key: "view:v1", rows: [row(1, { creationDate: at("2026-08-24", 9) }), row(2, { creationDate: at("2026-08-24", 10) })] },
      ],
      [],
    );
    // Same minute again: replaced, not duplicated.
    days = recordSample(days, at("2026-08-24", 10, 5), [{ key: "view:v1", rows: [row(2, { creationDate: at("2026-08-24", 10) })] }], []);
    expect(days).toHaveLength(1);
    expect(days[0].samples).toEqual([
      { minute: 600, counts: { "view:v1": 1 } },
      { minute: 605, counts: { "view:v1": 1 } },
    ]);
    // Ticket 1 left the list but stays in the day's seen set.
    expect(Object.keys(days[0].seen["view:v1"])).toEqual(["1", "2"]);
  });

  it("keeps intake data longer than samples and drops the rest", () => {
    let days: DashboardDay[] = [];
    for (let i = 0; i < 60; i++) {
      days = recordSample(days, at("2026-07-01", 12) + i * 86_400, [
        { key: "list:own", rows: [row(1, { creationDate: at("2026-07-01", 9) + i * 86_400 })] },
      ], []);
    }
    expect(days).toHaveLength(56);
    expect(days[days.length - 1].day).toBe("2026-08-29");
    // Old days keep the seen set for the heatmap, but no samples.
    expect(days[0].samples).toEqual([]);
    expect(Object.keys(days[0].seen["list:own"])).toEqual(["1"]);
    expect(days[days.length - 1].samples).toHaveLength(1);
  });

  it("records a claim when a ticket changes hands, not on first sighting", () => {
    const open = row(9, { title: "Phishing" });
    let days = recordSample([], at("2026-08-24", 8, 0), [], [open]);
    expect(days[0].claims).toEqual([]);
    const taken = row(9, { title: "Phishing", assigneeId: 8, assigneeName: "Micha" });
    days = recordSample(days, at("2026-08-24", 8, 10), [], [taken]);
    expect(days[0].claims).toEqual([
      { id: 9, title: "Phishing", minute: 490, assigneeId: 8, assigneeName: "Micha", fromId: 0, fromName: "" },
    ]);
    // Handover to another employee names the previous one.
    const handedOver = row(9, { title: "Phishing", assigneeId: 7, assigneeName: "Sören" });
    days = recordSample(days, at("2026-08-24", 9, 0), [], [handedOver]);
    expect(days[0].claims[1]).toMatchObject({ assigneeName: "Sören", fromId: 8, fromName: "Micha" });
  });

  it("carries yesterday's assignees into the new day", () => {
    let days = recordSample([], at("2026-08-23", 18, 0), [], [row(9)]);
    // First measurement of the next morning: the ticket is already taken.
    days = recordSample(days, at("2026-08-24", 7, 30), [], [row(9, { assigneeId: 7, assigneeName: "Sören" })]);
    const today = days.find((d) => d.day === "2026-08-24");
    expect(today?.claims).toHaveLength(1);
    expect(today?.claims[0]).toMatchObject({ id: 9, assigneeId: 7, fromId: 0 });
  });
});

describe("createdOnDay / intake", () => {
  const dayEntry: DashboardDay = {
    day: "2026-08-24",
    samples: [],
    seen: {
      "view:v1": {
        "1": at("2026-08-24", 8, 15),
        "2": at("2026-08-24", 8, 45),
        "3": at("2026-08-23", 22), // created yesterday — not intake of today
      },
    },
    claims: [],
    assignees: {},
    names: {},
  };

  it("merges seen and live rows and keeps only the day's creations", () => {
    const live = [row(4, { creationDate: at("2026-08-24", 14) }), row(5, { creationDate: at("2026-08-20", 9) })];
    const created = createdOnDay(dayEntry, "view:v1", live, "2026-08-24");
    expect([...created.keys()].sort()).toEqual([1, 2, 4]);
    expect(intakeByHour(created.values())[8]).toBe(2);
    expect(intakeByHour(created.values())[14]).toBe(1);
    expect(intakeByHour(created.values()).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("builds the last-days series with the live rows only counting today", () => {
    const series = intakeByDay([dayEntry], "view:v1", [row(4, { creationDate: at("2026-08-24", 14) })], "2026-08-24", 3);
    expect(series).toEqual([
      { day: "2026-08-22", count: 0 },
      { day: "2026-08-23", count: 0 },
      { day: "2026-08-24", count: 3 },
    ]);
  });
});

describe("dayCurve", () => {
  it("returns only samples that measured the list", () => {
    const entry: DashboardDay = {
      day: "2026-08-24",
      samples: [
        { minute: 480, counts: { "list:own": 4 } },
        { minute: 540, counts: { "list:own": 5, "view:v1": 2 } },
      ],
      seen: {},
      claims: [],
      assignees: {},
      names: {},
    };
    expect(dayCurve(entry, "view:v1")).toEqual([{ minute: 540, count: 2 }]);
    expect(dayCurve(null, "view:v1")).toEqual([]);
  });
});

describe("dashboardTiles", () => {
  it("counts total, unassigned, new today and waiting", () => {
    const rows = [
      row(1, { assigneeId: 7, creationDate: at("2026-08-24", 9) }),
      row(2, { creationDate: at("2026-08-23", 9) }),
      row(3, { waiting: true, assigneeId: 7 }),
    ];
    expect(dashboardTiles(rows, "2026-08-24")).toEqual({ total: 3, unassigned: 1, newToday: 1, waiting: 1 });
  });
});

describe("donutSegments", () => {
  it("sorts by size and folds the tail into one segment", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row(i + 1, { statusName: "Neu" })),
      ...Array.from({ length: 3 }, (_, i) => row(i + 10, { statusName: "Wartet" })),
      row(20, { statusName: "A" }),
      row(21, { statusName: "B" }),
      row(22, { statusName: "C" }),
    ];
    const segments = donutSegments(rows, "status", 4);
    expect(segments.map((s) => s.label)).toEqual(["Neu", "Wartet", "A", "weitere"]);
    expect(segments[3].count).toBe(2);
  });
});

describe("parseDashboardDays", () => {
  it("drops broken entries and sorts what remains", () => {
    const parsed = parseDashboardDays([
      { day: "2026-08-24", samples: [{ minute: 600, counts: { a: 3 } }, { minute: "kaputt", counts: {} }], seen: { a: { "1": 123, "2": "x" } } },
      { day: "nicht", samples: [], seen: {} },
      { day: "2026-08-23", samples: [], seen: {} },
      "müll",
    ]);
    expect(parsed.map((d) => d.day)).toEqual(["2026-08-23", "2026-08-24"]);
    expect(parsed[1].samples).toEqual([{ minute: 600, counts: { a: 3 } }]);
    expect(parsed[1].seen).toEqual({ a: { "1": 123 } });
    expect(parsed[1].claims).toEqual([]);
  });

  it("reads claims, assignees and names back, dropping broken claims", () => {
    const parsed = parseDashboardDays([
      {
        day: "2026-08-24",
        samples: [],
        seen: {},
        claims: [
          { id: 9, title: "T", minute: 490, assigneeId: 8, assigneeName: "Micha", fromId: 0, fromName: "" },
          { id: "kaputt" },
        ],
        assignees: { "9": 8, "10": "x" },
        names: { "8": "Micha", "7": 5 },
      },
    ]);
    expect(parsed[0].claims).toHaveLength(1);
    expect(parsed[0].assignees).toEqual({ "9": 8 });
    expect(parsed[0].names).toEqual({ "8": "Micha" });
  });
});

describe("claimsForList", () => {
  it("keeps only claims whose ticket belongs to the list, newest first", () => {
    const claim = (id: number, minute: number) =>
      ({ id, title: `T${id}`, minute, assigneeId: 8, assigneeName: "Micha", fromId: 0, fromName: "" });
    const days: DashboardDay[] = [
      { day: "2026-08-23", samples: [], seen: { "view:v1": { "9": 1 } }, claims: [claim(9, 600)], assignees: {}, names: {} },
      { day: "2026-08-24", samples: [], seen: { "view:v1": { "9": 1 } }, claims: [claim(9, 480), claim(5, 500), claim(6, 520)], assignees: {}, names: {} },
    ];
    // 5 is not in the list; 6 only via the live rows.
    const result = claimsForList(days, "view:v1", [row(6)], "2026-08-23");
    expect(result.map((r) => `${r.day}:${r.claim.id}`)).toEqual(["2026-08-24:6", "2026-08-24:9", "2026-08-23:9"]);
    expect(claimsForList(days, "view:v1", [], "2026-08-24")).toHaveLength(1);
  });
});

describe("ageBuckets / dueSummary / topCompanies", () => {
  it("buckets ages including the edges", () => {
    const rows = [
      row(1, { creationDate: at("2026-08-24", 9) }),
      row(2, { creationDate: at("2026-08-21", 9) }),
      row(3, { creationDate: at("2026-08-17", 9) }),
      row(4, { creationDate: at("2026-07-01", 9) }),
    ];
    expect(ageBuckets(rows, "2026-08-24").map((b) => b.count)).toEqual([1, 1, 1, 0, 1]);
  });

  it("splits due dates into overdue, today and this week", () => {
    const rows = [
      row(1, { dueDate: at("2026-08-20", 12) }),
      row(2, { deadlineDate: at("2026-08-24", 17) }),
      row(3, { dueDate: at("2026-08-28", 9) }),
      row(4, { dueDate: at("2026-09-15", 9) }),
      row(5),
    ];
    expect(dueSummary(rows, "2026-08-24")).toEqual({ overdue: 1, dueToday: 1, dueWeek: 1 });
  });

  it("ranks companies by count", () => {
    const rows = [row(1), row(2), row(3, { companyName: "Weber" }), row(4, { companyName: "" })];
    expect(topCompanies(rows, 2)).toEqual([
      { label: "Kranz", count: 2 },
      { label: "Weber", count: 1 },
    ]);
  });
});

describe("weekHeatmap", () => {
  it("sums creations into weekday × hour cells", () => {
    // 2026-08-24 is a Monday.
    const days: DashboardDay[] = [
      {
        day: "2026-08-24",
        samples: [],
        seen: { "view:v1": { "1": at("2026-08-24", 9, 10), "2": at("2026-08-24", 9, 50) } },
        claims: [],
        assignees: {},
        names: {},
      },
      {
        day: "2026-08-22",
        samples: [],
        seen: { "view:v1": { "3": at("2026-08-22", 14) } },
        claims: [],
        assignees: {},
        names: {},
      },
    ];
    const grid = weekHeatmap(days, "view:v1", [row(4, { creationDate: at("2026-08-24", 16) })], "2026-08-24");
    expect(grid[0][9]).toBe(2); // Montag 9 Uhr
    expect(grid[0][16]).toBe(1); // live row heute
    expect(grid[5][14]).toBe(1); // Samstag
    expect(grid.flat().reduce((a, b) => a + b, 0)).toBe(4);
  });
});
