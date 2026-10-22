import type { LoginInput } from "../shared/login.ts";

export type TanssSession = {
  employeeId: number;
  apiKey: string;
  refresh: string;
  expire: number;
};

export class TanssError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TanssError";
    this.status = status;
  }
}

/** One crossing of the TANSS boundary, for diagnostics. */
export type TanssCallLog = {
  method: string;
  path: string;
  status: number;
  ok: boolean;
  message: string;
  durationMs: number;
  body: unknown;
  traceId: string;
  url: string;
  redirected: boolean;
  responseBody: string;
};

export type LinkedEntities = Record<
  string,
  Record<string, Record<string, unknown>>
>;

export type Obj = Record<string, unknown>;

export type TicketListKind = "own" | "general" | "technician" | "projects";

/** Filter body of PUT /api/v1/tickets (the "custom ticket list"). */
export type CustomTicketFilter = {
  companies?: number[];
  includeDoneTickets?: boolean;
  /** Unix seconds. */
  modifiedWithinTimeframe?: { from: number; to: number };
  itemsPerPage: number;
  /** TANSS counts from 1. */
  page: number;
};

export type TanssClient = {
  login(input: LoginInput): Promise<TanssSession>;
  ticketList(
    session: TanssSession,
    kind: TicketListKind,
  ): Promise<{ items: Obj[]; linked: LinkedEntities; waitingStates: number[] }>;
  /**
   * One page of tickets matching a filter, newest modification first; used to
   * page through a customer's tickets, including done ones. `page` starts at 1.
   */
  customTicketList(
    session: TanssSession,
    filter: CustomTicketFilter,
  ): Promise<{ items: Obj[]; linked: LinkedEntities }>;
  ticketById(
    session: TanssSession,
    ticketId: number,
  ): Promise<{ item: Obj; linked: LinkedEntities }>;
  ticketHistory(
    session: TanssSession,
    ticketId: number,
  ): Promise<{ content: Obj; linked: LinkedEntities }>;
  updateTicket(session: TanssSession, ticketId: number, ticket: Obj): Promise<Obj>;
  createComment(
    session: TanssSession,
    ticketId: number,
    body: { title: string; content: string; internal: boolean },
  ): Promise<Obj>;
  ticketStates(session: TanssSession): Promise<Obj[]>;
  technicians(session: TanssSession): Promise<Obj[]>;
  supportTypes(session: TanssSession): Promise<Obj[]>;
  /**
   * The employee's supports within the timeframe (unix seconds). With
   * `planningTypes` the same call also brings the calendar entries, which the
   * caller has to keep apart from booked time. `employeeId` defaults to the
   * session's own; TANSS decides on its own whether it hands out another
   * employee's bookings.
   */
  listSupports(
    session: TanssSession,
    from: number,
    to: number,
    planningTypes?: readonly string[],
    employeeId?: number,
  ): Promise<{ items: Obj[]; linked: LinkedEntities }>;
  /** The employee's phone calls within the timeframe. */
  listPhoneCalls(session: TanssSession, from: number, to: number): Promise<Obj[]>;
  createSupport(session: TanssSession, body: Obj): Promise<Obj>;
  /** One booking with its linked entities — the basis for editing it. */
  supportById(
    session: TanssSession,
    supportId: number,
  ): Promise<{ item: Obj; linked: LinkedEntities }>;
  updateSupport(session: TanssSession, supportId: number, body: Obj): Promise<Obj>;
  /** Supports booked on the given tickets, by anyone, within the timeframe. */
  ticketSupports(
    session: TanssSession,
    ticketIds: number[],
    from: number,
    to: number,
  ): Promise<Obj[]>;
  search(
    session: TanssSession,
    query: string,
  ): Promise<{ tickets: Obj[]; companies: Obj[]; linked: LinkedEntities }>;
};

type TanssErrorBody = {
  text?: string;
  localizedText?: string;
  /** What the login route puts its reason in — e.g. LOGIN_ERROR_… */
  message?: string;
  traceId?: string;
};

type Envelope = {
  meta?: {
    text?: string;
    linkedEntities?: LinkedEntities;
    properties?: { extras?: { waitingStates?: unknown } };
  };
  content?: unknown;
  error?: TanssErrorBody | string;
};

