import type { TicketRow } from "../shared/tickets.ts";
import type { ThreadEntry } from "../shared/thread.ts";
import type { Support } from "../shared/timeline.ts";
import type { BookingTemplate } from "../shared/template.ts";
import type { Routine } from "../shared/routines.ts";
import type { AssistantResult } from "../shared/assistant.ts";
import type { StyleSettings } from "../shared/style.ts";
import type { ImportRules, Suggestion, WorkflowState } from "../shared/import.ts";
import type { Target } from "../shared/mapping.ts";
import type { UpdateOverview } from "../shared/update.ts";
import type { Delivery, ListedWebhook, WebhookLink } from "../shared/webhooks.ts";

export type ImportBookItem = {
  issue: string;
  startMinute: number;
  duration: number;
  text: string;
  ticketId?: number;
  companyId?: number;
  typeId: number;
};
import type { LogEntry } from "../shared/log.ts";
import type { Activity } from "../shared/activity.ts";
import type { BriefingFacts, ChatTurn, CompanyCheck, DraftIntent, NextStep, PatternGroup, SimilarHit } from "../shared/agent.ts";
import type { ClaimEntry, CollectorHealth, DashboardDay } from "../shared/dashboard.ts";
import type { SavedView } from "../shared/filters.ts";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("Der lokale Server antwortet nicht", 0);
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message =
      (data as { error?: string } | null)?.error ?? `Fehler ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return data as T;
}

export type AuthConfig = { tokenRequired: boolean; ticketUrl: string; linear: boolean };
export type Meta = {
  employeeId: number;
  states: { id: number; name: string; waiting: boolean; rank: number }[];
  technicians: { id: number; name: string }[];
  supportTypes: { id: number; name: string }[];
};
export type ActivityResult = {
  activity: Record<string, Activity>;
  today: string;
  since: string;
  ticketCount: number;
  historyChecked: number;
  historyRead: number;
  supportsRead: boolean;
};
export type TicketDetail = { ticket: TicketRow; thread: ThreadEntry[]; supports: Support[] };
export type Booking = {
  date: string;
  /** Key of the template this came from, so it stops being offered. */
  fromTemplate?: string;
  startMinute: number;
  duration: number;
  ticketId?: number;
  companyId?: number;
  typeId: number;
  location: "OFFICE" | "CUSTOMER" | "REMOTE";
  text: string;
};

export type AgentSettings = {
  baseUrl: string;
  model: string;
  contextTokens: number;
  /** Characters of one ticket thread the prompts may carry at this window. */
  threadChars: number;
  hasKey: boolean;
  keyHint: string;
  ready: boolean;
};
export type Briefing = { text: string; facts: BriefingFacts; createdAt: number; cached: boolean };
export type RowsPayload = { rows: TicketRow[]; activity: Record<number, Activity>; force?: boolean };
export type BriefingPayload = RowsPayload & { scope: string; label?: string };

/** What the form sends; `secret` left out keeps the stored one, "" removes it. */
export type WebhookInput = {
  name: string;
  url: string;
  statusFilter?: number[];
  template?: string;
  secret?: string;
  /** Only the list's switch sends this; the form leaves it out. */
  active?: boolean;
};
/** A delivery as the log shows it: the body stays on the server. */
export type DeliveryRow = Omit<Delivery, "body"> & {
  /** Finished and with a body to send again; the 404 and broken-template rows are not. */
  resendable: boolean;
};

export const api = {
  webhooks: {
    list: () => request<{ webhooks: ListedWebhook[] }>("GET", "/me/webhooks"),
    create: (input: WebhookInput) => request<{ webhook: ListedWebhook }>("POST", "/me/webhooks", input),
    update: (id: string, input: WebhookInput) =>
      request<{ webhook: ListedWebhook }>("PUT", `/me/webhooks/${encodeURIComponent(id)}`, input),
    remove: (id: string) => request<{ ok: true }>("DELETE", `/me/webhooks/${encodeURIComponent(id)}`),
    test: (id: string) =>
      request<{ ok: boolean; status: number; error: string }>("POST", `/me/webhooks/${encodeURIComponent(id)}/test`, {}),
    deliveries: () => request<{ deliveries: DeliveryRow[] }>("GET", "/me/webhooks/deliveries"),
    resend: (id: string) =>
      request<{ delivery: DeliveryRow }>("POST", `/me/webhooks/deliveries/${encodeURIComponent(id)}/resend`, {}),
    links: (ticketId: number) => request<{ links: WebhookLink[] }>("GET", `/me/tickets/${ticketId}/webhooks`),
    attach: (ticketId: number, webhookId: string, once: boolean) =>
      request<{ link: WebhookLink }>("POST", `/me/tickets/${ticketId}/webhooks`, { webhookId, once }),
    detach: (ticketId: number, webhookId: string) =>
      request<{ ok: true }>("DELETE", `/me/tickets/${ticketId}/webhooks/${encodeURIComponent(webhookId)}`),
  },
  config: () => request<AuthConfig>("GET", "/auth/config"),
  me: () => request<{ employeeId: number }>("GET", "/auth/me"),
  login: (username: string, password: string, token: string) =>
    request<{ employeeId: number }>("POST", "/auth/login", {
      username,
      password,
      token: token || undefined,
    }),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),
  /** 404 means this installation has no update service. */
  update: () => request<UpdateOverview>("GET", "/me/update"),
  checkUpdate: () => request<UpdateOverview>("POST", "/me/update/check"),
  startUpdate: (version: string) => request<UpdateOverview>("POST", "/me/update", { version }),
  meta: () => request<Meta>("GET", "/me/meta"),
  tickets: () =>
    request<{ rows: TicketRow[]; employeeId: number; employeeName: string; missing: string[] }>(
      "GET",
      "/me/tickets",
    ),
  activity: (ids: number[]) =>
    request<ActivityResult>("GET", `/me/tickets/activity?ids=${ids.join(",")}`),
  ticket: (id: number) => request<TicketDetail>("GET", `/me/tickets/${id}`),
  /** Just the row — for resolving a ticket number to a label. */
  ticketHead: (id: number) => request<TicketDetail>("GET", `/me/tickets/${id}?head=1`),
  comment: (id: number, content: string, internal: boolean, title = "") =>
    request<{ ok: true; id: number }>("POST", `/me/tickets/${id}/comments`, { content, internal, title }),
  patchTicket: (
    id: number,
    patch: { statusId?: number; assignedToEmployeeId?: number; companyId?: number; dueDate?: string; dueMinute?: number },
  ) =>
    request<{ ticket: TicketRow }>("PATCH", `/me/tickets/${id}`, patch),
  search: (q: string) =>
    request<{ tickets: TicketRow[]; companies: { id: number; name: string }[] }>(
      "GET",
      `/me/search?q=${encodeURIComponent(q)}`,
    ),
  supports: (day: string) =>
    request<{ week: string[]; supports: Support[]; templates: BookingTemplate[] }>(
      "GET",
      `/me/supports?day=${day}`,
    ),
  supportsRange: (from: string, to: string, employeeId?: number) =>
    request<{ from: string; to: string; employeeId: number; supports: Support[] }>(
      "GET",
      `/me/supports/range?from=${from}&to=${to}${employeeId ? `&employeeId=${employeeId}` : ""}`,
    ),
  book: (booking: Booking) => request<{ ok: true; id: number }>("POST", "/me/supports", booking),
  support: (id: number) =>
    request<{ support: Support; locked: boolean; lockReason: string | null; lockText: string }>(
      "GET",
      `/me/supports/${id}`,
    ),
  editSupport: (id: number, patch: Partial<Booking> & { internal?: boolean }) =>
    request<{ ok: true; support: Support }>("PUT", `/me/supports/${id}`, patch),
  session: () =>
    request<{ present: boolean; expire: number; updatedAt: number; deadline: number }>("GET", "/me/session"),
  stopCollector: () => request<{ ok: true }>("DELETE", "/me/session"),
  import: {
    states: () => request<{ enabled: boolean; items: WorkflowState[]; rules: ImportRules }>("GET", "/me/import/states"),
    saveRules: (rules: ImportRules) => request<{ rules: ImportRules }>("PUT", "/me/import/rules", { rules }),
    day: (day: string) =>
      request<{
        day: string;
        issuesChecked: number;
        capped: boolean;
        rules: ImportRules;
        suggestions: (Suggestion & { mapping: Target | null; bookedSupportId: number | null })[];
      }>("GET", `/me/import?day=${day}`),
    remember: (key: string, target: Target) =>
      request<{ mappings: Record<string, Target> }>("PUT", "/me/import/mappings", { key, target }),
    book: (day: string, items: ImportBookItem[]) =>
      request<{ results: { issue: string; id: number; error: string }[]; booked: number }>(
        "POST",
        "/me/import/book",
        { day, items },
      ),
  },
  style: () => request<{ style: StyleSettings }>("GET", "/me/style"),
  saveStyle: (style: StyleSettings) => request<{ style: StyleSettings }>("PUT", "/me/style", { style }),
  routines: () => request<{ routines: Routine[] }>("GET", "/me/routines"),
  saveRoutines: (routines: Routine[]) => request<{ routines: Routine[] }>("PUT", "/me/routines", { routines }),
  views: () => request<{ views: SavedView[] }>("GET", "/me/views"),
  saveViews: (views: SavedView[]) => request<{ views: SavedView[] }>("PUT", "/me/views", { views }),
  reports: () =>
    request<{ reports: { name: string; day: string; bytes: number }[]; lists: string[] }>("GET", "/me/reports"),
  saveReportLists: (lists: string[]) => request<{ lists: string[] }>("PUT", "/me/reports/lists", { lists }),
  claimHistory: (since: string) =>
    request<{ since: string; entries: ClaimEntry[] }>("GET", `/me/dashboard/claims?since=${since}`),
  dashboard: () =>
    request<{ days: DashboardDay[]; polling: boolean; intervalMinutes: number; health: CollectorHealth | null }>(
      "GET",
      "/me/dashboard",
    ),
  log: (since: number) => request<{ entries: LogEntry[]; lastId: number }>("GET", `/me/log?since=${since}`),
  clearLog: () => request<{ ok: true }>("DELETE", "/me/log"),
  agent: {
    settings: () => request<AgentSettings>("GET", "/me/agent/settings"),
    saveSettings: (input: { baseUrl: string; apiKey?: string; model: string; contextTokens: number }) =>
      request<AgentSettings>("PUT", "/me/agent/settings", input),
    models: (input: { baseUrl?: string; apiKey?: string }) =>
      request<{ models: string[] }>("POST", "/me/agent/models", input),
    test: () => request<{ ok: true; answer: string; durationMs: number; tools: boolean }>("POST", "/me/agent/test", {}),
    summary: (ticketId: number) => request<{ text: string }>("POST", "/me/agent/summary", { ticketId }),
    draft: (input: { ticketIds: number[]; intent: DraftIntent; instruction: string; internal: boolean; mailKey?: string }) =>
      request<{ text: string }>("POST", "/me/agent/draft", input),
    next: (ticketId: number) =>
      request<NextStep & { statusId: number | null; currentStatus: string; unchanged: boolean }>("POST", "/me/agent/next", { ticketId }),
    similar: (payload: RowsPayload & { ticketId: number }) =>
      request<{ similar: (SimilarHit & { title: string; companyName: string; statusName: string })[]; checked: number; searched: string; searchHits: number }>(
        "POST",
        "/me/agent/similar",
        payload,
      ),
    company: (ticketId: number) => request<CompanyCheck>("POST", "/me/agent/company", { ticketId }),
    cleanMail: (ticketId: number, mailKey: string) =>
      request<{ text: string; strippedChars: number }>("POST", "/me/agent/clean-mail", { ticketId, mailKey }),
    briefing: (payload: BriefingPayload) => request<Briefing>("POST", "/me/agent/briefing", payload),
    patterns: (payload: RowsPayload) =>
      request<{ groups: PatternGroup[]; checked: number; truncated: boolean }>("POST", "/me/agent/patterns", payload),
    importText: (material: { issue: string; title: string; project: string; notes: string }) =>
      request<{ text: string }>("POST", "/me/agent/import-text", material),
    assistant: (day: string, focus?: { start: number; end: number }) =>
      request<
        AssistantResult & {
          context: { bookedMinutes: number; gaps: number; templates: number; patterns: number; routines: number };
        }
      >("POST", "/me/agent/assistant", { day, ...(focus ? { focus } : {}) }),
    chat: (payload: RowsPayload & { messages: ChatTurn[]; openTicketId: number | null }) =>
      request<{ text: string; ticketsRead: number[]; steps: { tool: string; arg: string; result: string; ok: boolean }[] }>(
        "POST",
        "/me/agent/chat",
        payload,
      ),
  },
};
