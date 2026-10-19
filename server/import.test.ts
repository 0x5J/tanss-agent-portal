import { describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { createMemoryStore } from "./store.ts";
import type { LinearClient } from "./linear.ts";
import type { TanssClient, TanssSession } from "./tanss.ts";
import { berlinDayRangeUnix } from "../shared/days.ts";

const SECRET = "x".repeat(32);
const SESSION: TanssSession = { employeeId: 7, apiKey: "a", refresh: "r", expire: 9_999_999_999 };
const DAY = "2026-08-25";
const dayFrom = berlinDayRangeUnix(DAY).from;

const ACTIVITY = {
  issue: "ESK-499",
  title: "Firewall-Cluster",
  project: "SOC Betrieb",
  url: "",
  windows: [{ start: 9 * 60, end: 10 * 60, state: "In Progress" }],
  commentMinutes: 90,
  summary: "Cluster-Failover analysiert.",
  historyTruncated: false,
  sessions: [{ start: 9 * 60, minutes: 90 }],
};

function linearFake(over: Partial<LinearClient> = {}): LinearClient {
  return {
    workflowStates: async () => [
      { name: "In Progress", type: "started" },
      { name: "Todo", type: "unstarted" },
    ],
    dayActivity: async () => ({ activities: [ACTIVITY], issuesChecked: 1, capped: false }),
    ...over,
  };
}

function tanssFake(onCreate?: (b: Record<string, unknown>) => void, supports: Record<string, unknown>[] = []): TanssClient {
  return {
    login: async () => ({ ...SESSION }),
    ticketById: async (_s: unknown, id: number) => ({ item: { id, companyId: 77 }, linked: {} }),
    listSupports: async () => ({ items: supports, linked: {} }),
    listPhoneCalls: async () => [],
    supportTypes: async () => [{ id: 3, name: "Remote" }],
    createSupport: async (_s: unknown, body: Record<string, unknown>) => {
      onCreate?.(body);
      return { id: 555 };
    },
  } as unknown as TanssClient;
}

async function loggedIn(opts: Parameters<typeof buildApp>[0]) {
  const app = await buildApp(opts);
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "sb", password: "pw", token: "123456" } });
  const raw = res.headers["set-cookie"];
  return { app, cookie: Array.isArray(raw) ? raw[0] : String(raw ?? "") };
}

