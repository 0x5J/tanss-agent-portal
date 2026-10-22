import { describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { TanssError, type TanssClient } from "./tanss.ts";
import { LlmError, type LlmClient } from "./llm.ts";
import { createMemoryStore } from "./store.ts";
import { maskKey } from "./agent.ts";

const SECRET = "x".repeat(32);
const SESSION = { employeeId: 7, apiKey: "Bearer a", refresh: "Bearer r", expire: 9_999_999_999 };
// 2026-08-23 10:00 Berlin
const NOW = Date.UTC(2026, 7, 23, 8, 0, 0);

function fakeTanss(overrides: Partial<TanssClient> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const record = (name: string, result: unknown): any =>
    async (...args: unknown[]) => {
      calls.push({ name, args });
      return result;
    };
  const modified = Math.floor(NOW / 1000) - 30 * 60;
  const client: TanssClient = {
    login: async () => SESSION,
    ticketList: record("ticketList", {
      items: [
        { id: 1, title: "Backup DC01", statusId: 2, modified, companyId: 5, assignedToEmployeeId: 7 },
        { id: 2, title: "Drucker", statusId: 2, modified: 100, companyId: 5, assignedToEmployeeId: 7 },
      ],
      linked: { companies: { "5": { name: "Kunde" } }, ticketStates: { "2": { name: "Neu" } } },
      waitingStates: [],
    }),
    customTicketList: record("customTicketList", { items: [], linked: {} }),
    ticketById: record("ticketById", {
      item: { id: 1, title: "Backup DC01", content: "Job bricht ab", statusId: 2, companyId: 5 },
      linked: { companies: { "5": { name: "Kunde" } } },
    }),
    ticketHistory: async (_s, id) => {
      calls.push({ name: "ticketHistory", args: [id] });
      const comments =
        id === 1
          ? [{ id: 9, date: Math.floor(NOW / 1000) - 60 * 60, employeeId: 7, content: "Exclusion gesetzt", internal: true }]
          : [];
      const mails =
        id === 1
          ? [{ id: 5, date: Math.floor(NOW / 1000) - 30 * 60, inbound: true, senderName: "M. Müller", subject: "Re: Backup", bodyPlain: "Läuft es jetzt?\n\nViele Grüße\nMüller\n\n> alte Mail\n> noch mehr" }]
          : [];
      return { content: { comments, supports: [], mails }, linked: {} };
    },
    updateTicket: record("updateTicket", {}),
    createComment: record("createComment", { id: 42 }),
    ticketStates: record("ticketStates", [
      { id: 2, name: "Neu", active: true },
      { id: 6, name: "Wartet auf Kunde", active: true },
    ]),
    technicians: record("technicians", [{ id: 7, name: "Sören" }]),
    supportTypes: record("supportTypes", [{ id: 3, name: "Remote" }]),
    listSupports: record("listSupports", { items: [], linked: {} }),
    createSupport: record("createSupport", { id: 77 }),
    supportById: record("supportById", { item: {}, linked: {} }),
    listPhoneCalls: record("listPhoneCalls", []),
    updateSupport: record("updateSupport", { id: 900 }),
    ticketSupports: record("ticketSupports", []),
    search: record("search", {
      tickets: [{ id: 99, title: "Backup DC02 bricht ab", statusId: 2, companyId: 5 }],
      companies: [],
      linked: { companies: { "5": { name: "Kunde" } } },
    }),
  };
  return { client: { ...client, ...overrides }, calls };
}

function fakeLlm(answer: string | ((prompt: string) => string)) {
  const prompts: string[] = [];
  /** API keys the model listing was sent, to see where a stored key travels. */
  const modelKeys: string[] = [];
  const llm: LlmClient = {
    listModels: async (s) => {
      modelKeys.push(s.apiKey);
      if (!s.baseUrl.includes("good")) throw new TanssError("nicht erreichbar", 502);
      return ["qwen3", "llama"];
    },
    chat: async (_s, messages) => {
      const prompt = messages[messages.length - 1].content;
      prompts.push(prompt);
      return typeof answer === "function" ? answer(prompt) : answer;
    },
    chatWithTools: async () => ({ text: "", toolCalls: [] }),
  };
  return { llm, prompts, modelKeys };
}

type Turn = { text: string; toolCalls: { id: string; name: string; arguments: string }[] };

/** An LLM that answers a scripted sequence; the last entry repeats. */
function scriptedLlm(script: Turn[]) {
  const seen: { messages: unknown[]; tools: unknown[]; opts: unknown }[] = [];
  let round = 0;
  const llm: LlmClient = {
    listModels: async () => [],
    chat: async () => "ok",
    chatWithTools: async (_s, messages, tools, opts) => {
      seen.push({ messages: [...messages], tools: [...tools], opts });
      const turn = script[Math.min(round, script.length - 1)];
      round += 1;
      return turn;
    },
  };
  return { llm, seen, rounds: () => round };
}

/** A clock that jumps forward a fixed step on every read — for the 120 s deadline. */
function steppingNow(stepMs: number) {
  let calls = 0;
  return () => NOW + calls++ * stepMs;
}

/** Logs in and returns a caller, like setup() but with a given LlmClient. */
async function setupWith(llm: LlmClient, tanss: Partial<TanssClient> = {}, now: () => number = () => NOW) {
  const { client, calls } = fakeTanss(tanss);
  const store = createMemoryStore();
  store.setLlm({ baseUrl: "http://good:1234/v1", apiKey: "", model: "m", contextTokens: 32768 });
  const app = await buildApp({ sessionSecret: SECRET, tanss: client, llm, store, enableRateLimit: false, now });
  const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "sb", password: "pw", token: "123456" } });
  const cookie = String(login.headers["set-cookie"]);
  const ask = async (content: string, extra: object = {}) =>
    app.inject({
      method: "POST",
      url: "/me/agent/chat",
      headers: { cookie },
      payload: { rows: [row({ id: 1 }), row({ id: 2 })], activity: {}, openTicketId: null, messages: [{ role: "user", content }], ...extra },
    });
  const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie }, payload: payload as Record<string, unknown> | undefined });
  return { ask, call, calls };
}

