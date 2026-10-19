import { describe, expect, it } from "vitest";
import {
  berlinDayRangeUnix,
  berlinNoonUnix,
  berlinYmd,
  buildFourteenDayWindow,
  sumMinutesByDay,
} from "./days.ts";

describe("berlinYmd", () => {
  it("maps a CEST unix timestamp to the Berlin calendar day", () => {
    const unix = Math.floor(Date.parse("2026-08-19T22:30:00Z") / 1000);
    expect(berlinYmd(unix)).toBe("2026-08-20");
  });

  it("keeps a morning UTC instant on the same Berlin day in winter", () => {
    const unix = Math.floor(Date.parse("2026-01-15T10:00:00Z") / 1000);
    expect(berlinYmd(unix)).toBe("2026-01-15");
  });
});

describe("berlinNoonUnix", () => {
  it("is 12:00 CEST in August", () => {
    expect(berlinNoonUnix("2026-08-19")).toBe(
      Math.floor(Date.parse("2026-08-19T12:00:00+02:00") / 1000),
    );
  });

  it("is 12:00 CET in January", () => {
    expect(berlinNoonUnix("2026-01-15")).toBe(
      Math.floor(Date.parse("2026-01-15T12:00:00+01:00") / 1000),
    );
  });
});

describe("berlinDayRangeUnix", () => {
  it("covers midnight to end of a CEST day", () => {
    const range = berlinDayRangeUnix("2026-08-19");
    expect(range.from).toBe(
      Math.floor(Date.parse("2026-08-19T00:00:00+02:00") / 1000),
    );
    expect(range.to).toBe(
      Math.floor(Date.parse("2026-08-19T23:59:59+02:00") / 1000),
    );
  });
});

describe("sumMinutesByDay", () => {
  it("sums durations on the Berlin calendar day of each support", () => {
    const eveningUtc = Math.floor(Date.parse("2026-08-19T22:30:00Z") / 1000);
    const morning = Math.floor(Date.parse("2026-08-19T08:00:00+02:00") / 1000);
    const totals = sumMinutesByDay([
      { date: morning, duration: 60 },
      { date: eveningUtc, duration: 30 },
    ]);
    expect(totals["2026-08-19"]).toBe(60);
    expect(totals["2026-08-20"]).toBe(30);
  });
});

describe("buildFourteenDayWindow", () => {
  it("returns today plus the previous 13 days, oldest first", () => {
    const now = Date.parse("2026-08-19T15:00:00+02:00");
    const window = buildFourteenDayWindow(now);
    expect(window).toHaveLength(14);
    expect(window[0]).toBe("2026-08-06");
    expect(window[13]).toBe("2026-08-19");
  });
});
