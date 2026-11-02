import { describe, expect, it } from "vitest";
import { formatRoute, parseRoute } from "./route.ts";

describe("parseRoute", () => {
  it("starts on the start page without an address", () => {
    expect(parseRoute("")).toEqual({ view: "today", ticket: null, day: null });
  });

  it("reads the view", () => {
    expect(parseRoute("#/tickets")).toEqual({ view: "tickets", ticket: null, day: null });
  });

  it("reads an open ticket on any view", () => {
    expect(parseRoute("#/tickets?ticket=4711")).toEqual({ view: "tickets", ticket: 4711, day: null });
    expect(parseRoute("#/today?ticket=12")).toEqual({ view: "today", ticket: 12, day: null });
  });

  it("reads the day of the day sheet", () => {
    expect(parseRoute("#/times/2026-10-26")).toEqual({ view: "times", ticket: null, day: "2026-10-26" });
    expect(parseRoute("#/times/2026-10-26?ticket=5")).toEqual({ view: "times", ticket: 5, day: "2026-10-26" });
  });

  it("falls back to the start page for an unknown view", () => {
    expect(parseRoute("#/gibtsnicht")).toEqual({ view: "today", ticket: null, day: null });
    expect(parseRoute("#/constructor")).toEqual({ view: "today", ticket: null, day: null });
  });

  it("ignores a ticket that is no ticket number", () => {
    for (const ticket of ["abc", "0", "-3", "1.5", "99999999999999999999"]) {
      expect(parseRoute(`#/tickets?ticket=${ticket}`)).toEqual({ view: "tickets", ticket: null, day: null });
    }
  });

  it("ignores a day that does not exist and a day on another view", () => {
    expect(parseRoute("#/times/2026-13-45").day).toBeNull();
    expect(parseRoute("#/times/2026-02-30").day).toBeNull();
    expect(parseRoute("#/times/morgen").day).toBeNull();
    expect(parseRoute("#/tickets/2026-10-26").day).toBeNull();
  });
});

describe("formatRoute", () => {
  it("writes each part so that it reads back the same", () => {
    const routes = [
      { view: "today", ticket: null, day: null },
      { view: "tickets", ticket: 4711, day: null },
      { view: "times", ticket: null, day: "2026-10-26" },
      { view: "times", ticket: 5, day: "2026-10-26" },
    ] as const;
    for (const route of routes) expect(parseRoute(formatRoute(route))).toEqual(route);
    expect(formatRoute(routes[3])).toBe("#/times/2026-10-26?ticket=5");
  });

  it("leaves the day out on every other view", () => {
    expect(formatRoute({ view: "tickets", ticket: null, day: "2026-10-26" })).toBe("#/tickets");
  });
});