describe("without a Linear connection", () => {
  it("says so instead of failing obscurely", async () => {
    const { app, cookie } = await loggedIn({ sessionSecret: SECRET, tanss: tanssFake(), enableRateLimit: false });
    const res = await app.inject({ method: "GET", url: `/me/import?day=${DAY}`, headers: { cookie } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/LINEAR_API_KEY/);
    expect((await app.inject({ method: "GET", url: "/auth/config" })).json().linear).toBe(false);
  });
});

describe("day import", () => {
  it("adopts Linear's started states on the first run", async () => {
    const store = createMemoryStore();
    const { app, cookie } = await loggedIn({ sessionSecret: SECRET, tanss: tanssFake(), linear: linearFake(), store, enableRateLimit: false });
    const res = await app.inject({ method: "GET", url: "/me/import/states", headers: { cookie } });
    expect(res.json().rules.states).toEqual(["In Progress"]);
    expect(store.importRules(7).states).toEqual(["In Progress"]);
  });

  it("turns the day into suggestions with the mapping attached", async () => {
    const store = createMemoryStore();
    store.setImportRules(7, { ...store.importRules(7), states: ["In Progress"] });
    store.setMappings(7, { "SOC Betrieb": { ticketId: 4711, ticketLabel: "#4711 SOC", companyId: null, companyLabel: "", typeId: 3 } });
    const { app, cookie } = await loggedIn({ sessionSecret: SECRET, tanss: tanssFake(), linear: linearFake(), store, enableRateLimit: false });
    const body = (await app.inject({ method: "GET", url: `/me/import?day=${DAY}`, headers: { cookie } })).json();
    expect(body.suggestions).toHaveLength(1);
    const [s] = body.suggestions;
    expect(s).toMatchObject({ issue: "ESK-499", minutes: 90, start: 540, text: "Cluster-Failover analysiert." });
    expect(s.mapping).toMatchObject({ ticketId: 4711, typeId: 3 });
    expect(s.bookedSupportId).toBeNull();
  });

  it("flags an overlap with a booking that already exists", async () => {
    const store = createMemoryStore();
    store.setImportRules(7, { ...store.importRules(7), states: ["In Progress"] });
    const tanss = tanssFake(undefined, [
      { id: 1, date: dayFrom + 9 * 3600 + 1800, duration: 60, planningType: "SUPPORT", ticketId: 4712 },
    ]);
    const { app, cookie } = await loggedIn({ sessionSecret: SECRET, tanss, linear: linearFake(), store, enableRateLimit: false });
    const body = (await app.inject({ method: "GET", url: `/me/import?day=${DAY}`, headers: { cookie } })).json();
    expect(body.suggestions[0].flags.map((f: { label: string }) => f.label)).toContain("überlappt");
  });

  it("books, remembers the key and refuses the same issue twice", async () => {
    const store = createMemoryStore();
    const sent: Record<string, unknown>[] = [];
    const { app, cookie } = await loggedIn({
      sessionSecret: SECRET,
      tanss: tanssFake((b) => sent.push(b)),
      linear: linearFake(),
      store,
      enableRateLimit: false,
    });
    const payload = { day: DAY, items: [{ issue: "ESK-499", startMinute: 540, duration: 90, text: "Analysiert.", ticketId: 4711, typeId: 3 }] };
    const first = await app.inject({ method: "POST", url: "/me/import/book", headers: { cookie }, payload });
    expect(first.json()).toMatchObject({ booked: 1 });
    expect(sent[0]).toMatchObject({ duration: 90, typeId: 3, linkTypeId: 11, linkId: 4711, planningType: "SUPPORT" });
    expect(store.importBookings(7)).toEqual({ "ESK-499|2026-08-25": 555 });

    const second = await app.inject({ method: "POST", url: "/me/import/book", headers: { cookie }, payload });
    expect(second.json().booked).toBe(0);
    expect(second.json().results[0].error).toMatch(/bereits gebucht/);
    // Only one call ever reached TANSS.
    expect(sent).toHaveLength(1);
  });

  it("lets one bad line fail without stopping the rest", async () => {
    const store = createMemoryStore();
    let calls = 0;
    const tanss = {
      login: async () => ({ ...SESSION }),
      ticketById: async (_s: unknown, id: number) => ({ item: { id, companyId: 77 }, linked: {} }),
      listSupports: async () => ({ items: [], linked: {} }),
      createSupport: async () => {
        calls++;
        if (calls === 1) throw new Error("TANSS mag das nicht");
        return { id: 556 };
      },
    } as unknown as TanssClient;
    const { app, cookie } = await loggedIn({ sessionSecret: SECRET, tanss, linear: linearFake(), store, enableRateLimit: false });
    const res = await app.inject({
      method: "POST",
      url: "/me/import/book",
      headers: { cookie },
      payload: {
        day: DAY,
        items: [
          { issue: "A", startMinute: 540, duration: 30, text: "x", ticketId: 1, typeId: 3 },
          { issue: "B", startMinute: 600, duration: 30, text: "y", companyId: 5, typeId: 3 },
        ],
      },
    });
    const body = res.json();
    expect(body.booked).toBe(1);
    expect(body.results[0].error).toMatch(/mag das nicht/);
    expect(body.results[1].id).toBe(556);
  });

  it("remembers a mapping but not one that points nowhere", async () => {
    const store = createMemoryStore();
    const { app, cookie } = await loggedIn({ sessionSecret: SECRET, tanss: tanssFake(), linear: linearFake(), store, enableRateLimit: false });
    const ok = await app.inject({
      method: "PUT",
      url: "/me/import/mappings",
      headers: { cookie },
      payload: { key: "SOC Betrieb", target: { companyId: 5, companyLabel: "Kranz", typeId: 3 } },
    });
    expect(ok.json().mappings["SOC Betrieb"]).toMatchObject({ companyId: 5, typeId: 3 });
    const bad = await app.inject({
      method: "PUT",
      url: "/me/import/mappings",
      headers: { cookie },
      payload: { key: "Leer", target: { typeId: 3 } },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("Linear im Tagesassistenten", () => {
  it("puts unbooked Linear activity into the prompt and leaves booked ones out", async () => {
    const store = createMemoryStore();
    store.setLlm({ baseUrl: "http://x/v1", apiKey: "", model: "m", contextTokens: 32768 });
    store.setImportRules(7, { ...store.importRules(7), states: ["In Progress"] });
    store.markImportBooked(7, "ESK-500|2026-08-25", 900);
    let prompt = "";
    const llm = {
      listModels: async () => [],
      chat: async (_s: unknown, messages: { role: string; content: string }[]) => {
        prompt = messages[1]!.content;
        return JSON.stringify({ ideas: [], note: "" });
      },
    } as unknown as import("./llm.ts").LlmClient;
    const linear = linearFake({
      dayActivity: async () => ({
        activities: [ACTIVITY, { ...ACTIVITY, issue: "ESK-500", title: "Schon gebucht" }],
        issuesChecked: 2,
        capped: false,
      }),
    });
    const { app, cookie } = await loggedIn({
      sessionSecret: SECRET,
      tanss: tanssFake(),
      linear,
      llm,
      store,
      enableRateLimit: false,
    });
    const res = await app.inject({ method: "POST", url: "/me/agent/assistant", headers: { cookie }, payload: { day: DAY } });
    expect(res.statusCode).toBe(200);
    expect(prompt).toContain("ESK-499 Firewall-Cluster · 90 min");
    // The one already imported must not be suggested a second time.
    expect(prompt).not.toContain("ESK-500");
  });

  it("works without Linear at all", async () => {
    const store = createMemoryStore();
    store.setLlm({ baseUrl: "http://x/v1", apiKey: "", model: "m", contextTokens: 32768 });
    let prompt = "";
    const llm = {
      listModels: async () => [],
      chat: async (_s: unknown, messages: { role: string; content: string }[]) => {
        prompt = messages[1]!.content;
        return JSON.stringify({ ideas: [], note: "" });
      },
    } as unknown as import("./llm.ts").LlmClient;
    const { app, cookie } = await loggedIn({ sessionSecret: SECRET, tanss: tanssFake(), llm, store, enableRateLimit: false });
    const res = await app.inject({ method: "POST", url: "/me/agent/assistant", headers: { cookie }, payload: { day: DAY } });
    expect(res.statusCode).toBe(200);
    expect(prompt).toContain("Linear-Aktivität ohne Buchung:\n- keine");
  });
});

describe("aus Issue formulieren", () => {
  it("sends the notes and the personal style, and gives back the text", async () => {
    const store = createMemoryStore();
    store.setLlm({ baseUrl: "http://x/v1", apiKey: "", model: "m", contextTokens: 32768 });
    store.setStyle(7, { rules: "Immer mit Ergebnis.", examples: ["Backup geprüft, Fehler behoben."] });
    let prompt = "";
    const llm = {
      listModels: async () => [],
      chat: async (_s: unknown, messages: { role: string; content: string }[]) => {
        prompt = messages[1]!.content;
        return "  Cluster-Failover analysiert und Ursache behoben.  ";
      },
    } as unknown as import("./llm.ts").LlmClient;
    const { app, cookie } = await loggedIn({ sessionSecret: SECRET, tanss: tanssFake(), llm, store, enableRateLimit: false });
    const res = await app.inject({
      method: "POST",
      url: "/me/agent/import-text",
      headers: { cookie },
      payload: { issue: "ESK-499", title: "Firewall-Cluster", project: "SOC Betrieb", notes: "Failover geprüft (Dauer: 90 min)" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe("Cluster-Failover analysiert und Ursache behoben.");
    expect(prompt).toContain("Issue: ESK-499 — Firewall-Cluster");
    expect(prompt).toContain("Projekt: SOC Betrieb");
    expect(prompt).toContain("Eigene Arbeitsnotizen des Tages:\nFailover geprüft (Dauer: 90 min)");
    // The personal style travels with it, like every other booking text.
    expect(prompt).toContain("Immer mit Ergebnis.");
    expect(prompt).toContain("- Backup geprüft, Fehler behoben.");
  });

  it("says so when there are no notes instead of inventing some", async () => {
    const store = createMemoryStore();
    store.setLlm({ baseUrl: "http://x/v1", apiKey: "", model: "m", contextTokens: 32768 });
    let prompt = "";
    const llm = {
      listModels: async () => [],
      chat: async (_s: unknown, messages: { role: string; content: string }[]) => {
        prompt = messages[1]!.content;
        return "Am Issue gearbeitet.";
      },
    } as unknown as import("./llm.ts").LlmClient;
    const { app, cookie } = await loggedIn({ sessionSecret: SECRET, tanss: tanssFake(), llm, store, enableRateLimit: false });
    await app.inject({
      method: "POST",
      url: "/me/agent/import-text",
      headers: { cookie },
      payload: { issue: "ESK-500", title: "Ohne Notizen", project: "SOC" },
    });
    expect(prompt).toContain("keine Arbeitsnotizen");
    expect(prompt).toContain("bleib entsprechend knapp");
  });

  it("refuses without a model instead of failing obscurely", async () => {
    const { app, cookie } = await loggedIn({ sessionSecret: SECRET, tanss: tanssFake(), enableRateLimit: false });
    const res = await app.inject({
      method: "POST",
      url: "/me/agent/import-text",
      headers: { cookie },
      payload: { issue: "ESK-499", title: "x", project: "y", notes: "z" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/nicht eingerichtet/);
  });
});

describe("Ticket-Kopf für die Zuordnung", () => {
  it("reads only the ticket, not its whole thread", async () => {
    let historyCalls = 0;
    const tanss = {
      login: async () => ({ ...SESSION }),
      ticketById: async () => ({ item: { id: 4711, title: "Firewall", companyId: 5 }, linked: { companies: { "5": { name: "Kranz" } } } }),
      ticketHistory: async () => {
        historyCalls++;
        return { content: {}, linked: {} };
      },
    } as unknown as TanssClient;
    const { app, cookie } = await loggedIn({ sessionSecret: SECRET, tanss, enableRateLimit: false });
    const res = await app.inject({ method: "GET", url: "/me/tickets/4711?head=1", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ticket).toMatchObject({ id: 4711, title: "Firewall", companyName: "Kranz" });
    expect(historyCalls).toBe(0);
    // Without the flag the thread still comes along.
    await app.inject({ method: "GET", url: "/me/tickets/4711", headers: { cookie } });
    expect(historyCalls).toBe(1);
  });
});
