import { describe, expect, it } from "vitest";
import {
  buildSuggestions,
  buildWindows,
  collectSessions,
  commentMinutes,
  endBefore,
  parseDurationExpression,
  parseRules,
  parseWindow,
  parseWorkSessions,
  type IssueActivity,
  type ImportRules,
} from "./import.ts";
import { berlinDayRangeUnix } from "./days.ts";

const DAY = "2026-08-25";
const dayFrom = berlinDayRangeUnix(DAY).from;
const iso = (h: number, m = 0) => new Date((dayFrom + h * 3600 + m * 60) * 1000).toISOString();

const rules = (over: Partial<ImportRules> = {}): ImportRules => ({
  timeSource: "comment",
  states: ["In Progress"],
  sessionHours: 4,
  window: "06:00-20:00",
  dayMaxHours: 10,
  roundMinutes: 15,
  ...over,
});

const activity = (over: Partial<IssueActivity> = {}): IssueActivity => ({
  issue: "ESK-499",
  title: "Firewall-Cluster",
  project: "SOC Betrieb",
  url: "",
  windows: [{ start: 9 * 60, end: 10 * 60, state: "In Progress" }],
  commentMinutes: 0,
  summary: "",
  historyTruncated: false,
  sessions: [],
  ...over,
});

describe("parseDurationExpression", () => {
  it("reads the ways a duration gets written down", () => {
    expect(parseDurationExpression("2 h 9 min")).toBe(129);
    expect(parseDurationExpression("23 min")).toBe(23);
    expect(parseDurationExpression("1:30 h")).toBe(90);
    expect(parseDurationExpression("ca. 11 h 40 min")).toBe(700);
    expect(parseDurationExpression("rund 45 min")).toBe(45);
    expect(parseDurationExpression("1,5 h")).toBe(90);
    expect(parseDurationExpression("3 Stunden")).toBe(180);
  });

  it("reads nothing where no unit stands", () => {
    expect(parseDurationExpression("2026-08-14")).toBe(0);
    expect(parseDurationExpression("42")).toBe(0);
  });
});

describe("parseWorkSessions", () => {
  it("stops the expression at a comma or bracket", () => {
    const [session] = parseWorkSessions("Analyse (Dauer: 1 h 9 min, davon 40 min Recherche)");
    expect(session!.minutes).toBe(69);
  });

  it("takes every marker in a note", () => {
    expect(commentMinutes([{ body: "Dauer: 30 min" }, { body: "x Dauer: 1 h; y Dauer: 15 min" }])).toBe(105);
  });

  it("takes the clock time right before the marker as the end", () => {
    expect(endBefore("2026-08-14 Notiz um 14:04 fertig")).toBe(14 * 60 + 4);
    expect(endBefore("ohne Uhrzeit")).toBeNull();
  });
});

describe("collectSessions", () => {
  it("derives the start from end minus duration", () => {
    const sessions = collectSessions([{ createdAt: iso(15), body: "Bis 14:30 gearbeitet (Dauer: 45 min)" }], dayFrom);
    expect(sessions).toEqual([{ start: 13 * 60 + 45, minutes: 45 }]);
  });

  it("falls back to when the note was written", () => {
    const sessions = collectSessions([{ createdAt: iso(11), body: "Dauer: 30 min" }], dayFrom);
    expect(sessions).toEqual([{ start: 10 * 60 + 30, minutes: 30 }]);
  });
});

describe("buildWindows", () => {
  it("replays the transitions as ranges of the day", () => {
    const windows = buildWindows(
      [
        { createdAt: iso(9), fromState: { name: "Todo" }, toState: { name: "In Progress" } },
        { createdAt: iso(11), fromState: { name: "In Progress" }, toState: { name: "Done" } },
      ],
      dayFrom,
    );
    expect(windows).toEqual([
      { start: 0, end: 540, state: "Todo" },
      { start: 540, end: 660, state: "In Progress" },
      { start: 660, end: 1441, state: "Done" },
    ]);
  });

  it("marks a window still open at midnight instead of closing it quietly", () => {
    const windows = buildWindows([{ createdAt: iso(9), toState: { name: "In Progress" } }], dayFrom);
    expect(windows[windows.length - 1]!.end).toBe(1441);
  });
});