function toolCall(id: string, name: string, args: object) {
  return { id, name, arguments: JSON.stringify(args) };
}

/**
 * The only TANSS calls a tool chat may make: the read-only ones behind the
 * three tools, plus `technicians`, which only feeds myName() for the prompt
 * (not something the model calls itself). A whitelist, not a blacklist of
 * `createComment`/`createSupport` — that let `updateTicket`/`updateSupport`
 * slip through unnoticed.
 */
const CHAT_ALLOWED_CALLS = new Set(["ticketById", "ticketHistory", "search", "ticketSupports", "listSupports", "technicians"]);
function expectOnlyAllowedChatCalls(calls: { name: string }[]) {
  expect(calls.map((c) => c.name).filter((n) => !CHAT_ALLOWED_CALLS.has(n))).toEqual([]);
}

async function setup(
  answer: string | ((p: string) => string) = "ok",
  configured = true,
  tanss: Partial<TanssClient> = {},
) {
  const { client, calls } = fakeTanss(tanss);
  const { llm, prompts, modelKeys } = fakeLlm(answer);
  const store = createMemoryStore();
  if (configured) store.setLlm({ baseUrl: "http://good:1234/v1", apiKey: "", model: "qwen3", contextTokens: 32768 });
  const app = await buildApp({ sessionSecret: SECRET, tanss: client, llm, store, enableRateLimit: false, now: () => NOW });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "sb", password: "pw", token: "123456" } });
  const raw = res.headers["set-cookie"];
  const cookie = Array.isArray(raw) ? raw[0] : String(raw ?? "");
  const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) =>
    app.inject({ method, url, headers: { cookie }, payload: payload as Record<string, unknown> | undefined });
  return { app, call, calls, prompts, store, modelKeys };
}

describe("agent settings", () => {
  it("stores the endpoint, masks the key and lists models", async () => {
    const { call } = await setup("ok", false);
    expect((await call("POST", "/me/agent/summary", { ticketId: 1 })).statusCode).toBe(409);
    const saved = await call("PUT", "/me/agent/settings", { baseUrl: "good:1234", apiKey: "sk-secret-key", model: "qwen3" });
    expect(saved.json()).toMatchObject({ baseUrl: "http://good:1234/v1", hasKey: true, keyHint: "sk-…key", ready: true });
    const read = await call("GET", "/me/agent/settings");
    expect(JSON.stringify(read.json())).not.toContain("sk-secret-key");
    // Omitted key keeps the stored one.
    const again = await call("PUT", "/me/agent/settings", { baseUrl: "good:1234", model: "llama" });
    expect(again.json().hasKey).toBe(true);
    const models = await call("POST", "/me/agent/models", {});
    expect(models.json().models).toEqual(["qwen3", "llama"]);
    const bad = await call("POST", "/me/agent/models", { baseUrl: "http://down" });
    expect(bad.statusCode).toBe(502);
  });
  it("sends the stored key only to the stored endpoint", async () => {
    const { call, modelKeys } = await setup("ok", false);
    await call("PUT", "/me/agent/settings", { baseUrl: "good:1234", apiKey: "sk-secret-key", model: "qwen3" });
    await call("POST", "/me/agent/models", { baseUrl: "good:1234" });
    await call("POST", "/me/agent/models", { baseUrl: "http://good.attacker:9999" });
    expect(modelKeys).toEqual(["sk-secret-key", ""]);
    // A new endpoint without a new key drops the old key instead of carrying it over.
    const moved = await call("PUT", "/me/agent/settings", { baseUrl: "good.other:1234", model: "qwen3" });
    expect(moved.json().hasKey).toBe(false);
  });
  it("masks keys", () => {
    expect(maskKey("")).toBe("");
    expect(maskKey("abc")).toBe("••••");
  });
});

