import { describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { createMemoryStore } from "./store.ts";
import type { TanssClient, TanssSession } from "./tanss.ts";
import type { LlmClient } from "./llm.ts";

const SECRET = "x".repeat(32);
const SESSION: TanssSession = { employeeId: 7, apiKey: "a", refresh: "r", expire: 9_999_999_999 };
const at = (iso: string) => Date.parse(iso) / 1000;

const DAY_ITEMS = [
  { id: 1, date: at("2026-08-25T09:00:00+02:00"), duration: 60, planningType: "SUPPORT", text: "Firewall geprüft", companyId: 5, employeeId: 7 },
  { id: 900, date: at("2026-08-25T13:00:00+02:00"), duration: 45, planningType: "APPOINTMENT_FIX", outlookTitle: "Jour fixe", companyId: 5 },
];
const HISTORY = [
  { id: 11, date: at("2026-08-18T08:00:00+02:00"), duration: 30, planningType: "SUPPORT", text: "Monitoring durchgesehen", companyId: 5 },
  { id: 12, date: at("2026-08-11T08:00:00+02:00"), duration: 60, planningType: "SUPPORT", text: "Monitoring durchgesehen", companyId: 5 },
];
const LINKED = { companies: { "5": { name: "Kranz GmbH" } } };

function stack(answer: string, seen: { prompt?: string } = {}) {
  const tanss = {
    login: async () => ({ ...SESSION }),
    listSupports: async (_s: unknown, from: number) =>
      from >= at("2026-08-25T00:00:00+02:00")
        ? { items: DAY_ITEMS, linked: LINKED }
        : { items: HISTORY, linked: LINKED },
    listPhoneCalls: async () => [],
    supportTypes: async () => [{ id: 3, name: "Remote" }],
  } as unknown as TanssClient;
  const llm = {
    listModels: async () => [],
    chat: async (_settings: unknown, messages: { role: string; content: string }[]) => {
      seen.prompt = messages[1]!.content;
      return answer;
    },
  } as unknown as LlmClient;
  const store = createMemoryStore();
  store.setLlm({ baseUrl: "http://x/v1", apiKey: "", model: "m", contextTokens: 32768 });
  return { tanss, llm, store };
}

async function loggedIn(parts: ReturnType<typeof stack>) {
  const app = await buildApp({ sessionSecret: SECRET, tanss: parts.tanss, llm: parts.llm, store: parts.store, enableRateLimit: false });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "sb", password: "pw", token: "123456" } });
  const raw = res.headers["set-cookie"];
  return { app, cookie: Array.isArray(raw) ? raw[0] : String(raw ?? "") };
}

const ANSWER = JSON.stringify({
  ideas: [
    { minutes: 45, text: "Jour fixe begleitet.", kind: "termin", evidence: "Termin 13:00", documented: true, company: "Kranz GmbH", startMinute: 780 },
    { minutes: 45, text: "Möglicherweise Monitoring durchgesehen.", kind: "muster", evidence: "2× montags", documented: false, company: "Kranz GmbH", startMinute: null },
  ],
  note: "Rund drei Stunden bleiben unerklärt.",
});

describe("day assistant", () => {
  it("builds the context from bookings, templates, gaps and patterns", async () => {
    const seen: { prompt?: string } = {};
    const parts = stack(ANSWER, seen);
    parts.store.setRoutines(7, [
      { id: "r1", text: "Mail", minMinutes: 15, maxMinutes: 45, companyId: null, companyLabel: "", ticketId: null, ticketLabel: "", typeId: null },
      { id: "r2", text: "Ganzer Tag", minMinutes: 600, maxMinutes: 600, companyId: null, companyLabel: "", ticketId: null, ticketLabel: "", typeId: null },
    ]);
    const { app, cookie } = await loggedIn(parts);
    const res = await app.inject({ method: "POST", url: "/me/agent/assistant", headers: { cookie }, payload: { day: "2026-08-25" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ideas).toHaveLength(2);
    expect(body.note).toMatch(/unerklärt/);
    expect(body.context).toMatchObject({ bookedMinutes: 60, templates: 1 });

    const prompt = seen.prompt!;
    // The appointment is an unbooked trace, not booked time.
    expect(prompt).toContain("Termin 13:00–13:45 · 45 min · Jour fixe (Kranz GmbH)");
    expect(prompt).toContain("09:00–10:00 · 60 min · Kranz GmbH · Firewall geprüft");
    // Median of 30 and 60, seen twice, on the same weekday.
    expect(prompt).toContain("2× · Kranz GmbH · 45 min · Monitoring durchgesehen");
    // A routine longer than the remaining room is noise and stays out.
    expect(prompt).toContain("Mail · 15–45 min");
    expect(prompt).not.toContain("Ganzer Tag");
  });

  it("asks about one gap when given one", async () => {
    const seen: { prompt?: string } = {};
    const { app, cookie } = await loggedIn(stack(ANSWER, seen));
    const res = await app.inject({
      method: "POST",
      url: "/me/agent/assistant",
      headers: { cookie },
      payload: { day: "2026-08-25", focus: { start: 10 * 60, end: 11 * 60 } },
    });
    expect(res.statusCode).toBe(200);
    expect(seen.prompt).toContain("Es geht nur um die Lücke 10:00–11:00 (60 Minuten)");
  });

  it("rejects a gap that ends before it starts", async () => {
    const { app, cookie } = await loggedIn(stack(ANSWER));
    const res = await app.inject({
      method: "POST",
      url: "/me/agent/assistant",
      headers: { cookie },
      payload: { day: "2026-08-25", focus: { start: 600, end: 600 } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("survives an answer that is not the expected shape", async () => {
    const { app, cookie } = await loggedIn(stack("Ich kann das nicht."));
    const res = await app.inject({ method: "POST", url: "/me/agent/assistant", headers: { cookie }, payload: { day: "2026-08-25" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().ideas).toEqual([]);
  });
});

describe("personal style", () => {
  it("puts rules and examples into the assistant prompt", async () => {
    const seen: { prompt?: string; system?: string } = {};
    const parts = stack(ANSWER, seen);
    const llm = {
      listModels: async () => [],
      chat: async (_s: unknown, messages: { role: string; content: string }[]) => {
        seen.system = messages[0]!.content;
        seen.prompt = messages[1]!.content;
        return ANSWER;
      },
    } as unknown as LlmClient;
    parts.store.setStyle(7, { rules: "Immer mit Ergebnis.", examples: ["Backup geprüft, Fehler behoben."] });
    const app = await buildApp({ sessionSecret: SECRET, tanss: parts.tanss, llm, store: parts.store, enableRateLimit: false });
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "sb", password: "pw", token: "123456" } });
    const raw = login.headers["set-cookie"];
    const cookie = Array.isArray(raw) ? raw[0] : String(raw ?? "");
    await app.inject({ method: "POST", url: "/me/agent/assistant", headers: { cookie }, payload: { day: "2026-08-25" } });
    expect(seen.system).toContain("Immer mit Ergebnis.");
    expect(seen.system).toContain("- Backup geprüft, Fehler behoben.");
  });

  it("stores at most three examples and falls back to the default rules", async () => {
    const parts = stack(ANSWER);
    const { app, cookie } = await loggedIn(parts);
    const res = await app.inject({
      method: "PUT",
      url: "/me/style",
      headers: { cookie },
      payload: { style: { rules: "   ", examples: ["a", "b", "c", "d"] } },
    });
    expect(res.json().style.examples).toEqual(["a", "b", "c"]);
    expect(res.json().style.rules).toContain("Vergangenheitsform");
  });
});