/** A login may take a moment; hanging for a minute helps nobody. */
const LOGIN_TIMEOUT_MS = 30_000;

const LIST_PATHS: Record<TicketListKind, string> = {
  own: "/api/v1/tickets/own",
  general: "/api/v1/tickets/general",
  technician: "/api/v1/tickets/technician",
  projects: "/api/v1/tickets/projects",
};

export function buildSupportsListBody(
  employeeId: number,
  from: number,
  to: number,
  planningTypes: readonly string[] = ["SUPPORT"],
) {
  return {
    timeframe: { from, to },
    employees: [employeeId],
    planningTypes: [...planningTypes],
  };
}

export function buildPhoneCallsBody(employeeId: number, from: number, to: number) {
  return {
    timeframe: { from, to },
    employeeId,
    // A ringing phone is not work; those are filtered out anyway.
    showTrysAsWell: false,
  };
}

export function buildTicketSupportsBody(ticketIds: number[], from: number, to: number) {
  return {
    timeframe: { from, to },
    tickets: ticketIds,
    // Only real work counts as activity; an appointment is a plan, not a trace.
    planningTypes: ["SUPPORT"],
    includeSubTickets: false,
  };
}

export function createTanssClient(opts: {
  baseUrl: string;
  fetch?: typeof fetch;
  onCall?: (entry: TanssCallLog) => void;
  now?: () => number;
}): TanssClient {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const doFetch = opts.fetch ?? fetch;
  const onCall = opts.onCall;
  const now = opts.now ?? Date.now;

  async function login(input: LoginInput): Promise<TanssSession> {
    const path = "/api/v1/login";
    const startedAt = now();
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: input.username,
          password: input.password,
          token: input.token,
        }),
        // A login that hangs is worse than one that fails: it blocks the
        // request and hides the reason behind the proxy's own timeout.
        signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && /abort|timeout/i.test(error.name + error.message);
      const message = timedOut
        ? `TANSS hat auf die Anmeldung nicht geantwortet (${LOGIN_TIMEOUT_MS / 1000} s)`
        : `TANSS ist für die Anmeldung nicht erreichbar (${error instanceof Error ? error.message : "unbekannt"})`;
      onCall?.({
        method: "POST",
        path,
        status: 0,
        ok: false,
        message,
        durationMs: now() - startedAt,
        body: { redacted: true },
        traceId: "",
        url: `${baseUrl}${path}`,
        redirected: false,
        responseBody: "",
      });
      // 504, not 401/403: this says nothing about the credentials, so the
      // login gate must not treat it as a rejection.
      throw new TanssError(message, 504);
    }
    const { envelope, raw } = await readEnvelope(response);
    onCall?.({
      method: "POST",
      path,
      status: response.status,
      ok: response.ok,
      message: tanssErrorText(envelope.error) || (envelope.meta?.text ?? ""),
      durationMs: now() - startedAt,
      // Credentials never reach the log; loggableBody redacts this path too.
      body: { redacted: true },
      traceId: tanssTraceId(envelope),
      url: response.url,
      redirected: response.redirected,
      responseBody: response.ok ? "" : raw,
    });
    if (!response.ok) {
      throw new TanssError(errorMessage(envelope, response, "POST", path), response.status);
    }
    return parseSession(envelope);
  }

  async function authed(
    session: TanssSession,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Envelope> {
    if (isExpiring(session.expire)) {
      await refreshSession(session);
    }
    const first = await call(session.apiKey, method, path, body);
    if (first.response.status !== 401) {
      if (!first.response.ok) {
        throw new TanssError(
          errorMessage(first.envelope, first.response, method, path),
          first.response.status,
        );
      }
      return first.envelope;
    }
    await refreshSession(session);
    const retry = await call(session.apiKey, method, path, body);
    if (!retry.response.ok) {
      throw new TanssError(
        errorMessage(retry.envelope, retry.response, method, path),
        retry.response.status,
      );
    }
    return retry.envelope;
  }

  /**
   * Any route but /login answers a refresh token with a fresh token pair. The
   * session object is mutated so the caller can persist the rotation.
   */
  async function refreshSession(session: TanssSession): Promise<void> {
    const { response, envelope } = await call(
      session.refresh,
      "GET",
      "/api/v1/supportTypes/active",
    );
    if (!response.ok) {
      throw new TanssError("Sitzung abgelaufen, bitte erneut anmelden", 401);
    }
    const next = parseSession(envelope);
    session.apiKey = next.apiKey;
    session.refresh = next.refresh;
    session.expire = next.expire;
    session.employeeId = next.employeeId || session.employeeId;
  }

  async function call(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ response: Response; envelope: Envelope }> {
    const startedAt = now();
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        apiToken: token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const { envelope, raw } = await readEnvelope(response);
    onCall?.({
      method,
      path,
      status: response.status,
      ok: response.ok,
      message: tanssErrorText(envelope.error) || (envelope.meta?.text ?? ""),
      durationMs: now() - startedAt,
      body,
      traceId: tanssTraceId(envelope),
      url: response.url,
      redirected: response.redirected,
      responseBody: response.ok ? "" : raw,
    });
    return { response, envelope };
  }

  return {
    login,
    async ticketList(session, kind) {
      const envelope = await authed(session, "GET", LIST_PATHS[kind]);
      const raw = envelope.meta?.properties?.extras?.waitingStates;
      const waitingStates = Array.isArray(raw)
        ? raw.map(Number).filter((n) => Number.isInteger(n))
        : [];
      return {
        items: asArray(envelope.content),
        linked: envelope.meta?.linkedEntities ?? {},
        waitingStates,
      };
    },
    async customTicketList(session, filter) {
      const envelope = await authed(session, "PUT", "/api/v1/tickets", filter);
      return { items: asArray(envelope.content), linked: envelope.meta?.linkedEntities ?? {} };
    },
    async ticketById(session, ticketId) {
      const envelope = await authed(session, "GET", `/api/v1/tickets/${ticketId}`);
      return { item: asObject(envelope.content), linked: envelope.meta?.linkedEntities ?? {} };
    },
    async ticketHistory(session, ticketId) {
      const envelope = await authed(session, "GET", `/api/v1/tickets/history/${ticketId}`);
      return {
        content: asObject(envelope.content),
        linked: envelope.meta?.linkedEntities ?? {},
      };
    },
    async updateTicket(session, ticketId, ticket) {
      const envelope = await authed(session, "PUT", `/api/v1/tickets/${ticketId}`, ticket);
      return asObject(envelope.content);
    },
    async createComment(session, ticketId, body) {
      const envelope = await authed(
        session,
        "POST",
        `/api/v1/tickets/${ticketId}/comments`,
        body,
      );
      return asObject(envelope.content);
    },
    async ticketStates(session) {
      const envelope = await authed(session, "GET", "/api/v1/admin/ticketStates");
      return asArray(envelope.content);
    },
    async technicians(session) {
      const envelope = await authed(session, "GET", "/api/v1/employees/technicians");
      return asArray(envelope.content);
    },
    async supportTypes(session) {
      const envelope = await authed(session, "GET", "/api/v1/supportTypes/active");
      return asArray(envelope.content);
    },
    async listSupports(session, from, to, planningTypes, employeeId) {
      const envelope = await authed(
        session,
        "PUT",
        "/api/v1/supports/list",
        buildSupportsListBody(employeeId ?? session.employeeId, from, to, planningTypes),
      );
      return { items: asArray(envelope.content), linked: envelope.meta?.linkedEntities ?? {} };
    },
    async listPhoneCalls(session, from, to) {
      const envelope = await authed(
        session,
        "PUT",
        "/api/v1/phoneCalls",
        buildPhoneCallsBody(session.employeeId, from, to),
      );
      return asArray(envelope.content);
    },
    async createSupport(session, body) {
      const envelope = await authed(session, "POST", "/api/v1/supports", body);
      return asObject(envelope.content);
    },
    async supportById(session, supportId) {
      const envelope = await authed(session, "GET", `/api/v1/supports/${supportId}`);
      return { item: asObject(envelope.content), linked: envelope.meta?.linkedEntities ?? {} };
    },
    async updateSupport(session, supportId, body) {
      const envelope = await authed(session, "PUT", `/api/v1/supports/${supportId}`, body);
      return asObject(envelope.content);
    },
    async ticketSupports(session, ticketIds, from, to) {
      if (ticketIds.length === 0) return [];
      const envelope = await authed(
        session,
        "PUT",
        "/api/v1/supports/list",
        buildTicketSupportsBody(ticketIds, from, to),
      );
      return asArray(envelope.content);
    },
    async search(session, query) {
      const envelope = await authed(session, "PUT", "/api/v1/search", {
        areas: ["TICKET", "COMPANY"],
        query,
        configs: {
          ticket: { maxResults: 15, previewContentMaxChars: 80 },
          company: { maxResults: 10 },
        },
      });
      const content = asObject(envelope.content);
      return {
        tickets: asArray(content.tickets),
        companies: asArray(content.companies),
        linked: envelope.meta?.linkedEntities ?? {},
      };
    },
  };
}

