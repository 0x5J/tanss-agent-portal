import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileStore, createMemoryStore } from "./store.ts";
import { createPoller } from "./poller.ts";
import { createSharedSession } from "./shared-session.ts";
import {
  claimsByEmployee,
  claimsFromDays,
  historyForList,
  mergeClaimEntries,
  type ClaimEntry,
} from "../shared/dashboard.ts";
import type { TanssClient, TanssSession } from "./tanss.ts";
import { EMPTY_FILTERS, type SavedView } from "../shared/filters.ts";

const SESSION: TanssSession = { employeeId: 7, apiKey: "k", refresh: "r", expire: 9_999_999_999 };
const entry = (over: Partial<ClaimEntry> = {}): ClaimEntry => ({
  day: "2026-08-25",
  id: 1,
  title: "T",
  minute: 600,
  assigneeId: 8,
  assigneeName: "Micha",
  fromId: 0,
  fromName: "",
  lists: ["view:soc"],
  ...over,
});

describe("claim history in the file store", () => {
  it("appends, survives a restart and filters by day", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claims-"));
    try {
      const store = createFileStore(dir);
      store.appendClaims(7, [entry(), entry({ id: 2, day: "2026-07-01" })]);
      store.appendClaims(7, [entry({ id: 3, assigneeName: "Sören", assigneeId: 7 })]);
      // Another employee's history must not leak into this one.
      store.appendClaims(9, [entry({ id: 99 })]);

      // A fresh store: the log is read from disk, not from memory.
      const reopened = createFileStore(dir);
      const all = reopened.claimHistory(7, "2026-01-01");
      expect(all.map((e) => e.id)).toEqual([1, 2, 3]);
      expect(reopened.claimHistory(7, "2026-08-01").map((e) => e.id)).toEqual([1, 3]);
      expect(reopened.claimHistory(9, "2026-01-01").map((e) => e.id)).toEqual([99]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a broken line instead of losing the rest", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claims-"));
    try {
      const store = createFileStore(dir);
      store.appendClaims(7, [entry()]);
      require("node:fs").appendFileSync(path.join(dir, "claims.jsonl"), "{kaputt\n");
      store.appendClaims(7, [entry({ id: 5 })]);
      expect(createFileStore(dir).claimHistory(7, "2026-01-01").map((e) => e.id)).toEqual([1, 5]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the collector writes the history", () => {
  it("records a takeover once, with the lists it belonged to", async () => {
    const store = createMemoryStore();
    const soc: SavedView = { id: "soc", name: "SOC", list: "all", filters: { ...EMPTY_FILTERS, department: ["SOC"] } };
    store.setViews(7, [soc]);
    let board = [
      { id: 9, title: "Phishing", statusId: 2, assignedToDepartmentId: 4 },
      { id: 10, title: "Drucker", statusId: 2 },
    ];
    const linked = { departments: { "4": { name: "SOC" } }, employees: { "8": { name: "Micha" } }, ticketStates: { "2": { name: "Neu" } } };
    const tanss = {
      ticketList: async (_s: unknown, kind: string) => ({
        items: kind === "general" ? board.filter((b) => !("assignedToEmployeeId" in b)) : kind === "technician" ? board.filter((b) => "assignedToEmployeeId" in b) : [],
        linked,
        waitingStates: [],
      }),
    } as unknown as TanssClient;
    const shared = createSharedSession({ store });
    shared.adopt(SESSION, Math.floor(Date.now() / 1000));
    const poller = createPoller({ tanss, store, shared });

    await poller.tick();
    expect(store.claimHistory(7, "2000-01-01")).toHaveLength(0);

    board = board.map((b) => (b.id === 9 ? { ...b, assignedToEmployeeId: 8 } : b));
    await poller.tick();
    const history = store.claimHistory(7, "2000-01-01");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: 9, assigneeName: "Micha", fromId: 0 });
    expect(history[0]!.lists).toContain("view:soc");

    // A further measurement without a change must not write it a second time.
    await poller.tick();
    expect(store.claimHistory(7, "2000-01-01")).toHaveLength(1);
  });

  it("keeps the list a ticket was taken out of", async () => {
    const store = createMemoryStore();
    let board: Record<string, unknown>[] = [{ id: 9, title: "Phishing", statusId: 2 }];
    const linked = { employees: { "8": { name: "Micha" } }, ticketStates: { "2": { name: "Neu" } } };
    const tanss = {
      ticketList: async (_s: unknown, kind: string) => ({
        items:
          kind === "general"
            ? board.filter((b) => !("assignedToEmployeeId" in b))
            : kind === "technician"
              ? board.filter((b) => "assignedToEmployeeId" in b)
              : [],
        linked,
        waitingStates: [],
      }),
    } as unknown as TanssClient;
    const shared = createSharedSession({ store });
    shared.adopt(SESSION, Math.floor(Date.now() / 1000));
    const poller = createPoller({ tanss, store, shared });

    // First measurement: the ticket lies in the pool, unassigned.
    await poller.tick();
    board = board.map((b) => (b.id === 9 ? { ...b, assignedToEmployeeId: 8 } : b));
    // Second: someone has taken it, so it is no longer in the pool.
    await poller.tick();

    const history = store.claimHistory(7, "2000-01-01");
    expect(history).toHaveLength(1);
    // The pool is the very list the takeover happened in — without it the
    // entry never shows up under "Allgemein", where it is looked for.
    expect(history[0]!.lists).toContain("list:general");
    expect(history[0]!.lists).toContain("list:technician");
  });
});

describe("reading the history", () => {
  it("filters by list and counts per person, newest first", () => {
    const entries = [
      entry({ id: 1, day: "2026-08-24", minute: 540 }),
      entry({ id: 2, day: "2026-08-25", minute: 480, assigneeName: "Sören" }),
      entry({ id: 3, day: "2026-08-25", minute: 700, lists: ["list:own"] }),
    ];
    expect(historyForList(entries, "all").map((e) => e.id)).toEqual([3, 2, 1]);
    expect(historyForList(entries, "view:soc").map((e) => e.id)).toEqual([2, 1]);
    expect(claimsByEmployee(entries)).toEqual([
      { name: "Micha", count: 2 },
      { name: "Sören", count: 1 },
    ]);
  });
});

describe("both sources together", () => {
  const day = (over: Partial<import("../shared/dashboard.ts").DashboardDay> = {}) => ({
    day: "2026-08-25",
    samples: [],
    seen: { "view:soc": { "9": 1 }, "list:own": { "9": 1 } },
    claims: [{ id: 9, title: "Phishing", minute: 508, assigneeId: 8, assigneeName: "Micha", fromId: 0, fromName: "" }],
    assignees: {},
    names: {},
    ...over,
  });

  it("reads the measured days as history, with the lists of that day", () => {
    const entries = claimsFromDays([day()], "2026-08-01");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 9, day: "2026-08-25", assigneeName: "Micha" });
    expect(entries[0]!.lists.sort()).toEqual(["list:own", "view:soc"]);
    expect(claimsFromDays([day()], "2026-09-01")).toEqual([]);
  });

  it("shows a takeover once, no matter how many sources hold it", () => {
    const fromLog = entry({ id: 9, minute: 508, assigneeId: 8, day: "2026-08-25", lists: ["view:soc"] });
    const merged = mergeClaimEntries([fromLog], claimsFromDays([day()], "2026-08-01"));
    expect(merged).toHaveLength(1);
    // One entry, but every list either source saw it in that day: a log line
    // written mid-day knows less than the day's finished membership set.
    expect(merged[0]!.lists.sort()).toEqual(["list:own", "view:soc"]);
  });

  it("keeps what only one of the two has", () => {
    const onlyLog = entry({ id: 1, day: "2026-06-01" });
    const merged = mergeClaimEntries([onlyLog], claimsFromDays([day()], "2026-01-01"));
    expect(merged.map((e) => e.id).sort()).toEqual([1, 9]);
  });
});

describe("collector scope", () => {
  it("never asks for the project list", async () => {
    // Projects run for months. A five-minute sample over them would say
    // nothing about the day's load, and letting them into the counted lists
    // would change what every existing chart and day report means.
    const kinds: string[] = [];
    const tanss = {
      ticketList: async (_s: unknown, kind: string) => {
        kinds.push(kind);
        return { items: [], linked: {}, waitingStates: [] };
      },
    } as unknown as TanssClient;
    const store = createMemoryStore();
    const shared = createSharedSession({ store });
    shared.adopt(SESSION, Math.floor(Date.now() / 1000));
    await createPoller({ tanss, store, shared }).tick();
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds).not.toContain("projects");
  });
});
