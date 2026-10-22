/**
 * The agent routes: settings for the local model and the assistant
 * functions. The model only ever produces text; every write to TANSS is made
 * by a person through the existing routes.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ACTIVITY_LOOKBACK_DAYS, type Activity } from "../shared/activity.ts";
import {
  SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT,
  DEFAULT_CONTEXT_TOKENS,
  briefingFacts,
  briefingPrompt,
  chatContext,
  cleanMailPrompt,
  companyCheckSource,
  companyPickPrompt,
  mentionedCompanyPrompt,
  mentionedTicketIds,
  parseCompanyPick,
  parseMentionedCompany,
  sameCompany,
  nextStepPrompt,
  parseNextStep,
  parseSimilar,
  searchTerms,
  similarPrompt,
  stripMailNoise,
  draftPrompt,
  parsePatterns,
  patternsPrompt,
  summaryPrompt,
  threadBudget,
  issueTextPrompt,
  ticketContext,
  type BriefingFacts,
  type BriefingScope,
  type ChatTurn,
  type CompanyCandidate,
  type CompanyCheck,
  type DraftIntent,
  type PatternGroup,
} from "../shared/agent.ts";
import {
  BUDGET_EXHAUSTED,
  CHAT_TOOLS,
  CHAT_TOOL_NAMES,
  MIN_READ_CHARS,
  TICKET_LIMIT_REACHED,
  readShare,
  searchFailedText,
  searchResultText,
  supportsText,
} from "../shared/chat-tools.ts";
import { buildThread, type ThreadEntry } from "../shared/thread.ts";
import { berlinDayRangeUnix, berlinYmd, shiftYmd } from "../shared/days.ts";
import { matchesQuery, toTicketRow, type TicketRow } from "../shared/tickets.ts";
import { buildBlocks, supportsOfDay, sumMinutes, toSupport } from "../shared/timeline.ts";
import {
  ASSISTANT_RULES,
  PATTERN_DAYS,
  assistantPrompt,
  findPatterns,
  parseAssistant,
  type DayContext,
} from "../shared/assistant.ts";
import {
  APPOINTMENT_PLANNING_TYPES,
  appointmentToTemplate,
  callToTemplate,
  isAppointment,
  openTemplates,
  type BookingTemplate,
} from "../shared/template.ts";
import { routinesForGap } from "../shared/routines.ts";
import { styleSection } from "../shared/style.ts";
import { buildSuggestions, importKey } from "../shared/import.ts";
import type { LinearClient } from "./linear.ts";
import {
  LlmError,
  extractJson,
  normalizeBaseUrl,
  type ChatMessage,
  type LlmClient,
  type LlmSettings,
  type ToolCall,
  type ToolDef,
} from "./llm.ts";
import type { Store } from "./store.ts";
import { TanssError, type TanssClient, type TanssSession } from "./tanss.ts";
import { createDoneTickets, type DoneTickets } from "./done-tickets.ts";
import {
  SOLUTION_MESSAGES,
  parseSolutionPick,
  plainText,
  rankCandidates,
  solutionPickPrompt,
  solutionPrompt,
  type SolutionAnswer,
  type SolutionSource,
} from "../shared/solution.ts";

export type AgentDeps = {
  tanss: TanssClient;
  llm: LlmClient;
  store: Store;
  now: () => number;
  withSession<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    work: (session: TanssSession) => Promise<T>,
  ): Promise<T>;
  mapPool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]>;
  /** Optional: without it the assistant's Linear block simply stays empty. */
  linear?: LinearClient;
};

const PATTERN_MAX_ROWS = 80;
/** Ticket histories one chat turn may pull in. */
const CHAT_MAX_TICKETS = 3;
const CHAT_MAX_TURNS = 12;
/** Each round is a full model call, so few of them. */
const CHAT_MAX_ROUNDS = 4;
const CHAT_MAX_TOOL_CALLS = 6;
/** llm.ts allows 180 s per call; four rounds must not become twelve minutes. */
const CHAT_DEADLINE_MS = 120_000;
/** A mail draft does not fit in the 600 tokens a short answer needs. */
const CHAT_MAX_TOKENS = 2_000;
const CHAT_SUPPORT_DAYS = 365;
const FINISH_NOW =
  "Keine weiteren Werkzeuge mehr. Antworte jetzt mit dem, was du gelesen hast, und sag dabei, was du nicht prüfen konntest.";
/**
 * Share of threadBudget() the whole tool loop may spend on ticket reads.
 * Leaves room for the board, today's bookings, up to twelve turns and the
 * long answers this feature allows (2000 tokens, mail drafts) within the
 * same RESERVED_TOKENS reserve — see the design doc's I2 finding.
 */
const TOOL_LOOP_BUDGET_FRACTION = 0.6;

export type ChatStep = { tool: string; arg: string; result: string; ok: boolean };

/**
 * Thrown only when the very first tools request of a chat turn fails with a
 * 400 — before any tool ran. That is the one situation the model genuinely
 * cannot do tool-calling, so the route may fall back to the fixed-context
 * path. Any 400 from a later round (e.g. a toolless finishing round whose
 * body carries no `tools` at all) is a real failure and must propagate.
 */
class ToolsUnsupportedError extends Error {
  readonly cause: LlmError;
  constructor(cause: LlmError) {
    super(cause.message);
    this.cause = cause;
  }
}