describe("agent functions", () => {
  it("summarises a ticket from its thread", async () => {
    const { call, prompts } = await setup("Problem: Backup.");
    const res = await call("POST", "/me/agent/summary", { ticketId: 1 });
    expect(res.json().text).toBe("Problem: Backup.");
    expect(prompts[0]).toContain("Ticket #1: Backup DC01");
    expect(prompts[0]).toContain("Exclusion gesetzt");
  });

  it("drafts a comment for one ticket and a shared one for many", async () => {
    const { call, prompts } = await setup("Entwurf");
    const one = await call("POST", "/me/agent/draft", { ticketIds: [1], intent: "status", internal: false, instruction: "" });
    expect(one.json().text).toBe("Entwurf");
    expect(prompts[0]).toContain("Unterschrift: Sören");
    expect(prompts[0]).toContain("an den Kunden");
    const many = await call("POST", "/me/agent/draft", { ticketIds: [1, 2], intent: "custom", internal: true, instruction: "Wartung ankündigen" });
    expect(many.statusCode).toBe(200);
    expect(prompts[1]).toContain("in 2 Tickets gleichzeitig");
    expect(prompts[1]).toContain("Wartung ankündigen");
    const missing = await call("POST", "/me/agent/draft", { ticketIds: [1], intent: "custom", internal: true, instruction: "" });
    expect(missing.statusCode).toBe(400);
  });

  it("briefs my own tickets by default and a list on request, cached per scope and day", async () => {
    const { call, prompts } = await setup("Guten Morgen.");
    const rows = [
      row({ id: 1, assigneeId: 7, creationDate: Math.floor(NOW / 1000) - 3600 }),
      row({ id: 2, assigneeId: 0, creationDate: Math.floor(NOW / 1000) - 40 * 86400, deadlineDate: 1 }),
    ];
    const activity = { "2": { at: Math.floor(NOW / 1000) - 10 * 86400, kind: "comment", historyRead: true } };
    // "mine": the unassigned ticket is filtered out on the server.
    const res = await call("POST", "/me/agent/briefing", { rows, activity });
    expect(res.json().facts).toMatchObject({ total: 1, mine: 1, newSinceYesterday: [1], overdue: [], unassigned: [] });
    expect(res.json().cached).toBe(false);
    expect(prompts[0]).toContain("über meine eigenen Tickets");
    expect(prompts[0]).toContain("Neu seit gestern (1)");
    const again = await call("POST", "/me/agent/briefing", { rows, activity, scope: "mine" });
    expect(again.json().cached).toBe(true);
    expect(prompts).toHaveLength(1);
    await call("POST", "/me/agent/briefing", { rows, activity, force: true });
    expect(prompts).toHaveLength(2);
    // A list: every row counts, named in the prompt, own cache.
    const list = await call("POST", "/me/agent/briefing", { rows, activity, scope: "list:all", label: "Alle" });
    expect(list.json().facts).toMatchObject({ total: 2, mine: 1, overdue: [2], unassigned: [2] });
    expect(list.json().cached).toBe(false);
    expect(prompts[2]).toContain("Ticketliste „Alle");
    expect((await call("POST", "/me/agent/briefing", { rows, activity, scope: "list:all", label: "Alle" })).json().cached).toBe(true);
    expect((await call("POST", "/me/agent/briefing", { rows, activity, scope: "mine" })).json().cached).toBe(true);
  });

  it("parses pattern groups and drops unknown ids", async () => {
    const { call } = await setup('```json\n{"groups":[{"ticketIds":[1,2,99],"reason":"gleicher Kunde"},{"ticketIds":[1],"reason":"x"}]}\n```');
    const res = await call("POST", "/me/agent/patterns", { rows: [row({ id: 1 }), row({ id: 2 })], activity: {} });
    expect(res.json().groups).toEqual([{ ticketIds: [1, 2], reason: "gleicher Kunde" }]);
  });
});

