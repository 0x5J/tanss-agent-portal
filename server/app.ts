import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { loginInputSchema } from "../shared/login.ts";
import {
  berlinDayRangeUnix,
  berlinMinuteOfDay,
  berlinUnixAtMinute,
  berlinWeekDays,
  berlinYmd,
  shiftYmd,
} from "../shared/days.ts";
import {
  ACTIVITY_LOOKBACK_DAYS,
  historyActivity,
  supportActivity,
  type Activity,
} from "../shared/activity.ts";
import { toTicketRow } from "../shared/tickets.ts";
import { buildThread } from "../shared/thread.ts";
import { LIST_IDS, parseSavedViews } from "../shared/filters.ts";
import { parseRoutines } from "../shared/routines.ts";
import { parseStyle } from "../shared/style.ts";
import {
  SAMPLE_INTERVAL_MINUTES,
  claimsFromDays,
  mergeClaimEntries,
  type CollectorHealth,
} from "../shared/dashboard.ts";
import { loadBoard } from "./board.ts";
import { formatClock, toSupport } from "../shared/timeline.ts";
import { lockReason, lockText } from "../shared/lock.ts";
import {
  APPOINTMENT_PLANNING_TYPES,
  appointmentToTemplate,
  callToTemplate,
  isAppointment,
  openTemplates,
  templateKey,
  type BookingTemplate,
} from "../shared/template.ts";
import { createCallLog, loggableBody, type CallLog } from "./log.ts";
import { readSession, requireEmployee, requireSession, type SessionData } from "./session.ts";
import { VERSION } from "./version.ts";
import { createSharedSession, type SharedSession } from "./shared-session.ts";
import { LinearError, type LinearClient } from "./linear.ts";
import { buildSuggestions, importKey, parseRules } from "../shared/import.ts";
import { MAX_RANGE_DAYS, rangeLength } from "../shared/analysis.ts";
import { parseMappings, parseTarget } from "../shared/mapping.ts";
import { TanssError, type TanssClient, type TanssSession } from "./tanss.ts";
import { generateTotp, secondsUntilNextCode, type TotpConfig } from "./totp.ts";
import { registerAgentRoutes } from "./agent.ts";
import { LlmError, createLlmClient, type LlmClient } from "./llm.ts";
import { createMemoryStore, type Store } from "./store.ts";

const require = createRequire(import.meta.url);

export type AppOptions = {
  sessionSecret: string;
  tanss: TanssClient;
  llm?: LlmClient;
  store?: Store;
  totp?: TotpConfig | null;
  /**
   * Fresh TANSS login from credentials in the environment. When set, a dead
   * token pair heals itself instead of throwing the user out.
   */
  relogin?: (() => Promise<TanssSession>) | null;
  /** True when the background poller records dashboard samples. */
  polling?: boolean;
  /** State of the collector and its automatic login, for the dashboard. */
  collectorHealth?: () => CollectorHealth;
  /** The one TANSS session; created from the store when not passed in. */
  shared?: SharedSession;
  /** Linear connection for the day import; absent means "not configured". */
  linear?: LinearClient;
  /** Called after a login seeded the session — the collector measures at once. */
  onLogin?: () => void;
  /** Called after an assignment changed here, so the dashboard sees it now. */
  onAssignment?: () => void;
  log?: CallLog;
  tanssTicketUrl?: string;
  enableRateLimit?: boolean;
  serveStatic?: boolean;
  uiOrigin?: string;
  now?: () => number;
};

/**
 * The ticket history is one request per ticket. These bound what a single
 * board load costs TANSS — and where the cap bites, the answer says so.
 */
const HISTORY_CONCURRENCY = 6;
const MAX_HISTORY_TICKETS = 200;

const LINK_TYPE_COMPANY = 2;
const LINK_TYPE_TICKET = 11;

const commentSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  internal: z.boolean(),
  /** Optional heading of the posting, e.g. "Mail-Entwurf: …". */
  title: z.string().trim().max(200).default(""),
});

const ticketPatchSchema = z
  .object({
    statusId: z.number().int().positive().optional(),
    assignedToEmployeeId: z.number().int().min(0).optional(),
    companyId: z.number().int().positive().optional(),
    /** Berlin day of the due date; an empty string clears it. */
    dueDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).optional(),
    /** Time of day for the due date — "due" means "by the end of business". */
    dueMinute: z.number().int().min(0).max(24 * 60 - 1).default(17 * 60),
  })
  .refine(
    (v) =>
      v.statusId !== undefined ||
      v.assignedToEmployeeId !== undefined ||
      v.companyId !== undefined ||
      v.dueDate !== undefined,
    { message: "Nichts zu ändern" },
  );

const bookingSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startMinute: z.number().int().min(0).max(24 * 60 - 1),
  duration: z.number().int().positive().max(24 * 60),
  ticketId: z.number().int().positive().optional(),
  companyId: z.number().int().positive().optional(),
  typeId: z.number().int().positive(),
  location: z.enum(["OFFICE", "CUSTOMER", "REMOTE"]),
  text: z.string().trim().min(1).max(20_000),
  /** Internal work — TANSS keeps it away from the customer's view. */
  internal: z.boolean().optional(),
  /** Minutes of the duration that are not charged, with a reason. */
  durationNotCharged: z.number().int().min(0).max(24 * 60).optional(),
  reasonNotChargedText: z.string().trim().max(500).optional(),
  /** The template this booking came from — it stops offering itself then. */
  fromTemplate: z.string().trim().max(60).optional(),
});

const importBookSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  items: z
    .array(
      z.object({
        issue: z.string().trim().min(1).max(60),
        startMinute: z.number().int().min(0).max(24 * 60 - 1),
        duration: z.number().int().positive().max(24 * 60),
        text: z.string().trim().min(1).max(20_000),
        ticketId: z.number().int().positive().optional(),
        companyId: z.number().int().positive().optional(),
        typeId: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(30),
});

const supportPatchSchema = bookingSchema.partial().extend({
  internal: z.boolean().optional(),
  durationNotCharged: z.number().int().min(0).max(24 * 60).optional(),
  reasonNotChargedText: z.string().trim().max(500).optional(),
});

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const secret = opts.sessionSecret;
  const tanss = opts.tanss;
  const totp = opts.totp ?? null;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? createCallLog();
  const ticketUrl = opts.tanssTicketUrl ?? "";
  const store = opts.store ?? createMemoryStore();
  const shared = opts.shared ?? createSharedSession({ store, now });

  if (opts.enableRateLimit !== false) {
    await app.register(rateLimit, { global: false, max: 5, timeWindow: "1 minute" });
  }

  app.addHook("onResponse", async (request, reply) => {
    if (request.url.startsWith("/me/log") || request.url === "/health") return;
    if (!request.url.startsWith("/me") && !request.url.startsWith("/auth")) return;
    log.add({
      kind: "request",
      method: request.method,
      path: request.url,
      status: reply.statusCode,
      ok: reply.statusCode < 400,
      durationMs: Math.round(reply.elapsedTime),
      message: "",
      body: "",
      url: "",
      redirected: false,
      response: "",
      traceId: "",
    });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({ error: `Die lokale API kennt ${request.method} ${request.url} nicht` });
  });

  app.setErrorHandler((raw, _request, reply) => {
    const error: unknown = raw;
    if (error instanceof TanssError || error instanceof LlmError || error instanceof LinearError) {
      return reply.code(error.status).send({ error: error.message });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    const detail = error instanceof Error ? error.message : "";
    const message = status >= 500 ? "Interner Fehler" : detail || "Anfrage ungültig";
    if (status >= 500) console.error(error);
    return reply.code(status).send({ error: message });
  });

  /**
   * Runs a TANSS call with the one session this server holds. The cookie only
   * says who you are; the tokens live in the store, so the browser and the
   * dashboard collector share a single refresh chain instead of rotating each
   * other's tokens away.
   */
  async function withSession<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    work: (session: TanssSession) => Promise<T>,
  ): Promise<T> {
    const cookie = await readSession(request, reply, secret);
    const employeeId = current(cookie);
    // A cookie from before the shared session still carries a token pair;
    // hand it over once, then it lives server-side like everyone else's.
    if (!shared.state(Math.floor(now() / 1000)).present && cookie.apiKey && cookie.refresh) {
      shared.adopt(requireSession(cookie), Math.floor(now() / 1000));
    }
    const state = shared.state(Math.floor(now() / 1000));
    if (state.present && state.employeeId !== employeeId) {
      // The stored session belongs to somebody else — never act as them.
      throw new TanssError("Diese Sitzung gehört zu einem anderen Konto, bitte neu anmelden", 401);
    }
    try {
      return await shared.run(work);
    } catch (error) {
      // Without a healable session the caller has to log in again; say so.
      if (error instanceof TanssError && error.status === 401 && !opts.relogin) throw error;
      if (!opts.relogin || !(error instanceof TanssError) || error.status !== 401) throw error;
      const fresh = await opts.relogin();
      if (fresh.employeeId && fresh.employeeId !== employeeId) throw error;
      shared.adopt(fresh, Math.floor(now() / 1000));
      return shared.run(work);
    }
  }

  /**
   * The employee a cookie names, as long as it was issued after their last
   * logout. The cookie is sealed but stateless, so the generation in the
   * store is what lets a logout revoke copies of it too. A cookie from before
   * generations existed counts as generation 0.
   */
  function current(cookie: SessionData): number {
    const employeeId = requireEmployee(cookie);
    if ((cookie.generation ?? 0) !== store.sessionGeneration(employeeId)) {
      throw new TanssError("Nicht angemeldet", 401);
    }
    return employeeId;
  }

  async function employee(request: FastifyRequest, reply: FastifyReply): Promise<number> {
    return current(await readSession(request, reply, secret));
  }

  // --- auth ------------------------------------------------------------------

  app.get("/health", async () => ({ ok: true, version: VERSION }));

  app.get("/auth/config", async () => ({
    tokenRequired: totp === null,
    ticketUrl,
    /** Whether the day import has a Linear connection at all. */
    linear: opts.linear !== undefined,
  }));

  app.get("/auth/me", async (request, reply) => {
    const cookie = await readSession(request, reply, secret);
    if (!cookie.employeeId || (cookie.generation ?? 0) !== store.sessionGeneration(cookie.employeeId)) {
      return reply.code(401).send({ error: "Nicht angemeldet" });
    }
    const state = shared.state(Math.floor(now() / 1000));
    // The cookie alone is not a session: without stored tokens (or an old
    // cookie that still carries them) there is nothing to talk to TANSS with.
    if (!state.present && !cookie.apiKey) {
      return reply.code(401).send({ error: "Nicht angemeldet" });
    }
    return { employeeId: cookie.employeeId };
  });

  app.post(
    "/auth/login",
    {
      config: opts.enableRateLimit === false ? {} : { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsed = loginInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Benutzername, Passwort und 2FA-Token sind erforderlich" });
      }
      const token = parsed.data.token ?? (totp ? generateTotp(totp, now()) : "");
      if (!token) {
        return reply.code(400).send({ error: "2FA-Token fehlt" });
      }
      let tokens: TanssSession;
      try {
        tokens = await tanss.login({ ...parsed.data, token });
      } catch (error) {
        if (
          totp &&
          !parsed.data.token &&
          error instanceof TanssError &&
          (error.status === 401 || error.status === 403)
        ) {
          const wait = secondsUntilNextCode(totp, now());
          throw new TanssError(
            `${error.message} (Code wurde automatisch erzeugt; nächster Code in ${wait} s)`,
            error.status,
          );
        }
        throw error;
      }
      // The tokens go to the server, the cookie only carries the identity.
      // This login is also what seeds the collector's session.
      shared.adopt(tokens, Math.floor(now() / 1000));
      // Measure right away instead of showing "nicht gemessen" for five minutes.
      opts.onLogin?.();
      const session = await readSession(request, reply, secret);
      session.employeeId = tokens.employeeId;
      session.generation = store.sessionGeneration(tokens.employeeId);
      session.apiKey = undefined;
      session.refresh = undefined;
      session.expire = undefined;
      await session.save();
      return { employeeId: tokens.employeeId };
    },
  );

  /**
   * Logging out ends every browser's cookie for this employee, including
   * copies of it. The stored TANSS session stays, so the dashboard collector
   * keeps measuring — "Sammler stoppen" in the settings is what ends that one.
   */
  app.post("/auth/logout", async (request, reply) => {
    const session = await readSession(request, reply, secret);
    // Only a cookie that still counts may log everyone out; a revoked one just goes.
    const valid = session.employeeId && (session.generation ?? 0) === store.sessionGeneration(session.employeeId);
    if (valid) store.bumpSessionGeneration(session.employeeId!);
    session.destroy();
    return { ok: true };
  });

  app.get("/me/session", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const state = shared.state(Math.floor(now() / 1000));
    return {
      present: state.present && state.employeeId === employeeId,
      expire: state.expire,
      updatedAt: state.updatedAt,
      deadline: state.deadline,
    };
  });

  app.delete("/me/session", async (request, reply) => {
    await employee(request, reply);
    shared.clear();
    return { ok: true };
  });

  // --- tickets ---------------------------------------------------------------

  /**
   * Every open ticket the lists can show, in one answer: own, unassigned and
   * the other technicians'. The tabs of the board are filter presets over
   * this, so clearing a filter really shows everything.
   */
  app.get("/me/tickets", async (request, reply) => {
    // With projects: the board has a tab for them. The poller asks without.
    return withSession(request, reply, (session) => loadBoard(tanss, session, true));
  });

  /**
   * Last trace per ticket: newest comment or support from each ticket's
   * history, with a windowed bulk support lookup as fallback where the history
   * could not be read. Loaded after the table so the rows appear at once.
   */
  app.get("/me/tickets/activity", async (request, reply) => {
    const raw = String((request.query as { ids?: string }).ids ?? "");
    const ids = [...new Set(raw.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (ids.length === 0) return reply.code(400).send({ error: "Keine Ticketnummern" });
    return withSession(request, reply, async (session) => {
      const today = berlinYmd(Math.floor(now() / 1000));
      const since = shiftYmd(today, -ACTIVITY_LOOKBACK_DAYS);
      const checked = ids.slice(0, MAX_HISTORY_TICKETS);
      const [histories, supports] = await Promise.all([
        mapPool(checked, HISTORY_CONCURRENCY, async (id) => {
          try {
            const history = await tanss.ticketHistory(session, id);
            return { id, activity: historyActivity(history.content) };
          } catch {
            return null;
          }
        }),
        tanss
          .ticketSupports(session, ids, berlinDayRangeUnix(since).from, berlinDayRangeUnix(today).to)
          .then((items) => ({ items, ok: true }))
          .catch(() => ({ items: [] as Record<string, unknown>[], ok: false })),
      ]);
      const latestSupport = supportActivity(supports.items);
      const activity: Record<number, Activity> = {};
      let historyRead = 0;
      for (const id of ids) {
        const read = histories.find((h) => h?.id === id);
        if (read) {
          historyRead++;
          activity[id] = read.activity;
          continue;
        }
        const support = latestSupport.get(id) ?? 0;
        activity[id] = { at: support, kind: support ? "support" : "none", historyRead: false };
      }
      return {
        activity,
        today,
        since,
        ticketCount: ids.length,
        historyChecked: checked.length,
        historyRead,
        supportsRead: supports.ok,
      };
    });
  });

  app.get("/me/tickets/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: "Ticketnummer ungültig" });
    }
    // The picker only needs the head of a ticket; pulling a whole thread to
    // build a label would cost a second call for nothing.
    const headOnly = String((request.query as { head?: string }).head ?? "") === "1";
    return withSession(request, reply, async (session) => {
      if (headOnly) {
        const only = await tanss.ticketById(session, id);
        return { ticket: toTicketRow(only.item, only.linked, []), thread: [], supports: [] };
      }
      const [ticket, history] = await Promise.all([
        tanss.ticketById(session, id),
        tanss.ticketHistory(session, id),
      ]);
      const linked = { ...history.linked, ...ticket.linked };
      const row = toTicketRow(ticket.item, linked, []);
      const thread = buildThread(ticket.item, history.content, linked, row.companyName);
      const supports = (
        Array.isArray(history.content.supports) ? history.content.supports : []
      )
        .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
        .map((s) => toSupport(s, linked));
      return { ticket: row, thread, supports };
    });
  });

  app.post("/me/tickets/:id/comments", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = commentSchema.safeParse(request.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.code(400).send({ error: "Kommentar unvollständig" });
    }
    return withSession(request, reply, async (session) => {
      const created = await tanss.createComment(session, id, {
        title: parsed.data.title,
        content: parsed.data.content,
        internal: parsed.data.internal,
      });
      return { ok: true, id: Number(created.id ?? 0) };
    });
  });

  /**
   * TANSS takes the whole ticket, not a patch: read it, change the field,
   * write it back.
   */
  app.patch("/me/tickets/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = ticketPatchSchema.safeParse(request.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.code(400).send({ error: "Änderung ungültig" });
    }
    // The Berlin timestamp is settled before a single TANSS call goes out —
    // a day that has no such time is a bad request, not a failed write.
    let due: number | null = null;
    if (parsed.data.dueDate !== undefined) {
      if (parsed.data.dueDate === "") due = 0;
      else {
        try {
          due = berlinUnixAtMinute(parsed.data.dueDate, parsed.data.dueMinute);
        } catch {
          return reply.code(400).send({ error: "Diese Uhrzeit gibt es an diesem Tag nicht" });
        }
      }
    }
    return withSession(request, reply, async (session) => {
      const current = await tanss.ticketById(session, id);
      const next: Record<string, unknown> = { ...current.item };
      if (due !== null) next.dueDate = due;
      if (parsed.data.statusId !== undefined) next.statusId = parsed.data.statusId;
      if (parsed.data.assignedToEmployeeId !== undefined) {
        next.assignedToEmployeeId = parsed.data.assignedToEmployeeId;
      }
      // The contact belongs to the old company; TANSS may refuse the write for
      // that, and then the message goes back to the person unchanged.
      if (parsed.data.companyId !== undefined) next.companyId = parsed.data.companyId;
      const saved = await tanss.updateTicket(session, id, next);
      // Taking a ticket should show up in "Übernommen" right away instead of
      // waiting for the next five-minute tick.
      if (parsed.data.assignedToEmployeeId !== undefined) opts.onAssignment?.();
      return { ticket: toTicketRow({ ...next, ...saved }, current.linked, []) };
    });
  });

  app.get("/me/meta", async (request, reply) => {
    return withSession(request, reply, async (session) => {
      const [states, technicians, types] = await Promise.all([
        tanss.ticketStates(session).catch(() => []),
        tanss.technicians(session).catch(() => []),
        tanss.supportTypes(session),
      ]);
      return {
        employeeId: session.employeeId,
        states: states
          .filter((s) => s.active !== false)
          .map((s) => ({
            id: Number(s.id),
            name: String(s.name ?? ""),
            waiting: Boolean(s.waitState),
            rank: Number(s.rank ?? 0),
          }))
          .sort((a, b) => a.rank - b.rank),
        technicians: technicians
          .map((t) => ({
            id: Number(t.id),
            name: String(t.name ?? `${t.lastName ?? ""}, ${t.firstName ?? ""}`).trim(),
          }))
          .filter((t) => t.id > 0)
          .sort((a, b) => a.name.localeCompare(b.name, "de")),
        supportTypes: types
          .map((t) => ({ id: Number(t.id), name: String(t.name ?? "") }))
          .filter((t) => t.id > 0),
      };
    });
  });

  app.get("/me/search", async (request, reply) => {
    const query = String((request.query as { q?: string }).q ?? "").trim();
    if (query.length < 2) return { tickets: [], companies: [] };
    return withSession(request, reply, async (session) => {
      const result = await tanss.search(session, query);
      return {
        tickets: result.tickets.map((t) => toTicketRow(t, result.linked, [])),
        companies: result.companies.map((c) => ({
          id: Number(c.id ?? 0),
          name: String(c.name ?? ""),
        })),
      };
    });
  });

  // --- supports --------------------------------------------------------------

  /**
   * The assignment fields of a booking. TANSS checks the assignment against
   * the company of the booking and answers "Die angegebene Zuweisung existiert
   * nicht innerhalb der Firma" when it is missing — so the company travels
   * with it, read from the ticket rather than taken from the browser, which
   * may hold an older row.
   */
  async function assignmentFor(
    session: TanssSession,
    ticketId: number | undefined,
    companyId: number | undefined,
  ): Promise<{ ticketId: number; companyId: number; linkTypeId: number; linkId: number }> {
    if (!ticketId) {
      const company = companyId ?? 0;
      return { ticketId: 0, companyId: company, linkTypeId: LINK_TYPE_COMPANY, linkId: company };
    }
    const ticket = await tanss.ticketById(session, ticketId);
    return {
      ticketId,
      companyId: Number(ticket.item.companyId ?? 0) || companyId || 0,
      linkTypeId: LINK_TYPE_TICKET,
      linkId: ticketId,
    };
  }

  app.get("/me/supports", async (request, reply) => {
    const day = String((request.query as { day?: string }).day ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return reply.code(400).send({ error: "Tag fehlt (YYYY-MM-DD)" });
    }
    return withSession(request, reply, async (session) => {
      const week = berlinWeekDays(day);
      const from = berlinDayRangeUnix(week[0]).from;
      const to = berlinDayRangeUnix(week[6]).to;
      const range = berlinDayRangeUnix(day);
      // One call brings bookings and calendar entries; they must stay apart,
      // an appointment is a plan and counts in no sum.
      const [result, calls] = await Promise.all([
        // Not every installation has the calendar types; the day itself must
        // not fall over because of a template that could not be fetched.
        tanss
          .listSupports(session, from, to, ["SUPPORT", ...APPOINTMENT_PLANNING_TYPES])
          .catch(() => tanss.listSupports(session, from, to)),
        tanss.listPhoneCalls(session, range.from, range.to).catch(() => [] as Record<string, unknown>[]),
      ]);
      const supports = result.items
        .filter((s) => !isAppointment(s.planningType))
        .map((s) => toSupport(s, result.linked));
      const raw: BookingTemplate[] = [
        ...result.items.filter((s) => isAppointment(s.planningType)).map((s) => appointmentToTemplate(s, result.linked)),
        ...calls.map((c) => callToTemplate(c)).filter((t): t is BookingTemplate => t !== null),
      ];
      const templates = openTemplates(raw, store.templateBookings(session.employeeId), day);
      return { week, supports, templates };
    });
  });

  /**
   * The bookings of one employee over a free range — the basis of the
   * analysis view. Read-only by construction: one `listSupports` and nothing
   * else. Without `planningTypes` the call brings only SUPPORT, so
   * appointments and calls never enter a sum here.
   *
   * `employeeId` defaults to the session's own. Naming someone else grants
   * nothing: the portal only forwards the id, TANSS decides what it returns.
   */
  app.get("/me/supports/range", async (request, reply) => {
    const query = request.query as { from?: string; to?: string; employeeId?: string };
    const from = String(query.from ?? "");
    const to = String(query.to ?? "");
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    if (!ymd.test(from) || !ymd.test(to) || from > to) {
      return reply.code(400).send({ error: "Zeitraum ungültig" });
    }
    const range = { from, to };
    let days: number;
    let fromUnix: number;
    let toUnix: number;
    try {
      days = rangeLength(range);
      fromUnix = berlinDayRangeUnix(from).from;
      toUnix = berlinDayRangeUnix(to).to;
    } catch {
      // The pattern above only checks the shape. "2026-02-30" passes it and
      // yet has no instant behind it — a broken range, not a server fault,
      // and TANSS never needs to hear about it.
      return reply.code(400).send({ error: "Zeitraum ungültig" });
    }
    if (days > MAX_RANGE_DAYS) {
      return reply.code(400).send({ error: "Zeitraum zu lang (höchstens ein Jahr)" });
    }
    const asked = query.employeeId;
    if (asked !== undefined && !/^[1-9]\d*$/.test(String(asked))) {
      return reply.code(400).send({ error: "Mitarbeiter ungültig" });
    }
    return withSession(request, reply, async (session) => {
      const employeeId = asked === undefined ? session.employeeId : Number(asked);
      const result = await tanss.listSupports(session, fromUnix, toUnix, undefined, employeeId);
      const supports = result.items
        .map((s) => toSupport(s, result.linked))
        .sort((a, b) => a.date - b.date);
      return { from, to, employeeId, supports };
    });
  });

  app.post("/me/supports", async (request, reply) => {
    const parsed = bookingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Buchung unvollständig" });
    }
    const input = parsed.data;
    if (!input.ticketId && !input.companyId) {
      return reply.code(400).send({ error: "Ticket oder Kunde ist erforderlich" });
    }
    if ((input.durationNotCharged ?? 0) > input.duration) {
      return reply.code(400).send({ error: "Nicht berechnete Zeit ist länger als die Leistung" });
    }
    let start: number;
    try {
      start = berlinUnixAtMinute(input.date, input.startMinute);
    } catch {
      return reply.code(400).send({ error: "Diese Uhrzeit gibt es an diesem Tag nicht" });
    }
    return withSession(request, reply, async (session) => {
      const payload: Record<string, unknown> = {
        date: start,
        duration: input.duration,
        typeId: input.typeId,
        location: input.location,
        text: input.text,
        planningType: "SUPPORT",
        ...(input.internal !== undefined ? { internal: input.internal } : {}),
        ...(input.durationNotCharged ? { durationNotCharged: input.durationNotCharged } : {}),
        ...(input.reasonNotChargedText ? { reasonNotChargedText: input.reasonNotChargedText } : {}),
        employeeId: session.employeeId,
      };
      // Without an assignment TANSS answers SUPPORT_MISSING_ASSIGNMENT.
      const link = await assignmentFor(session, input.ticketId, input.companyId);
      payload.linkTypeId = link.linkTypeId;
      payload.linkId = link.linkId;
      if (link.ticketId) payload.ticketId = link.ticketId;
      if (link.companyId) payload.companyId = link.companyId;
      const created = await tanss.createSupport(session, payload);
      const id = Number(created.id ?? 0);
      if (input.fromTemplate) {
        store.markTemplateBooked(session.employeeId, templateKey(input.fromTemplate, input.date), id);
      }
      return { ok: true, id };
    });
  });

  /**
   * One booking, with the reason it cannot be changed when there is one.
   * TANSS would accept a write to an invoiced booking and quietly break the
   * accounting, so the portal refuses first and says why.
   */
  app.get("/me/supports/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: "Leistungsnummer ungültig" });
    }
    return withSession(request, reply, async (session) => {
      const found = await tanss.supportById(session, id);
      const support = toSupport(found.item, found.linked);
      const reason = lockReason(support, session.employeeId);
      return { support, locked: reason !== null, lockReason: reason, lockText: lockText(reason) };
    });
  });

  app.put("/me/supports/:id", async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = supportPatchSchema.safeParse(request.body);
    if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
      return reply.code(400).send({ error: "Änderung ungültig" });
    }
    const input = parsed.data;
    return withSession(request, reply, async (session) => {
      const current = await tanss.supportById(session, id);
      const support = toSupport(current.item, current.linked);
      const reason = lockReason(support, session.employeeId);
      if (reason) {
        // 409, not 403: the booking exists and is readable, it just may not
        // move any more. The UI shows the sentence as it is.
        return reply.code(reason === "foreign" ? 403 : 409).send({ error: lockText(reason) });
      }
      if (input.ticketId && input.companyId) {
        return reply.code(400).send({ error: "Ticket oder Kunde, nicht beides" });
      }
      const next: Record<string, unknown> = { ...current.item };
      if (input.date !== undefined || input.startMinute !== undefined) {
        const day = input.date ?? berlinYmd(support.date);
        const minute = input.startMinute ?? berlinMinuteOfDay(support.date);
        try {
          next.date = berlinUnixAtMinute(day, minute);
        } catch {
          return reply.code(400).send({ error: "Diese Uhrzeit gibt es an diesem Tag nicht" });
        }
      }
      for (const key of ["duration", "typeId", "location", "text", "internal", "durationNotCharged", "reasonNotChargedText"] as const) {
        if (input[key] !== undefined) next[key] = input[key];
      }
      // Retargeting keeps the assignment consistent — TANSS rejects a support
      // without one, and a stale linkId would book onto the old target.
      if (input.ticketId !== undefined || input.companyId !== undefined) {
        const link = await assignmentFor(session, input.ticketId, input.companyId);
        next.ticketId = link.ticketId;
        next.companyId = link.companyId;
        next.linkTypeId = link.linkTypeId;
        next.linkId = link.linkId;
      }
      const saved = await tanss.updateSupport(session, id, next);
      const merged = toSupport({ ...next, ...saved }, current.linked);
      return { ok: true, support: merged };
    });
  });

  // --- saved lists & dashboard ----------------------------------------------

  app.get("/me/views", async (request, reply) => {
    const employeeId = await employee(request, reply);
    return { views: store.views(employeeId) };
  });

  app.put("/me/views", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const body = (request.body ?? {}) as { views?: unknown };
    // The tolerant parser is the schema: broken entries are dropped, and what
    // comes back is exactly what will be stored.
    const views = parseSavedViews(body.views, LIST_IDS);
    if (views.length > 50) return reply.code(400).send({ error: "Zu viele Listen" });
    store.setViews(employeeId, views);
    return { views };
  });

  // --- day import (Linear) ---------------------------------------------------

  function linearOrFail(): LinearClient {
    if (!opts.linear) {
      throw new LinearError("Keine Linear-Verbindung eingerichtet — LINEAR_API_KEY setzen", 503);
    }
    return opts.linear;
  }

  app.get("/me/import/states", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const rules = store.importRules(employeeId);
    if (!opts.linear) return { enabled: false, items: [], rules };
    const items = await linearOrFail().workflowStates();
    // First run: whatever Linear calls "started" is what counts as work.
    if (rules.states.length === 0) {
      const started = items.filter((s) => s.type === "started").map((s) => s.name);
      if (started.length) {
        const next = { ...rules, states: started };
        store.setImportRules(employeeId, next);
        return { enabled: true, items, rules: next };
      }
    }
    return { enabled: true, items, rules };
  });

  app.put("/me/import/rules", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const rules = parseRules((request.body as { rules?: unknown })?.rules);
    store.setImportRules(employeeId, rules);
    return { rules };
  });

  app.put("/me/import/mappings", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const body = (request.body ?? {}) as { key?: unknown; target?: unknown; mappings?: unknown };
    if (typeof body.key === "string" && body.key.trim()) {
      const target = parseTarget(body.target);
      if (target.ticketId === null && target.companyId === null) {
        return reply.code(400).send({ error: "Ohne Ticket oder Kunde lässt sich nichts merken" });
      }
      const next = { ...store.mappings(employeeId), [body.key.trim()]: target };
      store.setMappings(employeeId, parseMappings(next));
    } else {
      store.setMappings(employeeId, parseMappings(body.mappings));
    }
    return { mappings: store.mappings(employeeId) };
  });

  app.get("/me/import", async (request, reply) => {
    const day = String((request.query as { day?: string }).day ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return reply.code(400).send({ error: "Tag fehlt (YYYY-MM-DD)" });
    }
    const linear = linearOrFail();
    return withSession(request, reply, async (session) => {
      const range = berlinDayRangeUnix(day);
      const [activity, booked] = await Promise.all([
        linear.dayActivity(day),
        tanss.listSupports(session, range.from, range.to).catch(() => ({ items: [], linked: {} })),
      ]);
      const rules = store.importRules(session.employeeId);
      const mappings = store.mappings(session.employeeId);
      const alreadyBooked = store.importBookings(session.employeeId);
      const daySupports = booked.items.map((s) => toSupport(s, booked.linked));
      const suggestions = buildSuggestions(activity.activities, rules).map((suggestion) => {
        const clash = daySupports.find((s) => {
          const from = berlinMinuteOfDay(s.date);
          return from < suggestion.start + suggestion.minutes && from + s.duration > suggestion.start;
        });
        const flags = clash
          ? [
              ...suggestion.flags,
              {
                label: "überlappt",
                reason: `Der Zeitraum überschneidet sich mit einer bestehenden Buchung ${formatClock(berlinMinuteOfDay(clash.date))}–${formatClock(berlinMinuteOfDay(clash.date) + clash.duration)} (${clash.ticketId ? `#${clash.ticketId}` : clash.companyName}).`,
              },
            ]
          : suggestion.flags;
        return {
          ...suggestion,
          flags,
          mapping: mappings[suggestion.project] ?? null,
          bookedSupportId: alreadyBooked[importKey(suggestion.issue, day)] ?? null,
        };
      });
      return {
        day,
        issuesChecked: activity.issuesChecked,
        capped: activity.capped,
        rules,
        suggestions,
      };
    });
  });

  app.post("/me/import/book", async (request, reply) => {
    const parsed = importBookSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Buchungen unvollständig" });
    const { day, items } = parsed.data;
    return withSession(request, reply, async (session) => {
      const alreadyBooked = store.importBookings(session.employeeId);
      const results: { issue: string; id: number; error: string }[] = [];
      for (const item of items) {
        const key = importKey(item.issue, day);
        if (alreadyBooked[key]) {
          results.push({ issue: item.issue, id: alreadyBooked[key]!, error: "war bereits gebucht" });
          continue;
        }
        try {
          const link = await assignmentFor(session, item.ticketId, item.companyId);
          const created = await tanss.createSupport(session, {
            date: berlinUnixAtMinute(day, item.startMinute),
            duration: item.duration,
            typeId: item.typeId,
            location: "OFFICE",
            text: item.text,
            planningType: "SUPPORT",
            employeeId: session.employeeId,
            linkTypeId: link.linkTypeId,
            linkId: link.linkId,
            ...(link.ticketId ? { ticketId: link.ticketId } : {}),
            ...(link.companyId ? { companyId: link.companyId } : {}),
          });
          const id = Number(created.id ?? 0);
          store.markImportBooked(session.employeeId, key, id);
          results.push({ issue: item.issue, id, error: "" });
        } catch (error) {
          // One bad line must not stop the rest of the day.
          results.push({ issue: item.issue, id: 0, error: error instanceof Error ? error.message : "Fehler" });
        }
      }
      return { results, booked: results.filter((r) => r.id > 0 && !r.error).length };
    });
  });

  app.get("/me/style", async (request, reply) => {
    const employeeId = await employee(request, reply);
    return { style: store.style(employeeId) };
  });

  app.put("/me/style", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const style = parseStyle((request.body as { style?: unknown })?.style);
    store.setStyle(employeeId, style);
    return { style };
  });

  app.get("/me/reports", async (request, reply) => {
    const employeeId = await employee(request, reply);
    return { reports: store.reports(employeeId), lists: store.reportLists(employeeId) };
  });

  app.put("/me/reports/lists", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const raw = (request.body as { lists?: unknown })?.lists;
    const lists = (Array.isArray(raw) ? raw : [])
      .filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 60)
      .slice(0, 20);
    store.setReportLists(employeeId, lists);
    return { lists };
  });

  app.get("/me/reports/:name", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const html = store.report(employeeId, String((request.params as { name: string }).name));
    if (html === null) return reply.code(404).send({ error: "Bericht nicht gefunden" });
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/me/dashboard/claims", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const raw = String((request.query as { since?: string }).since ?? "");
    const since = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : shiftYmd(berlinYmd(Math.floor(now() / 1000)), -30);
    // Both sources: the running log, plus whatever the measurement file still
    // holds. Without the second one everything measured before the log
    // existed would silently disappear from the view.
    const entries = mergeClaimEntries(
      store.claimHistory(employeeId, since),
      claimsFromDays(store.dashboard(employeeId), since),
    );
    return { since, entries };
  });

  app.get("/me/routines", async (request, reply) => {
    const employeeId = await employee(request, reply);
    return { routines: store.routines(employeeId) };
  });

  app.put("/me/routines", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const body = (request.body ?? {}) as { routines?: unknown };
    // The tolerant reader is the schema: a reversed range gets corrected, an
    // entry without text is dropped, and what comes back is what was stored.
    const routines = parseRoutines(body.routines);
    store.setRoutines(employeeId, routines);
    return { routines };
  });

  app.get("/me/dashboard", async (request, reply) => {
    const employeeId = await employee(request, reply);
    return {
      days: store.dashboard(employeeId),
      polling: opts.polling === true,
      intervalMinutes: SAMPLE_INTERVAL_MINUTES,
      health: opts.collectorHealth?.() ?? null,
    };
  });

  // --- agent -----------------------------------------------------------------

  registerAgentRoutes(app, {
    tanss,
    llm: opts.llm ?? createLlmClient(),
    store,
    now,
    withSession,
    mapPool,
    ...(opts.linear ? { linear: opts.linear } : {}),
  });

  // --- log -------------------------------------------------------------------

  app.get("/me/log", async (request, reply) => {
    await employee(request, reply);
    const raw = Number((request.query as { since?: string }).since ?? 0);
    const since = Number.isFinite(raw) && raw >= 0 ? raw : 0;
    return { entries: log.since(since), lastId: log.lastId() };
  });

  app.delete("/me/log", async (request, reply) => {
    await employee(request, reply);
    log.clear();
    return { ok: true };
  });

  // --- static ----------------------------------------------------------------

  if (opts.serveStatic) {
    const fastifyStatic = require("@fastify/static");
    const here = path.dirname(fileURLToPath(import.meta.url));
    await app.register(fastifyStatic, { root: path.resolve(here, "../dist") });
  } else {
    const uiOrigin = opts.uiOrigin ?? "http://127.0.0.1:5173";
    app.get("/", async (_request, reply) => reply.redirect(`${uiOrigin}/`, 302));
  }

  return app;
}

export { loggableBody };

/** Runs `work` over every item with at most `limit` in flight. */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}