/** What the forced finishing round falls back to when the model gives tool calls (or nothing) but no text. */
function limitReachedText(read: number[]): string {
  const gelesen = read.length ? `Gelesen habe ich dabei ${read.map((id) => `#${id}`).join(", ")}.` : "Gelesen habe ich dabei noch nichts.";
  return (
    "Ich bin an die Grenze für dieses Gespräch gestoßen (Runden, Werkzeugaufrufe oder Zeit) und kann nicht weiter nachlesen. " +
    `${gelesen} Bitte frag gezielter oder in einem neuen Gespräch weiter.`
  );
}

const searchArgs = z.object({ text: z.string().trim().min(2).max(120) });
// Models like to send numbers as strings; coerce rather than scold.
const ticketArgs = z.object({ id: z.coerce.number().int().positive() });

const settingsSchema = z.object({
  baseUrl: z.string().trim().max(500),
  apiKey: z.string().max(500).optional(),
  model: z.string().trim().max(200),
  contextTokens: z.number().int().min(2_048).max(2_000_000).default(DEFAULT_CONTEXT_TOKENS),
});

function publicSettings(s: LlmSettings) {
  return {
    baseUrl: s.baseUrl,
    model: s.model,
    contextTokens: s.contextTokens,
    threadChars: threadBudget(s.contextTokens),
    hasKey: Boolean(s.apiKey),
    keyHint: maskKey(s.apiKey),
    ready: Boolean(s.baseUrl && s.model),
  };
}

const rowSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  companyId: z.number(),
  companyName: z.string(),
  projectId: z.number(),
  projectName: z.string(),
  statusId: z.number(),
  statusName: z.string(),
  typeName: z.string(),
  assigneeId: z.number(),
  assigneeName: z.string(),
  departmentName: z.string(),
  modified: z.number(),
  creationDate: z.number(),
  dueDate: z.number(),
  deadlineDate: z.number(),
  waiting: z.boolean(),
  isProject: z.boolean(),
  estimatedMinutes: z.number(),
});

const activitySchema = z.record(
  z.string(),
  z.object({ at: z.number(), kind: z.enum(["support", "comment", "none"]), historyRead: z.boolean() }),
);

const rowsSchema = z.object({
  rows: z.array(rowSchema).max(2000),
  activity: activitySchema.default({}),
  force: z.boolean().optional(),
});

const briefingSchema = rowsSchema.extend({
  /** "mine" or a list key; the label names the list in the prompt. */
  scope: z.string().trim().min(1).max(120).default("mine"),
  label: z.string().trim().max(120).default(""),
});

const chatSchema = rowsSchema.extend({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) })).min(1).max(60),
  openTicketId: z.number().int().positive().nullable().default(null),
});

const summarySchema = z.object({ ticketId: z.number().int().positive() });

const draftSchema = z.object({
  ticketIds: z.array(z.number().int().positive()).min(1).max(50),
  intent: z.enum(["status", "summary", "close", "custom", "support", "reply"]),
  instruction: z.string().trim().max(2000).default(""),
  internal: z.boolean(),
  /** Thread key of the inbound mail a reply is for. */
  mailKey: z.string().max(80).optional(),
});

const ticketSchema = z.object({ ticketId: z.number().int().positive() });
const mailSchema = ticketSchema.extend({ mailKey: z.string().min(1).max(80) });
const similarSchema = rowsSchema.extend({ ticketId: z.number().int().positive() });
/** Board rows plus search hits the similarity check may show the model. */
const SIMILAR_MAX_CANDIDATES = 60;
/** Companies the customer check offers the model to choose from. */
const COMPANY_MAX_CANDIDATES = 10;
/** Share of the thread budget for the ticket a solution is wanted for; the sources split the rest. */
const SOLUTION_SUBJECT_SHARE = 1 / 3;
/** Most characters of a source ticket's internal note in the proposal prompt (and never more than a quarter of its share). */
const SOLUTION_NOTE_CHARS = 2_000;

const issueTextSchema = z.object({
  issue: z.string().trim().min(1).max(60),
  title: z.string().trim().max(300).default(""),
  project: z.string().trim().max(200).default(""),
  notes: z.string().trim().max(20_000).default(""),
});

const assistantSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Ask about one gap instead of the whole day. */
  focus: z
    .object({ start: z.number().int().min(0).max(24 * 60 - 1), end: z.number().int().min(1).max(24 * 60) })
    .optional(),
});


