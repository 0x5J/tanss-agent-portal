import { describe, expect, it } from "vitest";
import { formatHm, parseDuration } from "./duration.ts";

describe("parseDuration", () => {
  it("reads the forms people actually type", () => {
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("1,5h")).toBe(90);
    expect(parseDuration("1.5 h")).toBe(90);
    expect(parseDuration("45min")).toBe(45);
    expect(parseDuration("45 m")).toBe(45);
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("1h30")).toBe(90);
    expect(parseDuration("1h30min")).toBe(90);
    expect(parseDuration("0,25h")).toBe(15);
    expect(parseDuration(" 60 ")).toBe(60);
  });

  it("refuses what it cannot read instead of guessing", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("eine Stunde")).toBeNull();
    expect(parseDuration("1:70")).toBeNull();
    expect(parseDuration("1h70")).toBeNull();
    expect(parseDuration("-30")).toBeNull();
    expect(parseDuration("1,5")).toBeNull();
  });
});

describe("formatHm", () => {
  it("writes minutes back as hours and minutes", () => {
    expect(formatHm(90)).toBe("1:30");
    expect(formatHm(45)).toBe("0:45");
    expect(formatHm(600)).toBe("10:00");
    expect(formatHm(0)).toBe("0:00");
  });

  it("survives a round trip", () => {
    for (const minutes of [15, 45, 90, 125, 480]) {
      expect(parseDuration(formatHm(minutes))).toBe(minutes);
    }
  });
});