describe("buildSuggestions", () => {
  it("counts only the states that are meant to count", () => {
    const [suggestion] = buildSuggestions(
      [activity({ windows: [
        { start: 9 * 60, end: 10 * 60, state: "In Progress" },
        { start: 10 * 60, end: 12 * 60, state: "Done" },
      ] })],
      rules({ timeSource: "history" }),
    );
    expect(suggestion!.minutes).toBe(60);
  });

  it("says what it cut outside the working window", () => {
    const [suggestion] = buildSuggestions(
      [activity({ windows: [{ start: 4 * 60, end: 8 * 60, state: "In Progress" }] })],
      rules({ timeSource: "history" }),
    );
    expect(suggestion!.minutes).toBe(120);
    expect(suggestion!.flags.map((f) => f.label)).toContain("außerhalb Arbeitsfenster");
    expect(suggestion!.flags.find((f) => f.label === "außerhalb Arbeitsfenster")!.reason).toContain("2:00 Std.");
  });

  it("caps a single sitting and says so", () => {
    const [suggestion] = buildSuggestions(
      [activity({ windows: [{ start: 8 * 60, end: 18 * 60, state: "In Progress" }] })],
      rules({ timeSource: "history", sessionHours: 4 }),
    );
    expect(suggestion!.minutes).toBe(240);
    expect(suggestion!.flags.map((f) => f.label)).toContain("gekappt");
  });

  it("prefers the noted time and names what the history would have said", () => {
    const [suggestion] = buildSuggestions(
      [activity({ commentMinutes: 100, sessions: [{ start: 13 * 60, minutes: 100 }] })],
      rules(),
    );
    // 100 rounded to the 15 grid.
    expect(suggestion!.minutes).toBe(105);
    expect(suggestion!.raw).toBe(100);
    expect(suggestion!.start).toBe(13 * 60);
    expect(suggestion!.flags[0]!.reason).toContain("Statusverlauf allein ergäbe 60 min");
  });

  it("folds several sittings into one booking and says how many", () => {
    const [suggestion] = buildSuggestions(
      [activity({ commentMinutes: 90, sessions: [{ start: 9 * 60, minutes: 45 }, { start: 14 * 60, minutes: 45 }] })],
      rules(),
    );
    expect(suggestion!.flags.map((f) => f.label)).toContain("2 Sitzungen");
    expect(suggestion!.flags.find((f) => f.label === "2 Sitzungen")!.reason).toContain("09:00–09:45, 14:00–14:45");
  });

  it("marks a missing time note instead of pretending", () => {
    const [suggestion] = buildSuggestions([activity()], rules());
    expect(suggestion!.flags.map((f) => f.label)).toContain("ohne Zeitangabe");
  });

  it("flags a divergence when the history decides", () => {
    const [suggestion] = buildSuggestions([activity({ commentMinutes: 200 })], rules({ timeSource: "history" }));
    expect(suggestion!.flags.map((f) => f.label)).toContain("prüfen");
  });

  it("flags the day cap on every suggestion but cuts nothing", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      activity({ issue: `ESK-${i}`, commentMinutes: 150, sessions: [{ start: 8 * 60, minutes: 150 }] }),
    );
    const suggestions = buildSuggestions(many, rules({ dayMaxHours: 10 }));
    expect(suggestions.reduce((sum, s) => sum + s.minutes, 0)).toBe(900);
    expect(suggestions.every((s) => s.flags.some((f) => f.label === "Tagessumme"))).toBe(true);
    // Nothing was shortened — the person decides which one is wrong.
    expect(suggestions.every((s) => s.minutes === 150)).toBe(true);
  });

  it("drops what rounds to nothing", () => {
    expect(buildSuggestions([activity({ windows: [] })], rules({ timeSource: "history" }))).toEqual([]);
  });
});

describe("parseRules / parseWindow", () => {
  it("keeps sane values and falls back on the rest", () => {
    expect(parseRules({ timeSource: "history", sessionHours: 2, roundMinutes: 30, window: "07:00-19:00" })).toMatchObject({
      timeSource: "history", sessionHours: 2, roundMinutes: 30, window: "07:00-19:00",
    });
    expect(parseRules({ roundMinutes: 7, sessionHours: 99, window: "kaputt" })).toMatchObject({
      roundMinutes: 15, sessionHours: 4, window: "06:00-20:00",
    });
  });

  it("reads a window and refuses a reversed one", () => {
    expect(parseWindow("07:30-18:00")).toEqual({ from: 450, to: 1080 });
    expect(parseWindow("20:00-06:00")).toEqual({ from: 360, to: 1200 });
  });
});