export function maskKey(key: string): string {
  if (!key) return "";
  return key.length <= 8 ? "••••" : `${key.slice(0, 3)}…${key.slice(-3)}`;
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentDeps): void {
  const { tanss, llm, store, now, withSession, mapPool } = deps;
  /** One briefing per employee, scope and day; `force` throws it away. */
  const briefings = new Map<string, { day: string; facts: BriefingFacts; text: string; at: number }>();
  /** Done tickets per employee and customer, in memory for a few minutes. */
  const doneTickets = createDoneTickets({ tanss, now });

  function settings(): LlmSettings {
    return store.llm();
  }
  function configured(): LlmSettings {
    const s = settings();
    if (!s.baseUrl || !s.model) throw new LlmError("KI ist nicht eingerichtet — Einstellungen öffnen", 409);
    return s;
  }
  async function ask(prompt: string, opts?: { json?: boolean; maxTokens?: number }): Promise<string> {
    return llm.chat(configured(), [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }], opts);
  }
  async function loadTicket(
    session: TanssSession,
    id: number,
    /** Fraction of the thread budget this ticket may use (several tickets share one prompt). */
    share = 1,
  ): Promise<{ row: TicketRow; context: string; thread: ThreadEntry[]; description: string; internalNote: string }> {
    const [ticket, history] = await Promise.all([tanss.ticketById(session, id), tanss.ticketHistory(session, id)]);
    const linked = { ...history.linked, ...ticket.linked };
    const row = toTicketRow(ticket.item, linked, []);
    const thread = buildThread(ticket.item, history.content, linked, row.companyName);
    const budget = Math.round(threadBudget(settings().contextTokens) * share);
    return {
      row,
      context: ticketContext(row, thread, budget),
      thread,
      description: String(ticket.item.content ?? ""),
      internalNote: String(ticket.item.internalContent ?? ""),
    };
  }

  type ChatState = {
    rows: TicketRow[];
    today: string;
    /** The tool loop's own budget (TOOL_LOOP_BUDGET_FRACTION of threadBudget) — what readShare() accounts against. */
    budgetTotal: number;
    /** The full threadBudget(); loadTicket() wants its `share` as a fraction of this, not of budgetTotal. */
    budgetFull: number;
    budgetLeft: number;
    read: number[];
  };

  /** Runs one tool call. Every failure comes back as text for the model, never as an exception. */
  async function runTool(session: TanssSession, call: ToolCall, state: ChatState): Promise<ChatStep> {
    const step = (arg: string, result: string, ok = false): ChatStep => ({ tool: call.name, arg, result, ok });
    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments || "{}");
    } catch {
      return step("", "Die Argumente waren kein gültiges JSON. Bitte den Aufruf wiederholen.");
    }
    if (call.name === "tickets_suchen") {
      const parsed = searchArgs.safeParse(raw);
      if (!parsed.success) return step("", 'Erwartet wird { "text": "Suchbegriff" }.');
      const query = parsed.data.text;
      let hits: TicketRow[];
      try {
        const r = await tanss.search(session, query);
        hits = r.tickets.map((t) => toTicketRow(t, r.linked, []));
      } catch {
        // Tell this apart from a genuine zero-hit search: it was not actually checked.
        return step(query, searchFailedText(query));
      }
      const seen = new Set<number>();
      const found: TicketRow[] = [];
      for (const r of [...hits, ...state.rows.filter((r) => matchesQuery(r, query))]) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        found.push(r);
      }
      return step(query, searchResultText(query, found), true);
    }
    if (call.name === "ticket_lesen") {
      const parsed = ticketArgs.safeParse(raw);
      if (!parsed.success) return step("", 'Erwartet wird { "id": 4711 }.');
      const id = parsed.data.id;
      if (state.read.includes(id)) return step(`#${id}`, `Ticket #${id} hast du in diesem Gespräch schon gelesen.`);
      if (state.read.length >= CHAT_MAX_TICKETS) return step(`#${id}`, TICKET_LIMIT_REACHED);
      const share = readShare(state.budgetTotal, state.budgetLeft);
      if (share < MIN_READ_CHARS) return step(`#${id}`, BUDGET_EXHAUSTED);
      // share is chars within the loop's budget; loadTicket wants a fraction of the FULL thread budget.
      const loaded = await loadTicket(session, id, share / state.budgetFull).catch(() => null);
      if (!loaded) return step(`#${id}`, `Ticket #${id} ist nicht lesbar — es gibt es nicht oder du hast keinen Zugriff.`);
      state.read.push(id);
      state.budgetLeft -= loaded.context.length;
      return step(`#${id}`, loaded.context, true);
    }
    if (call.name === "leistungen_ticket") {
      const parsed = ticketArgs.safeParse(raw);
      if (!parsed.success) return step("", 'Erwartet wird { "id": 4711 }.');
      const id = parsed.data.id;
      const from = berlinDayRangeUnix(shiftYmd(state.today, -CHAT_SUPPORT_DAYS)).from;
      const list = await tanss.ticketSupports(session, [id], from, berlinDayRangeUnix(state.today).to).catch(() => null);
      if (!list) return step(`#${id}`, `Die Leistungen zu #${id} sind nicht lesbar.`);
      return step(`#${id}`, supportsText(list.map((s) => toSupport(s, {})), session.employeeId), true);
    }
    return step("", `Unbekanntes Werkzeug „${call.name}". Es gibt: ${CHAT_TOOL_NAMES.join(", ")}.`);
  }

  /**
   * The chat loop: ask, run what the model asks for, ask again. It ends on a
   * text answer or on a limit — and a limit always gets one last toolless
   * round instead of an error, so the user gets an answer either way.
   */
  async function runChatLoop(input: {
    session: TanssSession;
    context: string;
    turns: ChatTurn[];
    rows: TicketRow[];
    today: string;
    /** The open ticket is loaded up front; it counts against both limits. */
    preRead: number[];
    usedChars: number;
  }): Promise<{ text: string; ticketsRead: number[]; steps: ChatStep[] }> {
    const budgetFull = threadBudget(settings().contextTokens);
    const budgetTotal = Math.round(budgetFull * TOOL_LOOP_BUDGET_FRACTION);
    const state: ChatState = {
      rows: input.rows,
      today: input.today,
      budgetTotal,
      budgetFull,
      budgetLeft: Math.max(0, budgetTotal - input.usedChars),
      read: [...input.preRead],
    };
    const messages: ChatMessage[] = [
      { role: "system", content: CHAT_SYSTEM_PROMPT },
      { role: "user", content: `Kontext:\n\n${input.context}` },
      { role: "assistant", content: "Verstanden, ich halte mich an diesen Kontext." },
      ...input.turns,
    ];
    const steps: ChatStep[] = [];
    const deadline = now() + CHAT_DEADLINE_MS;
    let calls = 0;
    // The last round always returns, so this cannot spin.
    for (let round = 0; ; round++) {
      const last = round >= CHAT_MAX_ROUNDS - 1 || calls >= CHAT_MAX_TOOL_CALLS || now() >= deadline;
      let answer: { text: string; toolCalls: ToolCall[] };
      try {
        answer = await llm.chatWithTools(
          configured(),
          last ? [...messages, { role: "user", content: FINISH_NOW }] : messages,
          last ? ([] as ToolDef[]) : (CHAT_TOOLS as unknown as ToolDef[]),
          { maxTokens: CHAT_MAX_TOKENS },
        );
      } catch (error) {
        // Only the very first request (round 0, no tool has run yet) failing with a
        // 400 means the model cannot do tool-calling at all — anything later is a
        // real failure (e.g. the toolless finishing round overrunning the context).
        if (round === 0 && error instanceof LlmError && error.endpointStatus === 400) {
          throw new ToolsUnsupportedError(error);
        }
        throw error;
      }
      if (last || answer.toolCalls.length === 0) {
        const text = last && !answer.text.trim() ? limitReachedText(state.read) : answer.text;
        return { text, ticketsRead: state.read, steps };
      }
      messages.push({ role: "assistant", content: answer.text, toolCalls: answer.toolCalls });
      for (const call of answer.toolCalls) {
        // Cheap deadline enforcement: no AbortSignal reaches the model call or
        // runTool's TANSS requests, so a hung request can still overrun 120 s by
        // one in-flight call — but never by a whole extra round or more.
        if (calls >= CHAT_MAX_TOOL_CALLS || now() >= deadline) {
          messages.push({ role: "tool", toolCallId: call.id, content: FINISH_NOW });
          continue;
        }
        calls += 1;
        const step = await runTool(input.session, call, state);
        steps.push(step);
        messages.push({ role: "tool", toolCallId: call.id, content: step.result });
      }
    }
  }

  /**
   * The way it worked before tools: a fixed context with the histories the
   * question names. Kept for models whose endpoint rejects a tools request.
   */
  async function legacyChat(input: {
    context: string;
    turns: ChatTurn[];
    extra: { row: TicketRow; context: string }[];
  }): Promise<{ text: string; ticketsRead: number[]; steps: ChatStep[] }> {
    const withExtra = input.extra.length
      ? `${input.context}\n\n${input.extra.map((t) => `--- Verlauf ---\n${t.context}`).join("\n\n")}`
      : input.context;
    const text = await llm.chat(
      configured(),
      [
        { role: "system", content: CHAT_SYSTEM_PROMPT },
        { role: "user", content: `Kontext:\n\n${withExtra}` },
        { role: "assistant", content: "Verstanden, ich halte mich an diesen Kontext." },
        ...input.turns,
      ],
      { maxTokens: CHAT_MAX_TOKENS },
    );
    return { text, ticketsRead: input.extra.map((t) => t.row.id), steps: [] };
  }

  // --- settings --------------------------------------------------------------

  /**
   * An omitted key keeps the stored one, an empty string clears it. The stored
   * key only ever goes to the stored endpoint: a request naming another URL
   * would otherwise hand the key to whoever runs that URL.
   */
  function keyFor(baseUrl: string, given: string | undefined, current: LlmSettings): string {
    if (given !== undefined) return given;
    return baseUrl === current.baseUrl ? current.apiKey : "";
  }

  app.get("/me/agent/settings", async (request, reply) => {
    return withSession(request, reply, async () => {
      return publicSettings(settings());
    });
  });

  app.put("/me/agent/settings", async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Einstellungen unvollständig" });
    return withSession(request, reply, async () => {
      const current = settings();
      const baseUrl = normalizeBaseUrl(parsed.data.baseUrl);
      const next: LlmSettings = {
        baseUrl,
        apiKey: keyFor(baseUrl, parsed.data.apiKey, current),
        model: parsed.data.model,
        contextTokens: parsed.data.contextTokens,
      };
      store.setLlm(next);
      return publicSettings(next);
    });
  });

  /** Models of the endpoint — from the form's values, falling back to what is stored. */
  app.post("/me/agent/models", async (request, reply) => {
    const parsed = z.object({ baseUrl: z.string().max(500).optional(), apiKey: z.string().max(500).optional() }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Anfrage ungültig" });
    return withSession(request, reply, async () => {
      const current = settings();
      const baseUrl = normalizeBaseUrl(parsed.data.baseUrl ?? current.baseUrl);
      return { models: await llm.listModels({ baseUrl, apiKey: keyFor(baseUrl, parsed.data.apiKey, current) }) };
    });
  });

  app.post("/me/agent/test", async (request, reply) => {
    return withSession(request, reply, async () => {
      const started = now();
      const answer = await llm.chat(configured(), [{ role: "user", content: "Antworte nur mit dem Wort: bereit" }], { maxTokens: 20 });
      // A tiny tools request tells us whether the chat can use its toolbox.
      const tools = await llm
        .chatWithTools(configured(), [{ role: "user", content: "Antworte nur mit dem Wort: bereit" }], CHAT_TOOLS as unknown as ToolDef[], { maxTokens: 20 })
        .then(() => true)
        .catch((error) => !(error instanceof LlmError) || error.endpointStatus !== 400);
      return { ok: true, answer: answer.slice(0, 100), durationMs: now() - started, tools };
    });
  });

  // --- assistant functions ---------------------------------------------------

  app.post("/me/agent/summary", async (request, reply) => {
    const parsed = summarySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Ticketnummer fehlt" });
    return withSession(request, reply, async (session) => {
      configured();
      const { context } = await loadTicket(session, parsed.data.ticketId);
      return { text: await ask(summaryPrompt(context), { maxTokens: 500 }) };
    });
  });

  app.post("/me/agent/draft", async (request, reply) => {
    const parsed = draftSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Entwurf: Angaben unvollständig" });
    if (parsed.data.intent === "custom" && !parsed.data.instruction) {
      return reply.code(400).send({ error: "Anweisung fehlt" });
    }
    return withSession(request, reply, async (session) => {
      configured();
      const ids = parsed.data.ticketIds;
      const intent = parsed.data.intent as DraftIntent;
      let contexts: string[];
      let author = "";
      let focus = "";
      if (ids.length === 1) {
        const loaded = await loadTicket(session, ids[0]);
        contexts = [loaded.context];
        author = await myName(session);
        if (intent === "reply") {
          const mail = loaded.thread.find((e) => e.key === parsed.data.mailKey && e.kind === "Mail eingehend");
          if (!mail) return reply.code(400).send({ error: "Die Mail wurde im Verlauf nicht gefunden" });
          focus = `Von ${mail.author}, Betreff „${mail.title}":\n${stripMailNoise(mail.text)}`;
        }
      } else {
        if (intent === "support" || intent === "reply") return reply.code(400).send({ error: "Nur für ein einzelnes Ticket" });
        // Many tickets: titles only — the text must fit all of them anyway.
        const tickets = await mapPool(ids, 4, (id) => tanss.ticketById(session, id).catch(() => null));
        contexts = tickets
          .filter((t): t is NonNullable<typeof t> => t !== null)
          .map((t) => {
            const row = toTicketRow(t.item, t.linked, []);
            return `Ticket #${row.id}: ${row.title} (Kunde: ${row.companyName || "—"}, Status: ${row.statusName || "—"})`;
          });
        if (contexts.length === 0) throw new LlmError("Keines der Tickets war lesbar", 502);
        author = await myName(session);
      }
      // Only a booking text follows the personal style; a mail draft is a
      // different genre and keeps its own rules.
      const style = intent === "support" ? store.style(session.employeeId) : null;
      const prompt = draftPrompt(intent, parsed.data.instruction, parsed.data.internal, contexts, author, focus, style);
      return { text: await ask(prompt, { maxTokens: 700 }) };
    });
  });

  /** The next step of a ticket, with a status suggestion the person may apply. */
  app.post("/me/agent/next", async (request, reply) => {
    const parsed = ticketSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Ticketnummer fehlt" });
    return withSession(request, reply, async (session) => {
      configured();
      const [loaded, states] = await Promise.all([
        loadTicket(session, parsed.data.ticketId),
        tanss.ticketStates(session).catch(() => [] as Record<string, unknown>[]),
      ]);
      const names = states.filter((s) => s.active !== false).map((s) => String(s.name ?? "")).filter(Boolean);
      const answer = extractJson(await ask(nextStepPrompt(loaded.context, names), { json: true, maxTokens: 300 }));
      const step = parseNextStep(answer, names);
      if (!step.text) throw new LlmError("Das Modell hat keinen Schritt benannt");
      const state = states.find((s) => String(s.name) === step.statusName);
      return {
        ...step,
        statusId: state ? Number(state.id) : null,
        currentStatus: loaded.row.statusName,
        unchanged: step.statusName !== null && step.statusName === loaded.row.statusName,
      };
    });
  });

  /**
   * Does the customer on the ticket match the one its text names? Read-only:
   * it proposes, the change happens only when a person clicks it.
   */
  app.post("/me/agent/company", async (request, reply) => {
    const parsed = ticketSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Ticketnummer fehlt" });
    return withSession(request, reply, async (session) => {
      configured();
      const loaded = await loadTicket(session, parsed.data.ticketId);
      const current = loaded.row.companyName;
      const named = parseMentionedCompany(
        extractJson(await ask(mentionedCompanyPrompt(companyCheckSource(loaded.row, loaded.thread)), { json: true, maxTokens: 300 })),
      );
      const base: CompanyCheck = {
        mentioned: named.name,
        evidence: named.evidence,
        currentCompanyName: current,
        suggestion: null,
        candidates: [],
        verdict: "none-named",
      };
      if (!named.name) return base;
      // Whether the two names mean the same company is a comparison, not a judgement call.
      if (sameCompany(named.name, current)) return { ...base, verdict: "matches" };

      const hits = await tanss
        .search(session, named.name)
        .then((r) => r.companies)
        .catch(() => [] as Record<string, unknown>[]);
      const candidates = hits
        .filter((c) => c.inactive !== true && Number(c.id ?? 0) > 0)
        .map(toCandidate)
        .filter((c) => c.id !== loaded.row.companyId)
        .slice(0, COMPANY_MAX_CANDIDATES);
      if (candidates.length === 0) return { ...base, verdict: "not-found" };

      // One candidate that spells out the named company needs no model.
      const exact = candidates.filter((c) => sameCompany(c.name, named.name));
      if (exact.length === 1) {
        const pick = exact[0];
        return {
          ...base,
          candidates,
          verdict: "differs",
          suggestion: { companyId: pick.id, name: pick.name, reason: "Name stimmt überein" },
        };
      }
      const chosen = parseCompanyPick(
        extractJson(await ask(companyPickPrompt(named.name, named.evidence, candidates), { json: true, maxTokens: 300 })),
        new Set(candidates.map((c) => c.id)),
      );
      const match = candidates.find((c) => c.id === chosen.companyId);
      return {
        ...base,
        candidates,
        verdict: "differs",
        suggestion: match ? { companyId: match.id, name: match.name, reason: chosen.reason } : null,
      };
    });
  });

  /** Tickets that look like the same problem: board rows plus a TANSS search on the title. */
  app.post("/me/agent/similar", async (request, reply) => {
    const parsed = similarSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Ticketnummer fehlt" });
    return withSession(request, reply, async (session) => {
      configured();
      const id = parsed.data.ticketId;
      const loaded = await loadTicket(session, id);
      const query = searchTerms(loaded.row.title);
      const hits = query
        ? await tanss.search(session, query).then((r) => r.tickets.map((t) => toTicketRow(t, r.linked, []))).catch(() => [] as TicketRow[])
        : [];
      const seen = new Set<number>([id]);
      const candidates: TicketRow[] = [];
      for (const r of [...hits, ...(parsed.data.rows as TicketRow[])]) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        candidates.push(r);
      }
      const pool = candidates.slice(0, SIMILAR_MAX_CANDIDATES);
      if (pool.length === 0) return { similar: [], checked: 0, searched: query, searchHits: hits.length };
      const answer = extractJson(await ask(similarPrompt(loaded.row, loaded.description, pool), { json: true, maxTokens: 600 }));
      const similar = parseSimilar(answer, new Set(pool.map((r) => r.id))).map((hit) => {
        const row = pool.find((r) => r.id === hit.ticketId)!;
        return { ...hit, title: row.title, companyName: row.companyName, statusName: row.statusName };
      });
      return { similar, checked: pool.length, searched: query, searchHits: hits.length };
    });
  });

  /**
   * How the same problem was solved before: done tickets of the customer,
   * pre-selected by shared words, picked by the model, read in full, and
   * turned into a proposal. Nothing is written anywhere.
   */
  app.post("/me/agent/solution", async (request, reply) => {
    const parsed = ticketSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Ticketnummer fehlt" });
    return withSession(request, reply, async (session): Promise<SolutionAnswer> => {
      configured();
      const id = parsed.data.ticketId;
      const subject = await loadTicket(session, id, SOLUTION_SUBJECT_SHARE);
      const empty = (
        verdict: Exclude<SolutionAnswer["verdict"], "ok">,
        counts: { checked: number; truncated: boolean } = { checked: 0, truncated: false },
      ): SolutionAnswer => ({ verdict, text: SOLUTION_MESSAGES[verdict], sources: [], read: 0, ...counts });
      if (!subject.row.companyId) return empty("no-company");

      let list: DoneTickets;
      try {
        list = await doneTickets.get(session, subject.row.companyId);
      } catch (error) {
        // A 401 stays as it is so the session can heal.
        if (error instanceof TanssError && error.status !== 401) {
          throw new TanssError(`Erledigte Tickets konnten nicht geladen werden: ${error.message}`, error.status);
        }
        throw error;
      }
      // The list is shared with the cache: filter() copies, nothing sorts in place.
      const done = list.done.filter((t) => Number(t.id) !== id);
      const counts = { checked: done.length, truncated: list.truncated };
      if (done.length === 0) return empty("no-done", counts);

      const candidates = rankCandidates({ title: subject.row.title, description: subject.description }, done);
      if (candidates.length === 0) return empty("no-match", counts);
      const picked = parseSolutionPick(
        extractJson(await ask(solutionPickPrompt(subject.row, subject.description, candidates), { json: true, maxTokens: 600 })),
        new Set(candidates.map((c) => c.id)),
      );
      if (picked.length === 0) return empty("no-match", counts);

      // Subject and sources together stay within one thread budget; each
      // source's internal note is part of that source's share.
      const sourceShare = (1 - SOLUTION_SUBJECT_SHARE) / picked.length;
      const sourceChars = Math.floor(threadBudget(settings().contextTokens) * sourceShare);
      const noteChars = Math.min(SOLUTION_NOTE_CHARS, Math.floor(sourceChars / 4));
      const settled = await Promise.allSettled(picked.map((hit) => loadTicket(session, hit.ticketId, sourceShare)));
      // An expired session is not "unreadable": let withSession heal it.
      const expired = settled.find(
        (r): r is PromiseRejectedResult => r.status === "rejected" && r.reason instanceof TanssError && r.reason.status === 401,
      );
      if (expired) throw expired.reason;
      const sources: SolutionSource[] = [];
      const read: { ticketId: number; context: string; internalNote: string }[] = [];
      settled.forEach((result, i) => {
        if (result.status !== "fulfilled") return;
        const hit = picked[i];
        const candidate = candidates.find((c) => c.id === hit.ticketId)!;
        const internalNote = plainText(result.value.internalNote).slice(0, noteChars);
        sources.push({ ticketId: hit.ticketId, title: candidate.title, modified: candidate.modified, reason: hit.reason });
        read.push({
          ticketId: hit.ticketId,
          context: ticketContext(result.value.row, result.value.thread, sourceChars - internalNote.length),
          internalNote,
        });
      });
      if (read.length === 0) return empty("unreadable", counts);

      const text = await ask(solutionPrompt(subject.context, read), { maxTokens: 900 });
      return { verdict: "ok", text, sources, read: read.length, ...counts };
    });
  });

  /** One mail of the thread, reduced to what it actually says. */
  app.post("/me/agent/clean-mail", async (request, reply) => {
    const parsed = mailSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Mail fehlt" });
    return withSession(request, reply, async (session) => {
      configured();
      const loaded = await loadTicket(session, parsed.data.ticketId);
      const mail = loaded.thread.find((e) => e.key === parsed.data.mailKey && e.kind.startsWith("Mail"));
      if (!mail) return reply.code(404).send({ error: "Die Mail wurde im Verlauf nicht gefunden" });
      const stripped = stripMailNoise(mail.text);
      const text = await ask(cleanMailPrompt(mail.title, stripped), { maxTokens: 300 });
      return { text, strippedChars: mail.text.length - stripped.length };
    });
  });

  app.post("/me/agent/briefing", async (request, reply) => {
    const parsed = briefingSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Ticketliste fehlt" });
    return withSession(request, reply, async (session) => {
      const nowSeconds = Math.floor(now() / 1000);
      const today = berlinYmd(nowSeconds);
      const since = shiftYmd(today, -ACTIVITY_LOOKBACK_DAYS);
      const mine = parsed.data.scope === "mine";
      const key = `${session.employeeId}:${parsed.data.scope}`;
      const cached = briefings.get(key);
      if (cached && cached.day === today && !parsed.data.force) {
        return { text: cached.text, facts: cached.facts, createdAt: cached.at, cached: true };
      }
      configured();
      const all = parsed.data.rows as TicketRow[];
      // "Mine" is defined here, not by whatever the client sent.
      const rows = mine ? all.filter((r) => r.assigneeId === session.employeeId) : all;
      const activity = parsed.data.activity as Record<number, Activity>;
      const facts = briefingFacts(rows, activity, session.employeeId, today, since, nowSeconds);
      const scope: BriefingScope = mine ? { kind: "mine" } : { kind: "list", label: parsed.data.label || parsed.data.scope };
      const text = await ask(briefingPrompt(facts, rows, activity, today, since, nowSeconds, scope), { maxTokens: 500 });
      const entry = { day: today, facts, text, at: now() };
      briefings.set(key, entry);
      return { text, facts, createdAt: entry.at, cached: false };
    });
  });

  app.post("/me/agent/patterns", async (request, reply) => {
    const parsed = rowsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Ticketliste fehlt" });
    return withSession(request, reply, async () => {
      configured();
      const nowSeconds = Math.floor(now() / 1000);
      const today = berlinYmd(nowSeconds);
      const since = shiftYmd(today, -ACTIVITY_LOOKBACK_DAYS);
      const rows = (parsed.data.rows as TicketRow[]).slice(0, PATTERN_MAX_ROWS);
      if (rows.length < 2) return { groups: [] as PatternGroup[], checked: rows.length, truncated: false };
      const answer = await ask(patternsPrompt(rows, parsed.data.activity as Record<number, Activity>, today, since, nowSeconds), { json: true, maxTokens: 900 });
      const groups = parsePatterns(extractJson(answer), new Set(rows.map((r) => r.id)));
      return { groups, checked: rows.length, truncated: parsed.data.rows.length > rows.length };
    });
  });

  /**
   * One chat turn, stateless: the board, today's bookings and the histories of
   * the tickets the question names go in as context. The model answers; it
   * cannot act.
   */
  /**
   * The activity text for one imported issue, in the user's own style. The
   * raw notes stay untouched until this is asked for — an unasked call to a
   * model is noise.
   */
  app.post("/me/agent/import-text", async (request, reply) => {
    const parsed = issueTextSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Issue-Angaben unvollständig" });
    return withSession(request, reply, async (session) => {
      configured();
      const text = await ask(issueTextPrompt(parsed.data, store.style(session.employeeId)), { maxTokens: 600 });
      return { text: text.trim() };
    });
  });

  /**
   * The day assistant: one call over everything that could explain the day —
   * bookings, unbooked appointments and calls, gaps, routines and what recurs
   * on this weekday. It suggests; it never books.
   */
  app.post("/me/agent/assistant", async (request, reply) => {
    const parsed = assistantSchema.safeParse(request.body);
    if (!parsed.success || (parsed.data.focus && parsed.data.focus.end <= parsed.data.focus.start)) {
      return reply.code(400).send({ error: "Tag oder Lücke ungültig" });
    }
    const { day, focus } = parsed.data;
    return withSession(request, reply, async (session) => {
      configured();
      const range = berlinDayRangeUnix(day);
      const historyFrom = berlinDayRangeUnix(shiftYmd(day, -PATTERN_DAYS)).from;
      const [dayList, history, calls] = await Promise.all([
        tanss
          .listSupports(session, range.from, range.to, ["SUPPORT", ...APPOINTMENT_PLANNING_TYPES])
          .catch(() => tanss.listSupports(session, range.from, range.to)),
        // Patterns need the weeks before, and only real bookings count.
        tanss.listSupports(session, historyFrom, range.from - 1).catch(() => ({ items: [], linked: {} })),
        tanss.listPhoneCalls(session, range.from, range.to).catch(() => [] as Record<string, unknown>[]),
      ]);
      const booked = dayList.items
        .filter((s) => !isAppointment(s.planningType))
        .map((s) => toSupport(s, dayList.linked));
      const raw: BookingTemplate[] = [
        ...dayList.items.filter((s) => isAppointment(s.planningType)).map((s) => appointmentToTemplate(s, dayList.linked)),
        ...calls.map((c) => callToTemplate(c)).filter((t): t is BookingTemplate => t !== null),
      ];
      const templates = openTemplates(raw, store.templateBookings(session.employeeId), day);
      // Linear is optional; without a key the block simply says "keine".
      const alreadyImported = store.importBookings(session.employeeId);
      const linearActivity = deps.linear
        ? await deps.linear
            .dayActivity(day)
            .then((r) =>
              buildSuggestions(r.activities, store.importRules(session.employeeId))
                .filter((s) => !alreadyImported[importKey(s.issue, day)])
                .map((s) => ({
                  issue: s.issue,
                  title: s.title,
                  minutes: s.minutes,
                  notes: s.text.replace(/\s+/g, " ").slice(0, 400),
                })),
            )
            .catch(() => [])
        : [];
      const dayBookings = supportsOfDay(booked, day);
      const gaps = buildBlocks(dayBookings)
        .filter((b): b is { kind: "gap"; start: number; end: number } => b.kind === "gap")
        .map((g) => ({ start: g.start, end: g.end }));
      const bookedMinutes = sumMinutes(dayBookings);
      // Only routines that still fit; one longer than any gap is noise.
      const room = focus ? focus.end - focus.start : Math.max(0, 8 * 60 - bookedMinutes);
      const context: DayContext = {
        day,
        booked: dayBookings,
        templates,
        gaps: focus ? [focus] : gaps,
        routines: routinesForGap(store.routines(session.employeeId), room),
        linear: linearActivity,
        patterns: findPatterns(
          history.items.map((s) => toSupport(s, history.linked)),
          day,
        ),
        bookedMinutes,
        focus: focus ?? null,
      };
      const answer = await llm.chat(
        configured(),
        [
          { role: "system", content: `${ASSISTANT_RULES}\n\n${styleSection(store.style(session.employeeId))}` },
          { role: "user", content: assistantPrompt(context) },
        ],
        { json: true, maxTokens: 2000 },
      );
      const result = parseAssistant(extractJson(answer));
      return {
        ...result,
        context: {
          bookedMinutes,
          gaps: context.gaps.length,
          templates: templates.length,
          patterns: context.patterns.length,
          routines: context.routines.length,
        },
      };
    });
  });

  app.post("/me/agent/chat", async (request, reply) => {
    const parsed = chatSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Nachricht fehlt" });
    const turns = parsed.data.messages.slice(-CHAT_MAX_TURNS);
    const last = turns[turns.length - 1];
    if (last.role !== "user" || !last.content.trim()) return reply.code(400).send({ error: "Nachricht fehlt" });
    return withSession(request, reply, async (session) => {
      configured();
      const nowSeconds = Math.floor(now() / 1000);
      const today = berlinYmd(nowSeconds);
      const since = shiftYmd(today, -ACTIVITY_LOOKBACK_DAYS);
      const rows = parsed.data.rows as TicketRow[];
      // The open ticket is the most common reference; loading it saves a round.
      const openId = parsed.data.openTicketId;
      const range = berlinDayRangeUnix(today);
      const [open, supports, name] = await Promise.all([
        openId ? loadTicket(session, openId, 1 / 3).catch(() => null) : Promise.resolve(null),
        tanss.listSupports(session, range.from, range.to).catch(() => ({ items: [], linked: {} })),
        myName(session),
      ]);
      const context = chatContext({
        today,
        since,
        nowUnix: nowSeconds,
        employeeName: name,
        rows,
        activity: parsed.data.activity as Record<number, Activity>,
        tickets: open ? [open] : [],
        daySupports: supports.items.map((s) => toSupport(s, supports.linked)),
        openTicketId: openId,
      });
      // The open ticket is read without being asked; give it a step too, or the
      // source line in the sidebar silently omits a history the answer rests on.
      const openStep: ChatStep[] = open ? [{ tool: "ticket_lesen", arg: `#${open.row.id}`, result: open.context, ok: true }] : [];
      try {
        const result = await runChatLoop({
          session,
          context,
          turns,
          rows,
          today,
          preRead: open ? [open.row.id] : [],
          usedChars: open ? open.context.length : 0,
        });
        return { ...result, steps: [...openStep, ...result.steps] };
      } catch (error) {
        // Only a 400 on the very first request means this model cannot do tools — then the old way.
        if (!(error instanceof ToolsUnsupportedError)) throw error;
        const known = new Set(rows.map((r) => r.id));
        const ids = [...new Set(mentionedTicketIds(last.content, known))]
          .filter((id) => id !== openId)
          .slice(0, CHAT_MAX_TICKETS - (open ? 1 : 0));
        const extra = (
          await mapPool(ids, 3, (id) => loadTicket(session, id, 0.5 / Math.max(1, ids.length)).catch(() => null))
        ).filter((t): t is NonNullable<typeof t> => t !== null);
        const result = await legacyChat({ context, turns, extra });
        return {
          ...result,
          ticketsRead: [...(open ? [open.row.id] : []), ...result.ticketsRead],
          steps: [...openStep, ...result.steps],
        };
      }
    });
  });

  async function myName(session: TanssSession): Promise<string> {
    try {
      const list = await tanss.technicians(session);
      const me = list.find((t) => Number(t.id) === session.employeeId);
      return me ? String(me.name ?? `${me.firstName ?? ""} ${me.lastName ?? ""}`).trim() : "";
    } catch {
      return "";
    }
  }
}

/** A TANSS company as the customer check shows it: name, place, mail domain. */
function toCandidate(company: Record<string, unknown>): CompanyCandidate {
  const host = String(company.website ?? "") || String(company.email ?? "");
  return {
    id: Number(company.id ?? 0),
    name: String(company.name ?? "").trim(),
    city: String(company.city ?? "").trim(),
    domain: host.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/^[^@]*@/, "").split("/")[0].trim(),
  };
}
