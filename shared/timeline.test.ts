import { describe, expect, it } from "vitest";
import {
  WINDOW_END,
  buildBlocks,
  clampStart,
  findClashes,
  formatHours,
  nextFreeStart,
  snapMinute,
  supportsOfDay,
  toSupport,
  type Support,
} from "./timeline.ts";

const at = (iso: string) => Date.parse(iso) / 1000;
const support = (id: number, iso: string, duration: number): Support => ({
  ...toSupport({}, {}),
  id,
  date: at(iso),
  duration,
  ticketId: 0,
  companyName: "",
  text: "",
  typeName: "",
  location: "OFFICE",
});

describe("buildBlocks", () => {
  it("names the gaps between supports inside the window", () => {
    const blocks = buildBlocks([
      support(1, "2026-08-20T08:00:00+02:00", 75),
      support(2, "2026-08-20T13:00:00+02:00", 120),
    ]);
    const gaps = blocks.filter((b) => b.kind === "gap").map((b) => [b.start, b.end]);
    expect(gaps).toEqual([
      [7 * 60, 8 * 60],
      [9 * 60 + 15, 13 * 60],
      [15 * 60, 19 * 60],
    ]);
  });

  it("yields no gaps for an empty day", () => {
    expect(buildBlocks([])).toEqual([]);
  });

  it("ignores gaps shorter than 15 minutes", () => {
    const blocks = buildBlocks([
      support(1, "2026-08-20T07:00:00+02:00", 60),
      support(2, "2026-08-20T08:10:00+02:00", 60),
    ]);
    expect(blocks.filter((b) => b.kind === "gap").map((b) => b.start)).toEqual([9 * 60 + 10]);
  });
});

describe("supportsOfDay", () => {
  it("filters by Berlin day", () => {
    const all = [support(1, "2026-08-20T23:30:00+02:00", 10), support(2, "2026-08-21T00:10:00+02:00", 10)];
    expect(supportsOfDay(all, "2026-08-21").map((s) => s.id)).toEqual([2]);
  });
});

describe("toSupport / formatHours", () => {
  it("resolves names and formats decimal hours with comma", () => {
    const s = toSupport(
      { id: 1, date: 5, duration: 30, companyId: 7, typeId: 2 },
      { companies: { "7": { name: "Kranz" } }, supportTypes: { "2": { name: "Remote" } } },
    );
    expect(s.companyName).toBe("Kranz");
    expect(s.typeName).toBe("Remote");
    expect(formatHours(135)).toBe("2,25 h");
  });
});

describe("Stufe 1: Raster, Startvorschlag, Überlappung", () => {
  it("suggests the next quarter hour after the last booking", () => {
    expect(nextFreeStart([])).toBe(8 * 60);
    expect(nextFreeStart([support(1, "2026-08-20T09:00:00+02:00", 50)])).toBe(10 * 60);
    expect(nextFreeStart([support(1, "2026-08-20T09:00:00+02:00", 40)])).toBe(9 * 60 + 45);
    // Never past the end of the window.
    expect(nextFreeStart([support(1, "2026-08-20T18:30:00+02:00", 120)])).toBe(WINDOW_END - 15);
  });

  it("snaps to quarter hours", () => {
    expect(snapMinute(9 * 60 + 7)).toBe(9 * 60);
    expect(snapMinute(9 * 60 + 8)).toBe(9 * 60 + 15);
  });

  it("keeps a booking inside the window without shortening it", () => {
    expect(clampStart(18 * 60, 120)).toBe(WINDOW_END - 120);
    expect(clampStart(-30, 60)).toBe(0);
    expect(clampStart(10 * 60, 60)).toBe(10 * 60);
  });

  it("names overlaps and ignores the booking being edited", () => {
    const day = [
      support(1, "2026-08-20T09:00:00+02:00", 60),
      support(2, "2026-08-20T11:00:00+02:00", 30),
    ];
    expect(findClashes(9 * 60 + 30, 60, day).map((s) => s.id)).toEqual([1]);
    // Touching, not overlapping.
    expect(findClashes(10 * 60, 60, day)).toEqual([]);
    expect(findClashes(9 * 60, 60, day, 1)).toEqual([]);
    expect(findClashes(8 * 60, 4 * 60, day).map((s) => s.id)).toEqual([1, 2]);
  });
});