function isExpiring(expire: number): boolean {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return expire > 0 && expire - nowSeconds < 60;
}

async function readEnvelope(response: Response): Promise<{ envelope: Envelope; raw: string }> {
  const text = await response.text();
  if (!text) return { envelope: {}, raw: "" };
  try {
    return { envelope: JSON.parse(text) as Envelope, raw: text };
  } catch {
    return { envelope: { meta: { text: text.slice(0, 200) } }, raw: text };
  }
}

function errorMessage(
  envelope: Envelope,
  response: Response,
  method?: string,
  path?: string,
): string {
  const status = response.status;
  const rejected = tanssErrorText(envelope.error);
  if (rejected) return rejected;
  if (response.redirected && method && method !== "GET") {
    return `Die Anfrage ${method} ${path} wurde nach ${response.url} umgeleitet und kam so nicht an (${status}). TANSS_BASE_URL auf die endgültige Adresse setzen.`;
  }
  // A failed login carries its reason in content.detailMessage.
  const detail = asObject(envelope.content).detailMessage;
  if (typeof detail === "string" && detail) {
    return loginDetail(detail);
  }
  const text = envelope.meta?.text?.trim();
  if (text) return text;
  if (status === 404 && method && path) {
    return `TANSS kennt die Route ${method} ${path} nicht (404). Prüfen, ob TANSS_BASE_URL stimmt und das Modul in dieser Instanz verfügbar ist.`;
  }
  return `TANSS-Fehler (${status})`;
}