describe("chat", () => {
  it("answers with the board, today's bookings and the named ticket's history as context", async () => {
    const { llm, seen } = scriptedLlm([{ text: "Zuletzt wurde in #1 eine Exclusion gesetzt.", toolCalls: [] }]);
    const { ask, calls } = await setupWith(llm);
    const res = await ask("Was ist bei #1 zuletzt passiert?", {
      openTicketId: 1,
      messages: [
        { role: "user", content: "Hallo" },
        { role: "assistant", content: "Hi" },
        { role: "user", content: "Was ist bei #1 zuletzt passiert?" },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ticketsRead: [1] });
    // The open ticket is read without being asked; the source line needs a step for it too.
    expect(res.json().steps).toMatchObject([{ tool: "ticket_lesen", arg: "#1", ok: true }]);
    const messages = seen[0].messages as { role: string; content: string }[];
    expect(messages[0].role).toBe("system");
    expect(messages[1].content).toContain("Offene Tickets (2");
    expect(messages[1].content).toContain("Meine Buchungen heute");
    expect(messages[1].content).toContain("Ticket #1: Backup DC01");
    expect(messages[1].content).toContain("Exclusion gesetzt");
    expect(messages.slice(-3).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(calls.filter((c) => c.name === "ticketHistory")).toHaveLength(1);
    expectOnlyAllowedChatCalls(calls);
  });

  it("reads the tickets it asks for and reports them as steps", async () => {
    const { llm, seen } = scriptedLlm([
      { text: "", toolCalls: [toolCall("a", "ticket_lesen", { id: 1 }), toolCall("b", "leistungen_ticket", { id: 1 })] },
      { text: "In #1 wurde eine Exclusion gesetzt.", toolCalls: [] },
    ]);
    const { ask, calls } = await setupWith(llm);
    const res = await ask("Was ist bei #1 zuletzt passiert?");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ text: "In #1 wurde eine Exclusion gesetzt.", ticketsRead: [1] });
    expect(res.json().steps.map((s: { tool: string; arg: string }) => `${s.tool} ${s.arg}`)).toEqual([
      "ticket_lesen #1",
      "leistungen_ticket #1",
    ]);
    expect(res.json().steps.map((s: { ok: boolean }) => s.ok)).toEqual([true, true]);
    // The tool results went back to the model as tool messages.
    const second = seen[1].messages as { role: string; content: string }[];
    expect(second.filter((m) => m.role === "tool")).toHaveLength(2);
    expect(second.find((m) => m.role === "tool")?.content).toContain("Exclusion gesetzt");
    expectOnlyAllowedChatCalls(calls);
  });

  it("searches without a ticket number", async () => {
    const { llm } = scriptedLlm([
      { text: "", toolCalls: [toolCall("a", "tickets_suchen", { text: "Kunde" })] },
      { text: "Bei Kunde sind #1 und #2 offen.", toolCalls: [] },
    ]);
    const { ask, calls } = await setupWith(llm);
    const res = await ask("Was liegt bei Kunde offen?");
    expect(res.json().steps[0]).toMatchObject({ tool: "tickets_suchen", arg: "Kunde" });
    expect(res.json().steps[0].result).toContain("#99");
    expect(calls.some((c) => c.name === "search")).toBe(true);
  });

  it("reports a failed search instead of claiming nothing was found", async () => {
    const { llm } = scriptedLlm([
      { text: "", toolCalls: [toolCall("a", "tickets_suchen", { text: "Müller" })] },
      { text: "Die Suche ist gerade nicht möglich.", toolCalls: [] },
    ]);
    const { ask } = await setupWith(llm, {
      search: async () => {
        throw new TanssError("weg", 502);
      },
    });
    const res = await ask("Was liegt bei Müller offen?");
    expect(res.statusCode).toBe(200);
    expect(res.json().steps[0]).toMatchObject({ tool: "tickets_suchen", arg: "Müller", ok: false });
    expect(res.json().steps[0].result).toContain("fehlgeschlagen");
  });

  it("keeps a genuinely empty search result as ok", async () => {
    const { llm } = scriptedLlm([
      { text: "", toolCalls: [toolCall("a", "tickets_suchen", { text: "Nirgendwo" })] },
      { text: "Keine Treffer.", toolCalls: [] },
    ]);
    const { ask } = await setupWith(llm, { search: async () => ({ tickets: [], companies: [], linked: {} }) });
    const res = await ask("Was liegt bei Nirgendwo offen?");
    expect(res.json().steps[0]).toMatchObject({ tool: "tickets_suchen", ok: true });
    expect(res.json().steps[0].result).toContain("Keine Tickets");
  });

  it("keeps every TANSS call within the tool chat's read-only whitelist", async () => {
    const { llm } = scriptedLlm([
      {
        text: "",
        toolCalls: [
          toolCall("a", "tickets_suchen", { text: "Kunde" }),
          toolCall("b", "ticket_lesen", { id: 1 }),
          toolCall("c", "leistungen_ticket", { id: 1 }),
        ],
      },
      { text: "Zusammengefasst.", toolCalls: [] },
    ]);
    const { ask, calls } = await setupWith(llm);
    const res = await ask("Fass alles zu #1 zusammen");
    expect(res.statusCode).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
    expectOnlyAllowedChatCalls(calls);
  });

  it("stops after the fourth round and answers with a note about the limit", async () => {
    const { llm, seen, rounds } = scriptedLlm([{ text: "", toolCalls: [toolCall("a", "tickets_suchen", { text: "Kunde" })] }]);
    const { ask } = await setupWith(llm);
    const res = await ask("Suche weiter");
    expect(res.statusCode).toBe(200);
    expect(rounds()).toBe(4);
    // The last round gets no tools and an order to answer now.
    expect(seen[3].tools).toEqual([]);
    const last = seen[3].messages as { role: string; content: string }[];
    expect(last[last.length - 1].content).toContain("Antworte jetzt");
    // The scripted answer at the limit carries only a tool call, no text — the
    // route must not hand that through as an empty bubble in the sidebar.
    expect(res.json().text).toContain("Grenze für dieses Gespräch");
    expect(res.json().text).toContain("noch nichts");
  });

  it("refuses a fourth history and a broken argument without failing the request", async () => {
    const { llm } = scriptedLlm([
      {
        text: "",
        toolCalls: [
          toolCall("a", "ticket_lesen", { id: 1 }),
          toolCall("b", "ticket_lesen", { id: 2 }),
          toolCall("c", "ticket_lesen", { id: 3 }),
          toolCall("d", "ticket_lesen", { id: 4 }),
          { id: "e", name: "ticket_lesen", arguments: "kein json" },
        ],
      },
      { text: "Drei Verläufe reichen.", toolCalls: [] },
    ]);
    const { ask } = await setupWith(llm);
    const res = await ask("Lies alles");
    const steps = res.json().steps as { result: string }[];
    expect(res.statusCode).toBe(200);
    expect(res.json().ticketsRead).toEqual([1, 2, 3]);
    expect(steps[3].result).toContain("drei Verläufe");
    expect(steps[4].result).toContain("JSON");
  });

  it("turns a TANSS failure into a tool result instead of an error", async () => {
    const { llm } = scriptedLlm([
      { text: "", toolCalls: [toolCall("a", "ticket_lesen", { id: 1 })] },
      { text: "#1 konnte ich nicht öffnen.", toolCalls: [] },
    ]);
    const { ask } = await setupWith(llm, {
      ticketById: async () => {
        throw new TanssError("weg", 404);
      },
    });
    const res = await ask("Was ist bei #1?");
    expect(res.statusCode).toBe(200);
    expect(res.json().ticketsRead).toEqual([]);
    expect(res.json().steps[0].result).toContain("nicht lesbar");
    expect(res.json().steps[0].ok).toBe(false);
  });

  it("stops after the sixth tool call within a round and tells the model so", async () => {
    const { llm, seen } = scriptedLlm([
      {
        text: "",
        toolCalls: Array.from({ length: 7 }, (_, i) => toolCall(String(i), "tickets_suchen", { text: "Kunde" })),
      },
      { text: "Fertig.", toolCalls: [] },
    ]);
    const { ask } = await setupWith(llm);
    const res = await ask("Suche mehrfach");
    expect(res.statusCode).toBe(200);
    expect(res.json().steps).toHaveLength(6);
    const roundTwo = seen[1].messages as { role: string; content: string }[];
    const toolMessages = roundTwo.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(7);
    expect(toolMessages.filter((m) => m.content.includes("Antworte jetzt"))).toHaveLength(1);
  });

  it("stops running tools once the 120 s deadline is passed and still answers", async () => {
    const { llm } = scriptedLlm([
      {
        text: "",
        toolCalls: [
          toolCall("a", "ticket_lesen", { id: 1 }),
          toolCall("b", "ticket_lesen", { id: 2 }),
          toolCall("c", "ticket_lesen", { id: 3 }),
        ],
      },
      { text: "Die Zeit ist um.", toolCalls: [] },
    ]);
    // Every now() read — inside and outside the chat loop — advances 60 s.
    const { ask, calls } = await setupWith(llm, {}, steppingNow(60_000));
    const res = await ask("Lies alle drei");
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBe("Die Zeit ist um.");
    // The round-start check alone would still have let this round's tools run;
    // only the per-call check the fix adds keeps them from executing at all.
    expect(calls.some((c) => c.name === "ticketHistory")).toBe(false);
  });

  it("caps the answer at 2000 tokens", async () => {
    const { llm, seen } = scriptedLlm([{ text: "Kurze Antwort.", toolCalls: [] }]);
    const { ask } = await setupWith(llm);
    await ask("Was ist bei #1?");
    expect((seen[0].opts as { maxTokens?: number }).maxTokens).toBe(2000);
  });

  it("names the available tools when the model invents one", async () => {
    const { llm } = scriptedLlm([
      { text: "", toolCalls: [toolCall("a", "ticket_loeschen", { id: 1 })] },
      { text: "Das kann ich nicht.", toolCalls: [] },
    ]);
    const { ask } = await setupWith(llm);
    const res = await ask("Lösch mal #1");
    expect(res.statusCode).toBe(200);
    expect(res.json().steps[0].result).toContain("Unbekanntes Werkzeug");
    expect(res.json().steps[0].result).toContain("tickets_suchen");
  });

  it("reads a ticket only once even if the model asks twice", async () => {
    const { llm } = scriptedLlm([
      { text: "", toolCalls: [toolCall("a", "ticket_lesen", { id: 1 }), toolCall("b", "ticket_lesen", { id: 1 })] },
      { text: "In #1 wurde eine Exclusion gesetzt.", toolCalls: [] },
    ]);
    const { ask, calls } = await setupWith(llm);
    const res = await ask("Was ist bei #1?");
    expect(res.statusCode).toBe(200);
    expect(res.json().ticketsRead).toEqual([1]);
    expect(res.json().steps[1].result).toContain("schon gelesen");
    expect(calls.filter((c) => c.name === "ticketHistory")).toHaveLength(1);
  });

  it("falls back to the fixed context when the endpoint rejects tools", async () => {
    const asked: string[] = [];
    const llm: LlmClient = {
      listModels: async () => [],
      chat: async (_s, messages) => {
        asked.push(messages.map((m) => m.content).join("\n"));
        return "Ohne Werkzeuge, aber mit Kontext.";
      },
      chatWithTools: async () => {
        throw new LlmError("KI-Endpoint antwortet 400: tools not supported", 424, 400);
      },
    };
    const { ask } = await setupWith(llm);
    const res = await ask("Was ist bei #1 zuletzt passiert?");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: "Ohne Werkzeuge, aber mit Kontext.", ticketsRead: [1], steps: [] });
    // The named ticket came in through the old #-path.
    expect(asked[0]).toContain("Ticket #1: Backup DC01");
  });

  it("does not fall back on an LlmError with a different endpointStatus", async () => {
    let chatCalls = 0;
    const llm: LlmClient = {
      listModels: async () => [],
      chat: async () => {
        chatCalls += 1;
        return "sollte nicht laufen";
      },
      chatWithTools: async () => {
        throw new LlmError("KI-Endpoint antwortet 500", 424, 500);
      },
    };
    const { ask } = await setupWith(llm);
    const res = await ask("Was ist bei #1 zuletzt passiert?");
    expect(res.statusCode).not.toBe(200);
    expect(chatCalls).toBe(0);
  });

  it("does not fall back on a 400 from a later round, e.g. the toolless finishing round", async () => {
    let round = 0;
    let chatCalls = 0;
    const llm: LlmClient = {
      listModels: async () => [],
      chat: async () => {
        chatCalls += 1;
        return "sollte nicht laufen";
      },
      chatWithTools: async () => {
        round += 1;
        // Round 1 runs a tool, as if the loop were going fine; only the
        // request that follows (never round 0) hits the context-length 400.
        if (round === 1) return { text: "", toolCalls: [toolCall("a", "ticket_lesen", { id: 1 })] };
        throw new LlmError("KI-Endpoint antwortet 400: context length exceeded", 424, 400);
      },
    };
    const { ask } = await setupWith(llm);
    const res = await ask("Was ist bei #1 zuletzt passiert?");
    expect(res.statusCode).not.toBe(200);
    // Falling back here would silently discard the tool results and hide the failure.
    expect(chatCalls).toBe(0);
  });

  it("does not fall back on an error without an endpointStatus", async () => {
    let chatCalls = 0;
    const llm: LlmClient = {
      listModels: async () => [],
      chat: async () => {
        chatCalls += 1;
        return "sollte nicht laufen";
      },
      chatWithTools: async () => {
        throw new Error("Zeitüberschreitung");
      },
    };
    const { ask } = await setupWith(llm);
    const res = await ask("Was ist bei #1 zuletzt passiert?");
    expect(res.statusCode).not.toBe(200);
    expect(chatCalls).toBe(0);
  });

  it("reports whether the model can use tools", async () => {
    const good = scriptedLlm([{ text: "bereit", toolCalls: [] }]);
    const { call } = await setupWith(good.llm);
    expect((await call("POST", "/me/agent/test", {})).json()).toMatchObject({ ok: true, tools: true });

    const bad: LlmClient = {
      listModels: async () => [],
      chat: async () => "bereit",
      chatWithTools: async () => {
        throw new LlmError("KI-Endpoint antwortet 400", 424, 400);
      },
    };
    const second = await setupWith(bad);
    expect((await second.call("POST", "/me/agent/test", {})).json()).toMatchObject({ ok: true, tools: false });
  });
});

