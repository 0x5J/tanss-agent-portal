import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "./app.ts";
import { createPoller } from "./poller.ts";
import { createSharedSession } from "./shared-session.ts";
import { createFileStore, createMemoryStore } from "./store.ts";
import { reportName } from "../shared/report.ts";
import { EMPTY_FILTERS, type SavedView } from "../shared/filters.ts";
import type { TanssClient, TanssSession } from "./tanss.ts";
import { berlinDayRangeUnix } from "../shared/days.ts";

const SECRET = "x".repeat(32);
const SESSION: TanssSession = { employeeId: 7, apiKey: "k", refresh: "r", expire: 9_999_999_999 };
const SOC: SavedView = { id: "soc", name: "SOC", list: "all", filters: { ...EMPTY_FILTERS, department: ["SOC"] } };
const YESTERDAY = "2026-08-24";
const TODAY = "2026-08-25";
// The poller and the shared session must read the same clock: the session
// counts itself dead five days after `adopt`, so a real clock would let
// these tests rot the moment the wall date moved past that window.
const NOW = Date.parse(`${TODAY}T09:00:00+02:00`);

function storeWithYesterday() {
  const store = createMemoryStore();
  store.setViews(7, [SOC]);
  store.setReportLists(7, ["view:soc"]);
  store.setDashboard(7, [
    {
      day: YESTERDAY,
      samples: [
        { minute: 480, counts: { "view:soc": 12 } },
        { minute: 1080, counts: { "view:soc": 15 } },
      ],
      seen: { "view:soc": { "9": berlinDayRangeUnix(YESTERDAY).from + 9 * 3600 } },
      claims: [{ id: 9, title: "Phishing", minute: 600, assigneeId: 8, assigneeName: "Micha", fromId: 0, fromName: "" }],
      assignees: { "9": 8 },
      names: { "8": "Micha" },
    },
  ]);
  return store;
}

function tanssFake(): TanssClient {
  return {
    login: async () => ({ ...SESSION }),
    ticketList: async (_s: unknown, kind: string) => ({
      items: kind === "general" ? [{ id: 20, title: "Neu", statusId: 2, assignedToDepartmentId: 4 }] : [],
      linked: { departments: { "4": { name: "SOC" } }, ticketStates: { "2": { name: "Neu" } } },
      waitingStates: [],
    }),
  } as unknown as TanssClient;
}

describe("day reports", () => {
  it("writes the finished day at the first measurement of the next one", async () => {
    const store = storeWithYesterday();
    const shared = createSharedSession({ store, now: () => NOW });
    shared.adopt(SESSION, Math.floor(NOW / 1000));
    const written: string[] = [];
    const poller = createPoller({
      tanss: tanssFake(),
      store,
      shared,
      now: () => NOW,
      onReport: (name) => written.push(name),
    });
    await poller.tick();
    expect(written).toEqual([reportName(YESTERDAY, "view:soc")]);
    const html = store.report(7, written[0]!)!;
    expect(html).toContain("<b>15</b>");
    expect(html).toContain("Micha");
    expect(html).toContain("Phishing");
    // Today is not finished, so it gets no report yet.
    expect(store.reports(7).map((r) => r.day)).toEqual([YESTERDAY]);
  });

  it("writes each day and list only once", async () => {
    const store = storeWithYesterday();
    const shared = createSharedSession({ store, now: () => NOW });
    shared.adopt(SESSION, Math.floor(NOW / 1000));
    const written: string[] = [];
    const poller = createPoller({
      tanss: tanssFake(),
      store,
      shared,
      now: () => NOW,
      onReport: (name) => written.push(name),
    });
    await poller.tick();
    await poller.tick();
    await poller.tick();
    expect(written).toHaveLength(1);
  });

  it("writes nothing when no list was asked for", async () => {
    const store = storeWithYesterday();
    store.setReportLists(7, []);
    const shared = createSharedSession({ store, now: () => NOW });
    shared.adopt(SESSION, Math.floor(NOW / 1000));
    const poller = createPoller({ tanss: tanssFake(), store, shared, now: () => NOW });
    await poller.tick();
    expect(store.reports(7)).toEqual([]);
  });

  it("keeps the archive on disk as plain HTML", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reports-"));
    try {
      const store = createFileStore(dir);
      store.saveReport(7, "2026-08-24_view-soc.html", "<!doctype html><p>Tag</p>");
      expect(readFileSync(path.join(dir, "reports", "7", "2026-08-24_view-soc.html"), "utf8")).toBe(
        "<!doctype html><p>Tag</p>",
      );
      expect(createFileStore(dir).reports(7)).toMatchObject([{ name: "2026-08-24_view-soc.html", day: "2026-08-24" }]);
      // Another employee's archive stays separate.
      expect(createFileStore(dir).reports(9)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a name that would leave the archive", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reports-"));
    try {
      const store = createFileStore(dir);
      store.saveReport(7, "../../escape.html", "<p>nein</p>");
      expect(store.report(7, "../../escape.html")).toBeNull();
      expect(store.reports(7)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the archive over the API", () => {
  it("lists reports, serves one as HTML and 404s the rest", async () => {
    const store = createMemoryStore();
    store.saveReport(7, "2026-08-24_view-soc.html", "<!doctype html><p>Tag</p>");
    const app = await buildApp({ sessionSecret: SECRET, tanss: tanssFake(), store, enableRateLimit: false });
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "sb", password: "pw", token: "123456" } });
    const raw = login.headers["set-cookie"];
    const cookie = Array.isArray(raw) ? raw[0] : String(raw ?? "");

    expect((await app.inject({ method: "GET", url: "/me/reports", headers: { cookie } })).json().reports).toHaveLength(1);
    const one = await app.inject({ method: "GET", url: "/me/reports/2026-08-24_view-soc.html", headers: { cookie } });
    expect(one.headers["content-type"]).toContain("text/html");
    expect(one.body).toContain("<p>Tag</p>");
    expect((await app.inject({ method: "GET", url: "/me/reports/gibtsnicht.html", headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/me/reports" })).statusCode).toBe(401);
  });

  it("stores which lists get a report", async () => {
    const store = createMemoryStore();
    const app = await buildApp({ sessionSecret: SECRET, tanss: tanssFake(), store, enableRateLimit: false });
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "sb", password: "pw", token: "123456" } });
    const raw = login.headers["set-cookie"];
    const cookie = Array.isArray(raw) ? raw[0] : String(raw ?? "");
    const res = await app.inject({ method: "PUT", url: "/me/reports/lists", headers: { cookie }, payload: { lists: ["view:soc", 42] } });
    expect(res.json().lists).toEqual(["view:soc"]);
    expect(store.reportLists(7)).toEqual(["view:soc"]);
  });
});
