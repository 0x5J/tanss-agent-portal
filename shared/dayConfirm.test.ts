import { describe, expect, it } from "vitest";
import { dayConfirmState, openDaysHint, parseDayStatus, shortYmd } from "./dayConfirm.ts";

const OPEN = { mustConfirm: true, openDays: ["2026-10-26", "2026-10-27", "2026-11-02"] };

describe("parseDayStatus", () => {
  it("reads the duty and sorts the open days oldest first", () => {
    expect(parseDayStatus({ hasToConfirm: true, notConfirmedDays: ["2026-10-27", "2026-10-26"] })).toEqual({
      mustConfirm: true,
      openDays: ["2026-10-26", "2026-10-27"],
    });
  });

  it("drops anything that is not a day", () => {
    expect(parseDayStatus({ hasToConfirm: true, notConfirmedDays: ["2026-10-26", "gestern", 5, null] }).openDays).toEqual([
      "2026-10-26",
    ]);
  });

  it("treats an answer it cannot read as no duty, so nothing shows", () => {
    for (const content of [undefined, null, [], "x", { notConfirmedDays: ["2026-10-26"] }]) {
      expect(parseDayStatus(content)).toEqual({ mustConfirm: false, openDays: [] });
    }
  });
});

describe("dayConfirmState", () => {
  const today = "2026-11-02";

  it("offers the button on the oldest open day", () => {
    expect(dayConfirmState(OPEN, "2026-10-26", today, true)).toEqual({ kind: "open" });
  });

  it("offers the button even without bookings, since TANSS lists the day as open", () => {
    expect(dayConfirmState(OPEN, "2026-10-26", today, false)).toEqual({ kind: "open" });
  });

  it("points a younger open day at the oldest", () => {
    expect(dayConfirmState(OPEN, "2026-10-27", today, true)).toEqual({ kind: "blocked", oldest: "2026-10-26" });
  });

  it("lets today be confirmed once it is the oldest", () => {
    expect(dayConfirmState({ mustConfirm: true, openDays: [today] }, today, today, true)).toEqual({ kind: "open" });
  });

  it("calls a past day with bookings outside the list confirmed", () => {
    expect(dayConfirmState(OPEN, "2026-10-23", today, true)).toEqual({ kind: "confirmed" });
  });

  it("says nothing about a day without bookings outside the list, it may be a weekend", () => {
    expect(dayConfirmState(OPEN, "2026-10-24", today, false)).toEqual({ kind: "none" });
  });

  it("says nothing about a future day", () => {
    expect(dayConfirmState(OPEN, "2026-11-03", today, true)).toEqual({ kind: "none" });
  });

  it("shows nothing to someone who does not have to confirm", () => {
    expect(dayConfirmState({ mustConfirm: false, openDays: [] }, "2026-10-23", today, true)).toEqual({ kind: "none" });
  });

  it("shows nothing before the status is known", () => {
    expect(dayConfirmState(null, "2026-10-26", today, true)).toEqual({ kind: "none" });
  });
});

describe("openDaysHint", () => {
  const today = "2026-11-02";

  it("counts the days before today and names the oldest", () => {
    expect(openDaysHint(OPEN, today)).toEqual({ oldest: "2026-10-26", text: "2 Tage sind noch nicht bestätigt, der älteste ist der 26.10." });
  });

  it("words a single day on its own", () => {
    expect(openDaysHint({ mustConfirm: true, openDays: ["2026-10-30", today] }, today)).toEqual({
      oldest: "2026-10-30",
      text: "Der 30.10. ist noch nicht bestätigt.",
    });
  });

  it("stays quiet when only today is open", () => {
    expect(openDaysHint({ mustConfirm: true, openDays: [today] }, today)).toBeNull();
  });

  it("stays quiet without a duty or a status", () => {
    expect(openDaysHint({ mustConfirm: false, openDays: [] }, today)).toBeNull();
    expect(openDaysHint(null, today)).toBeNull();
  });
});

describe("shortYmd", () => {
  it("writes a day the German short way", () => {
    expect(shortYmd("2026-10-26")).toBe("26.10.");
    expect(shortYmd("2026-11-02")).toBe("02.11.");
  });
});