describe("ticket actions", () => {
  it("drafts an activity text from the thread", async () => {
    const { call, prompts } = await setup("Exclusion gesetzt und getestet.");
    const res = await call("POST", "/me/agent/draft", { ticketIds: [1], intent: "support", instruction: "", internal: true });
    expect(res.json().text).toBe("Exclusion gesetzt und getestet.");
    expect(prompts[0]).toContain("Tätigkeitstext für eine Leistungsbuchung");
    expect(prompts[0]).toContain("Exclusion gesetzt");
    const many = await call("POST", "/me/agent/draft", { ticketIds: [1, 2], intent: "support", instruction: "", internal: true });
    expect(many.statusCode).toBe(400);
  });

  it("replies to one inbound mail, quotes stripped", async () => {
    const { call, prompts } = await setup("Ja, seit heute Nacht.");
    const res = await call("POST", "/me/agent/draft", { ticketIds: [1], intent: "reply", instruction: "", internal: false, mailKey: "mail:5" });
    expect(res.json().text).toBe("Ja, seit heute Nacht.");
    expect(prompts[0]).toContain("=== Zu beantwortende Mail ===");
    expect(prompts[0]).toContain("Läuft es jetzt?");
    expect(prompts[0]).not.toContain("alte Mail");
    const missing = await call("POST", "/me/agent/draft", { ticketIds: [1], intent: "reply", instruction: "", internal: false, mailKey: "mail:404" });
    expect(missing.statusCode).toBe(400);
  });

  it("names the next step and maps the status suggestion to an id", async () => {
    const { call, prompts } = await setup('{"text":"Kunden um Rückmeldung bitten","owner":"Kunde","status":"wartet auf kunde"}');
    const res = await call("POST", "/me/agent/next", { ticketId: 1 });
    expect(res.json()).toMatchObject({ text: "Kunden um Rückmeldung bitten", owner: "Kunde", statusName: "Wartet auf Kunde", statusId: 6, unchanged: false });
    expect(prompts[0]).toContain("„Wartet auf Kunde");
    const none = await setup('{"text":"Warten","owner":"wir","status":"Erfunden"}');
    expect((await none.call("POST", "/me/agent/next", { ticketId: 1 })).json()).toMatchObject({ statusName: null, statusId: null });
  });

  it("finds similar tickets among search hits and board rows", async () => {
    const { call, prompts, calls } = await setup('{"similar":[{"ticketId":99,"reason":"gleicher Backup-Fehler"},{"ticketId":1,"reason":"selbst"}]}');
    const res = await call("POST", "/me/agent/similar", { ticketId: 1, rows: [row({ id: 1 }), row({ id: 2, title: "Drucker" })], activity: {} });
    expect(res.json()).toMatchObject({ checked: 2, searched: "Backup DC01", searchHits: 1 });
    expect(res.json().similar).toEqual([{ ticketId: 99, reason: "gleicher Backup-Fehler", title: "Backup DC02 bricht ab", companyName: "Kunde", statusName: "" }]);
    expect(calls.find((c) => c.name === "search")!.args[1]).toBe("Backup DC01");
    expect(prompts[0]).not.toContain("  #1 ·");
  });

  it("cleans a mail after stripping quotes deterministically", async () => {
    const { call, prompts } = await setup("Frage: läuft das Backup?");
    const res = await call("POST", "/me/agent/clean-mail", { ticketId: 1, mailKey: "mail:5" });
    expect(res.json().text).toBe("Frage: läuft das Backup?");
    expect(res.json().strippedChars).toBeGreaterThan(0);
    expect(prompts[0]).toContain("Läuft es jetzt?");
    expect(prompts[0]).not.toContain("alte Mail");
    expect((await call("POST", "/me/agent/clean-mail", { ticketId: 1, mailKey: "comment:9" })).statusCode).toBe(404);
  });
});

