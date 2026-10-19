import { describe, expect, it } from "vitest";
import { elapsedSeconds, formatElapsed, historyActivity, supportActivity, ticketAgeDays, ticketIdleDays } from "./activity.ts";

const at = (iso: string) => Date.parse(iso) / 1000;
const today = "2026-08-23";
const since = "2025-08-23";

describe("historyActivity", () => {
  it("takes the newest of comments and supports, never a mail", () => {
    const a = historyActivity({
      comments: [{ date: 100 }, { date: 300 }],
      supports: [{ date: 200 }],
      mails: [{ date: 900 }],
    });
    expect(a).toEqual({ at: 300, kind: "comment", historyRead: true });
    expect(historyActivity({ supports: [{ date: 400 }], comments: [{ date: 400 }] }).kind).toBe("comment");
    expect(historyActivity({ mails: [{ date: 1 }] })).toEqual({ at: 0, kind: "none", historyRead: true });
  });
});

describe("ticketIdleDays / ticketAgeDays", () => {
  const created = at("2026-08-01T09:00:00+02:00");
  it("counts days since the last trace", () => {
    const idle = ticketIdleDays(created, { at: at("2026-08-20T17:00:00+02:00"), kind: "support", historyRead: true }, today, since);
    expect(idle).toMatchObject({ days: 3, atLeast: false });
    expect(ticketAgeDays(created, today)).toBe(22);
  });
  it("uses the age when the history was read and empty", () => {
    expect(ticketIdleDays(created, { at: 0, kind: "none", historyRead: true }, today, since)).toMatchObject({ days: 22, atLeast: false });
  });
  it("says since when the idleness started, so the display can be finer than days", () => {
    const trace = at("2026-08-20T17:00:00+02:00");
    expect(ticketIdleDays(created, { at: trace, kind: "support", historyRead: true }, today, since).at).toBe(trace);
    // Nothing ever happened: the ticket has been idle since it was created.
    expect(ticketIdleDays(created, { at: 0, kind: "none", historyRead: true }, today, since).at).toBe(created);
    // Only a lower bound — there is no moment to point at.
    const old = at("2024-01-01T09:00:00+01:00");
    expect(ticketIdleDays(old, { at: 0, kind: "none", historyRead: false }, today, since).at).toBe(0);
  });

  it("gives a lower bound when only the windowed fallback was available", () => {
    const old = at("2024-01-01T09:00:00+01:00");
    const idle = ticketIdleDays(old, { at: 0, kind: "none", historyRead: false }, today, since);
    expect(idle).toMatchObject({ days: 365, atLeast: true });
    expect(ticketIdleDays(created, { at: 0, kind: "none", historyRead: false }, today, since)).toMatchObject({ days: 22, atLeast: false });
  });
});

describe("supportActivity", () => {
  it("keeps the newest support per ticket", () => {
    const m = supportActivity([{ ticketId: 1, date: 5 }, { ticketId: 1, date: 9 }, { ticketId: 2, date: 3 }, { date: 7 }]);
    expect([...m.entries()]).toEqual([[1, 9], [2, 3]]);
  });
});

describe("formatElapsed", () => {
  const now = at("2026-08-23T12:00:00+02:00");
  const ago = (seconds: number) => now - seconds;

  it("counts in minutes below the hour", () => {
    expect(formatElapsed(ago(60), now)).toBe("1 min");
    expect(formatElapsed(ago(12 * 60), now)).toBe("12 min");
    expect(formatElapsed(ago(59 * 60 + 59), now)).toBe("59 min");
  });

  it("switches to hours at the full hour and keeps them below the day", () => {
    expect(formatElapsed(ago(60 * 60), now)).toBe("1 h");
    expect(formatElapsed(ago(90 * 60), now)).toBe("1 h");
    expect(formatElapsed(ago(23 * 3600 + 59 * 60), now)).toBe("23 h");
  });

  it("switches to days at the full day", () => {
    expect(formatElapsed(ago(24 * 3600), now)).toBe("1 d");
    expect(formatElapsed(ago(3 * 24 * 3600 + 5 * 3600), now)).toBe("3 d");
  });

  it("says „jetzt“ under a minute and never counts backwards", () => {
    expect(formatElapsed(now, now)).toBe("jetzt");
    expect(formatElapsed(ago(59), now)).toBe("jetzt");
    // A timestamp from the future is a clock skew, not a negative age.
    expect(formatElapsed(now + 3600, now)).toBe("jetzt");
  });

  it("has nothing to show without a timestamp", () => {
    expect(formatElapsed(0, now)).toBe("—");
  });
});

describe("elapsedSeconds", () => {
  const now = at("2026-08-23T12:00:00+02:00");

  it("is the distance for sorting, zero when unknown or in the future", () => {
    expect(elapsedSeconds(now - 90, now)).toBe(90);
    expect(elapsedSeconds(0, now)).toBe(0);
    expect(elapsedSeconds(now + 90, now)).toBe(0);
  });
});
