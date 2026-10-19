import { describe, expect, it } from "vitest";
import {
  MAX_RANGE_DAYS,
  applyFacet,
  bucketSize,
  groupBy,
  isYmd,
  presetRange,
  rangeDays,
  rangeLength,
  series,
  topWithRest,
  totals,
} from "./analysis.ts";
import { berlinUnixAtMinute } from "./days.ts";
import type { Support } from "./timeline.ts";

function booking(day: string, minuteOfDay: number, duration: number, extra: Partial<Support> = {}): Support {
  return {
    id: 1,
    date: berlinUnixAtMinute(day, minuteOfDay),
    duration,
    ticketId: 0,
    companyId: 0,
    companyName: "",
    text: "",
    typeId: 0,
    typeName: "",
    location: "",
    employeeId: 7,
    booked: false,
    clearanceStatus: "",
    voucherId: 0,
    internal: false,
    durationNotCharged: 0,
    reasonNotChargedText: "",
    ...extra,
  };
}

describe("presetRange", () => {
  it("takes the Monday-to-Sunday week", () => {
    // 2026-08-28 is a Friday
    expect(presetRange("week", "2026-08-28")).toEqual({ from: "2026-08-24", to: "2026-08-30" });
    expect(presetRange("lastWeek", "2026-08-28")).toEqual({ from: "2026-08-17", to: "2026-08-23" });
  });

  it("takes whole months, across the year boundary too", () => {
    expect(presetRange("month", "2026-08-28")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(presetRange("lastMonth", "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(presetRange("month", "2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(presetRange("month", "2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  it("honours the Gregorian 100/400 leap year exception", () => {
    // 2100 divides by 100 but not by 400: no leap year, February has 28 days.
    expect(presetRange("month", "2100-02-10")).toEqual({ from: "2100-02-01", to: "2100-02-28" });
    // 2000 divides by 400: a leap year despite the century, February has 29 days.
    expect(presetRange("month", "2000-02-10")).toEqual({ from: "2000-02-01", to: "2000-02-29" });
    // 2027 divides by neither 4 nor 100/400: an ordinary year, February has 28 days.
    expect(presetRange("month", "2027-02-10")).toEqual({ from: "2027-02-01", to: "2027-02-28" });
  });

  it("takes the calendar quarter and the calendar year", () => {
    expect(presetRange("quarter", "2026-08-28")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(presetRange("quarter", "2026-01-01")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(presetRange("year", "2026-08-28")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("keeps every preset inside the maximum span", () => {
    for (const preset of ["week", "lastWeek", "month", "lastMonth", "quarter", "year"] as const) {
      expect(rangeLength(presetRange(preset, "2028-03-15"))).toBeLessThanOrEqual(MAX_RANGE_DAYS);
    }
  });
});

describe("rangeDays", () => {
  it("counts both ends", () => {
    expect(rangeDays({ from: "2026-08-24", to: "2026-08-26" })).toEqual([
      "2026-08-24",
      "2026-08-25",
      "2026-08-26",
    ]);
    expect(rangeDays({ from: "2026-08-24", to: "2026-08-24" })).toEqual(["2026-08-24"]);
  });

  it("crosses the daylight saving switch without losing a day", () => {
    // The night of 24 to 25 October 2026: the clocks go back
    const days = rangeDays({ from: "2026-10-23", to: "2026-10-27" });
    expect(days).toEqual(["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"]);
    // and in spring they go forward
    expect(rangeDays({ from: "2026-03-28", to: "2026-03-30" })).toEqual([
      "2026-03-28",
      "2026-03-29",
      "2026-03-30",
    ]);
  });

  it("returns nothing for a reversed range", () => {
    expect(rangeDays({ from: "2026-08-26", to: "2026-08-24" })).toEqual([]);
  });

  it("returns nothing for an end that is not a whole day, instead of throwing", () => {
    // What a cleared or half-typed date field reports. Walking such a range
    // would throw deep inside a render, and there is no error boundary to
    // catch it — so it has no days rather than no page.
    for (const range of [
      { from: "", to: "2026-08-26" },
      { from: "2026-08-24", to: "" },
      { from: "2026-08", to: "2026-08-26" },
      { from: "2026-08-24", to: "26.08.2026" },
      { from: "", to: "" },
    ]) {
      expect(() => rangeDays(range)).not.toThrow();
      expect(rangeDays(range)).toEqual([]);
    }
  });
});

describe("rangeLength", () => {
  it("counts the days including both ends", () => {
    expect(rangeLength({ from: "2026-08-24", to: "2026-08-24" })).toBe(1);
    expect(rangeLength({ from: "2026-01-01", to: "2026-12-31" })).toBe(365);
    expect(rangeLength({ from: "2028-01-01", to: "2028-12-31" })).toBe(366);
  });

  it("inherits the guard and counts a malformed range as zero days", () => {
    expect(rangeLength({ from: "", to: "2026-08-26" })).toBe(0);
    expect(rangeLength({ from: "2026-08-24", to: "2026-8-2" })).toBe(0);
  });
});

describe("isYmd", () => {
  it("accepts a whole day and refuses everything else", () => {
    expect(isYmd("2026-08-24")).toBe(true);
    expect(isYmd("")).toBe(false);
    expect(isYmd("2026-08")).toBe(false);
    expect(isYmd("2026-8-24")).toBe(false);
    expect(isYmd("24.08.2026")).toBe(false);
  });
});

describe("bucketSize", () => {
  it("inherits the guard and stays at the daily resolution", () => {
    expect(() => bucketSize({ from: "", to: "" })).not.toThrow();
    expect(bucketSize({ from: "", to: "" })).toBe("day");
  });

  it("switches resolution at the edges", () => {
    expect(bucketSize({ from: "2026-01-01", to: "2026-03-11" })).toBe("day"); // 70 days
    expect(bucketSize({ from: "2026-01-01", to: "2026-03-12" })).toBe("week"); // 71
    expect(bucketSize({ from: "2026-01-01", to: "2026-06-29" })).toBe("week"); // 180
    expect(bucketSize({ from: "2026-01-01", to: "2026-06-30" })).toBe("month"); // 181
  });
});

describe("series", () => {
  it("really lays out the empty days", () => {
    const range = { from: "2026-08-24", to: "2026-08-28" }; // Mon-Fri
    const slots = series([booking("2026-08-26", 9 * 60, 90)], range, "day");
    expect(slots).toHaveLength(5);
    expect(slots.map((s) => s.minutes)).toEqual([0, 0, 90, 0, 0]);
    expect(slots[2].day).toBe("2026-08-26");
  });

  it("marks weekends", () => {
    const slots = series([], { from: "2026-08-28", to: "2026-08-31" }, "day");
    expect(slots.map((s) => s.weekend)).toEqual([false, true, true, false]);
  });

  it("counts a late booking on its Berlin day", () => {
    const slots = series([booking("2026-08-26", 23 * 60 + 30, 30)], { from: "2026-08-26", to: "2026-08-27" }, "day");
    expect(slots[0].minutes).toBe(30);
    expect(slots[1].minutes).toBe(0);
  });

  it("holds the sum across every resolution", () => {
    const range = { from: "2026-01-01", to: "2026-12-31" };
    const supports = [
      booking("2026-01-05", 9 * 60, 60),
      booking("2026-01-08", 9 * 60, 30),
      booking("2026-07-20", 9 * 60, 120),
      booking("2026-12-30", 9 * 60, 45),
    ];
    const total = 60 + 30 + 120 + 45;
    for (const size of ["day", "week", "month"] as const) {
      const sum = series(supports, range, size).reduce((n, s) => n + s.minutes, 0);
      expect(sum).toBe(total);
    }
  });

  it("leaves bookings outside the range where they are", () => {
    const slots = series([booking("2026-08-20", 9 * 60, 60)], { from: "2026-08-24", to: "2026-08-28" }, "day");
    expect(slots.reduce((n, s) => n + s.minutes, 0)).toBe(0);
  });

  it("clamps the jump day to range.from when the week starts before the range", () => {
    // range.from is a Wednesday, in the middle of the first calendar week.
    const range = { from: "2026-08-26", to: "2026-09-08" };
    const supports = [booking("2026-08-26", 9 * 60, 60), booking("2026-09-02", 9 * 60, 30)];
    const weekly = series(supports, range, "week");
    expect(weekly.map((s) => s.day)).toEqual(["2026-08-26", "2026-08-31", "2026-09-07"]);
    expect(weekly.reduce((n, s) => n + s.minutes, 0)).toBe(90);
  });

  it("clamps the jump day to range.from when the month starts before the range", () => {
    // range.from is mid-August, not the first of the month.
    const range = { from: "2026-08-15", to: "2026-09-15" };
    const supports = [booking("2026-08-20", 9 * 60, 45), booking("2026-09-05", 9 * 60, 15)];
    const monthly = series(supports, range, "month");
    expect(monthly.map((s) => s.day)).toEqual(["2026-08-15", "2026-09-01"]);
    expect(monthly.reduce((n, s) => n + s.minutes, 0)).toBe(60);
  });
});

describe("groupBy", () => {
  it("sums per ticket and names bookings without a ticket", () => {
    const supports = [
      booking("2026-08-24", 540, 60, { ticketId: 5, companyName: "Kunde A" }),
      booking("2026-08-25", 540, 30, { ticketId: 5, companyName: "Kunde A" }),
      booking("2026-08-25", 600, 120, { ticketId: 0, companyName: "Kunde B" }),
    ];
    const groups = groupBy(supports, "ticket");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ id: "0", label: "ohne Ticket", minutes: 120, count: 1, ticketId: 0 });
    expect(groups[1]).toMatchObject({ id: "5", label: "#5 · Kunde A", minutes: 90, count: 2, ticketId: 5 });
  });

  it("takes the most common booking text as the hint", () => {
    const supports = [
      booking("2026-08-24", 540, 60, { ticketId: 5, text: "Firewall geprüft" }),
      booking("2026-08-25", 540, 30, { ticketId: 5, text: "Firewall geprüft" }),
      booking("2026-08-26", 540, 30, { ticketId: 5, text: "Rückruf" }),
    ];
    expect(groupBy(supports, "ticket")[0].hint).toBe("Firewall geprüft");
  });

  it("groups by customer and by service type", () => {
    const supports = [
      booking("2026-08-24", 540, 60, { companyId: 9, companyName: "Kunde A", typeId: 3, typeName: "Remote" }),
      booking("2026-08-24", 600, 30, { companyId: 0, companyName: "", typeId: 0, typeName: "" }),
    ];
    expect(groupBy(supports, "company").map((g) => g.label)).toEqual(["Kunde A", "ohne Kunde"]);
    expect(groupBy(supports, "type").map((g) => g.label)).toEqual(["Remote", "ohne Art"]);
  });

  it("holds the overall sum", () => {
    const supports = [
      booking("2026-08-24", 540, 60, { ticketId: 1 }),
      booking("2026-08-24", 600, 45, { ticketId: 2 }),
      booking("2026-08-25", 540, 15, { ticketId: 3 }),
    ];
    expect(groupBy(supports, "ticket").reduce((n, g) => n + g.minutes, 0)).toBe(120);
  });

  it("sorts by label when the minutes tie", () => {
    // The booking order (ticket 9 first) contradicts the label order, so the
    // test checks the sort key and not merely the insertion order.
    const supports = [
      booking("2026-08-24", 540, 30, { ticketId: 9 }),
      booking("2026-08-24", 540, 30, { ticketId: 2 }),
    ];
    const groups = groupBy(supports, "ticket");
    expect(groups.map((g) => g.id)).toEqual(["2", "9"]);
  });

  it("gives an empty hint when every text is blank or only spaces", () => {
    const supports = [
      booking("2026-08-24", 540, 30, { ticketId: 4, text: "" }),
      booking("2026-08-25", 540, 15, { ticketId: 4, text: "   " }),
    ];
    expect(groupBy(supports, "ticket")[0].hint).toBe("");
  });

  it("lets the first text seen win a true tie in count and length", () => {
    const supports = [
      booking("2026-08-24", 540, 30, { ticketId: 4, text: "Rückruf" }),
      booking("2026-08-25", 540, 15, { ticketId: 4, text: "Kontakt" }),
    ];
    expect(groupBy(supports, "ticket")[0].hint).toBe("Rückruf");
  });
});

describe("topWithRest", () => {
  it("folds the tail without losing minutes", () => {
    const groups = groupBy(
      [1, 2, 3, 4, 5].map((id) => booking("2026-08-24", 540, id * 10, { ticketId: id })),
      "ticket",
    );
    const folded = topWithRest(groups, 3);
    expect(folded).toHaveLength(4);
    expect(folded[3]).toMatchObject({ id: "rest", label: "übrige", minutes: 10 + 20, count: 2 });
    expect(folded.reduce((n, g) => n + g.minutes, 0)).toBe(150);
  });

  it("leaves short lists untouched", () => {
    const groups = groupBy([booking("2026-08-24", 540, 60, { ticketId: 1 })], "ticket");
    expect(topWithRest(groups, 10)).toEqual(groups);
  });

  it("adds no rest at exactly limit groups", () => {
    const groups = groupBy(
      [1, 2, 3].map((id) => booking("2026-08-24", 540, id * 10, { ticketId: id })),
      "ticket",
    );
    expect(topWithRest(groups, 3)).toEqual(groups);
  });
});

describe("totals", () => {
  const range = { from: "2026-08-24", to: "2026-08-30" }; // Mon-Sun, 5 working days

  it("derives the target from working days, weekends excluded", () => {
    const result = totals([], range);
    expect(result.workdays).toBe(5);
    expect(result.targetMinutes).toBe(5 * 8 * 60);
    expect(result.minutes).toBe(0);
  });

  it("subtracts not-charged time and never counts internal time twice", () => {
    const supports = [
      booking("2026-08-24", 540, 120, { durationNotCharged: 30 }),
      booking("2026-08-25", 540, 60, { internal: true, durationNotCharged: 60 }),
    ];
    const result = totals(supports, range);
    expect(result.minutes).toBe(180);
    expect(result.internal).toBe(60);
    // only the non-internal booking adds to the not-charged time
    expect(result.notCharged).toBe(30);
    expect(result.billable).toBe(120 - 30);
  });

  it("separates cleared from open", () => {
    const supports = [
      booking("2026-08-24", 540, 60, { clearanceStatus: "CLEARED" }),
      booking("2026-08-25", 540, 30, { clearanceStatus: "" }),
    ];
    const result = totals(supports, range);
    expect(result.cleared).toBe(60);
    expect(result.open).toBe(30);
  });

  it("ignores bookings outside the range, in every tile it feeds", () => {
    const outside = [
      // The Friday before and the Monday after the Mon-Sun range.
      booking("2026-08-21", 540, 120, { internal: true, clearanceStatus: "CLEARED", durationNotCharged: 15 }),
      booking("2026-08-31", 540, 90, { durationNotCharged: 30 }),
    ];
    const inside = booking("2026-08-25", 540, 60, { clearanceStatus: "CLEARED" });
    const result = totals([...outside, inside], range);
    expect(result.minutes).toBe(60);
    expect(result.internal).toBe(0);
    expect(result.notCharged).toBe(0);
    expect(result.billable).toBe(60);
    expect(result.cleared).toBe(60);
    expect(result.open).toBe(0);
    // A day outside the range must not count as booked inside it either.
    expect(result.daysWithout).toEqual(["2026-08-24", "2026-08-26", "2026-08-27", "2026-08-28"]);
  });

  it("names only working days without a booking", () => {
    const result = totals([booking("2026-08-25", 540, 60)], range);
    expect(result.daysWithout).toEqual(["2026-08-24", "2026-08-26", "2026-08-27", "2026-08-28"]);
  });
});

describe("applyFacet", () => {
  const supports = [
    booking("2026-08-24", 540, 60, { ticketId: 5, companyId: 9, companyName: "Kunde A", typeId: 3, typeName: "Remote" }),
    booking("2026-08-25", 540, 30, { ticketId: 7, companyId: 9, companyName: "Kunde A", typeId: 4, typeName: "Vor Ort" }),
    booking("2026-08-26", 540, 15, { ticketId: 0, companyId: 2, companyName: "Kunde B", typeId: 3, typeName: "Remote" }),
  ];

  it("returns everything without a facet", () => {
    expect(applyFacet(supports, null)).toEqual(supports);
  });

  it("filters by ticket, customer and type", () => {
    expect(applyFacet(supports, { key: "ticket", id: "5" })).toHaveLength(1);
    expect(applyFacet(supports, { key: "ticket", id: "0" })).toHaveLength(1);
    expect(applyFacet(supports, { key: "company", id: "9" })).toHaveLength(2);
    expect(applyFacet(supports, { key: "type", id: "3" })).toHaveLength(2);
  });

  it("leaves the folded rest untouched", () => {
    expect(applyFacet(supports, { key: "ticket", id: "rest" })).toEqual(supports);
  });

  it("agrees with the totals over the filtered list", () => {
    const range = { from: "2026-08-24", to: "2026-08-30" };
    const filtered = applyFacet(supports, { key: "company", id: "9" });
    expect(totals(filtered, range).minutes).toBe(90);
  });
});