function loginDetail(code: string): string {
  if (code === "LOGIN_ERROR_INVALID_USERNAME_OR_PASSWORD") {
    return "Benutzername oder Passwort ist falsch";
  }
  if (/TOKEN|OTP|TWO_FACTOR/i.test(code)) {
    return "Der 2FA-Code wurde abgelehnt";
  }
  return code;
}

export function tanssErrorText(error: Envelope["error"]): string {
  if (typeof error === "string") return error.trim();
  if (!error) return "";
  const raw =
    (error.localizedText ?? "").trim() || (error.text ?? "").trim() || (error.message ?? "").trim();
  // The login route answers with a bare code; say it in words. Without this a
  // rejected password reads as "route not found" and looks like an outage.
  return /^[A-Z_]+$/.test(raw) ? loginDetail(raw) : raw;
}

export function tanssTraceId(envelope: Envelope): string {
  return typeof envelope.error === "object" ? (envelope.error?.traceId ?? "") : "";
}

function parseSession(envelope: Envelope): TanssSession {
  const content = asObject(envelope.content);
  const employeeId = Number(content.employeeId);
  const apiKey = String(content.apiKey ?? "");
  const refresh = String(content.refresh ?? "");
  const expire = Number(content.expire ?? 0);
  if (!apiKey || !refresh) {
    throw new TanssError("TANSS-Login ohne Token", 401);
  }
  return { employeeId, apiKey, refresh, expire };
}

export function asArray(value: unknown): Obj[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Obj => typeof item === "object" && item !== null,
  );
}

export function asObject(value: unknown): Obj {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Obj;
  }
  return {};
}
