import { describe, expect, it } from "vitest";
import {
  MAX_ROUTINES,
  durationForGap,
  mergeSavedRoutines,
  splitRoutines,
  normaliseRange,
  parseRoutines,
  routinesForGap,
  type Routine,
} from "./routines.ts";

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: "r1",
  text: "Mail und Monitoring",
  minMinutes: 15,
  maxMinutes: 45,
  companyId: null,
  companyLabel: "",
  ticketId: null,
  ticketLabel: "",
  typeId: null,
  ...over,
});

describe("normaliseRange", () => {
  it("corrects a range that came the wrong way round", () => {
    expect(normaliseRange(60, 15)).toEqual({ minMinutes: 15, maxMinutes: 60 });
    expect(normaliseRange(30, 30)).toEqual({ minMinutes: 30, maxMinutes: 30 });
  });

  it("keeps it inside sane bounds", () => {
    expect(normaliseRange(0, 0)).toEqual({ minMinutes: 1, maxMinutes: 1 });
    expect(normaliseRange(-5, 99_999)).toEqual({ minMinutes: 1, maxMinutes: 8 * 60 });
  });
});

describe("durationForGap", () => {
  it("takes as much as it may, never more than the gap", () => {
    expect(durationForGap(routine(), 120)).toBe(45);
    expect(durationForGap(routine(), 30)).toBe(30);
    expect(durationForGap(routine(), 45)).toBe(45);
  });

  it("declines a gap too short for it", () => {
    expect(durationForGap(routine(), 10)).toBeNull();
    expect(durationForGap(routine(), 15)).toBe(15);
  });

  it("offers only what fits", () => {
    const list = [routine({ id: "a", minMinutes: 15 }), routine({ id: "b", minMinutes: 90, maxMinutes: 120 })];
    expect(routinesForGap(list, 60).map((r) => r.id)).toEqual(["a"]);
    expect(routinesForGap(list, 120).map((r) => r.id)).toEqual(["a", "b"]);
    expect(routinesForGap(list, 5)).toEqual([]);
  });
});

describe("parseRoutines", () => {
  it("drops what has no text and caps the list", () => {
    expect(parseRoutines([{ text: "  " }, { text: "Mail", minMinutes: 15, maxMinutes: 30 }])).toHaveLength(1);
    expect(parseRoutines(Array.from({ length: 50 }, (_, i) => ({ text: `R${i}` })))).toHaveLength(MAX_ROUTINES);
    expect(parseRoutines("kaputt")).toEqual([]);
  });

  it("lets a routine point at one target, never both", () => {
    const [r] = parseRoutines([{ text: "Triage", ticketId: 4711, ticketLabel: "#4711", companyId: 5, companyLabel: "Kranz" }]);
    expect(r).toMatchObject({ ticketId: 4711, companyId: null, companyLabel: "" });
    const [c] = parseRoutines([{ text: "Triage", companyId: 5, companyLabel: "Kranz" }]);
    expect(c).toMatchObject({ ticketId: null, companyId: 5, companyLabel: "Kranz" });
  });

  it("corrects a reversed range instead of dropping the entry", () => {
    const [r] = parseRoutines([{ text: "Mail", minMinutes: 60, maxMinutes: 20 }]);
    expect(r).toMatchObject({ minMinutes: 20, maxMinutes: 60 });
  });
});

describe("splitRoutines / mergeSavedRoutines", () => {
  it("keeps a row that is still being filled in", () => {
    const list = [routine({ id: "a" }), routine({ id: "neu", text: "" })];
    const { complete, pending } = splitRoutines(list);
    expect(complete.map((r) => r.id)).toEqual(["a"]);
    expect(pending.map((r) => r.id)).toEqual(["neu"]);
    // The server answers without the empty one; it must not vanish here.
    expect(mergeSavedRoutines(complete, pending).map((r) => r.id)).toEqual(["a", "neu"]);
  });

  it("does not duplicate a row the server already knows", () => {
    const saved = [routine({ id: "a" })];
    expect(mergeSavedRoutines(saved, [routine({ id: "a", text: "" })]).map((r) => r.id)).toEqual(["a"]);
  });

  it("treats whitespace as no text", () => {
    expect(splitRoutines([routine({ text: "   " })]).complete).toEqual([]);
  });
});