function row(over: Record<string, unknown>) {
  return {
    id: 1, title: "T", companyId: 5, companyName: "Kunde", projectId: 0, projectName: "", statusId: 2, statusName: "Neu",
    typeName: "", assigneeId: 7, assigneeName: "Sören", departmentName: "", modified: 0, creationDate: 0, dueDate: 0,
    deadlineDate: 0, waiting: false, isProject: false, estimatedMinutes: 0, ...over,
  };
}

describe("customer check", () => {
  /** The ticket text names a different company than the one it is assigned to. */
  const mentionsMueller = (p: string) =>
    p.includes("Welcher der Kunden aus TANSS")
      ? '{"companyId":42,"reason":"Mail-Domain passt"}'
      : '{"name":"Müller GmbH","evidence":"im Auftrag der Müller GmbH"}';
  // Two plausible spellings, neither an exact hit — so the model has to choose.
  const found = {
    search: async () => ({
      tickets: [],
      companies: [
        { id: 42, name: "Müller GmbH Kiel", city: "Kiel", website: "https://www.mueller-kiel.de" },
        { id: 43, name: "Müller Holding", city: "Hamburg" },
      ],
      linked: {},
    }),
  };

  it("suggests the company named in the text and changes nothing by itself", async () => {
    const { call, calls, prompts } = await setup(mentionsMueller, true, found);
    const res = await call("POST", "/me/agent/company", { ticketId: 1 });
    expect(res.json()).toMatchObject({
      verdict: "differs",
      mentioned: "Müller GmbH",
      currentCompanyName: "Kunde",
      suggestion: { companyId: 42, name: "Müller GmbH Kiel", reason: "Mail-Domain passt" },
    });
    expect(calls.some((c) => c.name === "updateTicket")).toBe(false);
    expect(prompts[0]).toContain("Job bricht ab");
    expect(prompts[1]).toContain("mueller-kiel.de");
  });

  it("says the customer fits without asking the model a second time", async () => {
    const { call, prompts } = await setup('{"name":"Kunde GmbH","evidence":"Kunde GmbH meldet"}');
    const res = await call("POST", "/me/agent/company", { ticketId: 1 });
    expect(res.json()).toMatchObject({ verdict: "matches", mentioned: "Kunde GmbH", suggestion: null });
    expect(prompts).toHaveLength(1);
  });

  it("reports when no company is named in the text", async () => {
    const { call } = await setup('{"name":null,"evidence":""}');
    expect((await call("POST", "/me/agent/company", { ticketId: 1 })).json()).toMatchObject({
      verdict: "none-named",
      suggestion: null,
    });
  });

  it("reports when TANSS knows no such customer", async () => {
    const { call, prompts } = await setup('{"name":"Müller GmbH","evidence":"…"}', true, {
      search: async () => ({ tickets: [], companies: [], linked: {} }),
    });
    expect((await call("POST", "/me/agent/company", { ticketId: 1 })).json()).toMatchObject({
      verdict: "not-found",
      mentioned: "Müller GmbH",
      candidates: [],
    });
    expect(prompts).toHaveLength(1);
  });

  it("takes a single exact hit without asking the model to choose", async () => {
    const { call, prompts } = await setup('{"name":"Müller GmbH","evidence":"…"}', true, {
      search: async () => ({ tickets: [], companies: [{ id: 42, name: "Müller  GmbH", city: "Kiel" }], linked: {} }),
    });
    const res = await call("POST", "/me/agent/company", { ticketId: 1 });
    expect(res.json().suggestion).toMatchObject({ companyId: 42, name: "Müller  GmbH" });
    expect(prompts).toHaveLength(1);
  });
});
