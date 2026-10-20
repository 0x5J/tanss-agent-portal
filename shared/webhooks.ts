import { berlinMinuteOfDay } from "./days.ts";
import type { ThreadEntry } from "./thread.ts";

/**
 * Webhooks that fire when a ticket changes status. A webhook is the target
 * (URL, payload template, optional secret); a link ties it to one ticket;
 * a delivery is one call that is owed or has been made, kept as a log.
 */
export type Webhook = {
  id: string;
  name: string;
  url: string;
  trigger: "status";
  /** Status ids that fire the webhook; empty means every change. */
  statusFilter: number[];
  template: string;
  secret: string;
  active: boolean;
};

/** What goes to the client: the secret stays on the server. */
export type PublicWebhook = Omit<Webhook, "secret"> & { hasSecret: boolean };

export type WebhookLink = {
  webhookId: string;
  ticketId: number;
  /** Drop the link after the first delivery. */
  once: boolean;
  lastStatusId: number;
  lastStatusName: string;
  /** Unix seconds of the last check. */
  checkedAt: number;
};

export type DeliveryState = "pending" | "ok" | "failed";

export type Delivery = {
  id: string;
  /** Identifies the event, so the same change is never delivered twice. */
  key: string;
  webhookId: string;
  webhookName: string;
  url: string;
  ticketId: number;
  statusOld: string;
  statusNew: string;
  body: string;
  once: boolean;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  state: DeliveryState;
  result: string;
  finishedAt: number;
};

export const MAX_WEBHOOKS = 50;
export const MAX_FINISHED_DELIVERIES = 200;
export const MAX_TEMPLATE_LENGTH = 20_000;
export const DEFAULT_TEMPLATE = "{{json}}";

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const posInt = (v: unknown): number => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
};
const records = (raw: unknown): Record<string, unknown>[] =>
  Array.isArray(raw) ? raw.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : [];

export function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Tolerant reader for what was stored or sent — a broken entry is dropped. */
export function parseWebhooks(raw: unknown): Webhook[] {
  const list: Webhook[] = [];
  for (const r of records(raw)) {
    if (list.length >= MAX_WEBHOOKS) break;
    const name = str(r.name, 100).trim();
    const url = str(r.url, 2000).trim();
    if (!name || !isHttpUrl(url)) continue;
    const filter = Array.isArray(r.statusFilter) ? r.statusFilter.map(posInt).filter((n) => n > 0) : [];
    list.push({
      id: typeof r.id === "string" && r.id ? r.id : newId(),
      name,
      url,
      trigger: "status",
      statusFilter: [...new Set(filter)],
      template: typeof r.template === "string" && r.template.trim() ? r.template.slice(0, MAX_TEMPLATE_LENGTH) : DEFAULT_TEMPLATE,
      secret: str(r.secret, 200),
      active: r.active !== false,
    });
  }
  return list;
}

export function parseLinks(raw: unknown): WebhookLink[] {
  const list: WebhookLink[] = [];
  for (const r of records(raw)) {
    const webhookId = str(r.webhookId, 100);
    const ticketId = posInt(r.ticketId);
    if (!webhookId || !ticketId) continue;
    list.push({
      webhookId,
      ticketId,
      once: r.once === true,
      lastStatusId: num(r.lastStatusId),
      lastStatusName: str(r.lastStatusName, 200),
      checkedAt: num(r.checkedAt),
    });
  }
  return list;
}

const STATES: readonly string[] = ["pending", "ok", "failed"];

export function parseDeliveries(raw: unknown): Delivery[] {
  const list: Delivery[] = [];
  for (const r of records(raw)) {
    const id = str(r.id, 100);
    const webhookId = str(r.webhookId, 100);
    const ticketId = posInt(r.ticketId);
    if (!id || !webhookId || !ticketId || typeof r.state !== "string" || !STATES.includes(r.state)) continue;
    list.push({
      id,
      key: str(r.key, 300),
      webhookId,
      webhookName: str(r.webhookName, 100),
      url: str(r.url, 2000),
      ticketId,
      statusOld: str(r.statusOld, 200),
      statusNew: str(r.statusNew, 200),
      body: typeof r.body === "string" ? r.body : "",
      once: r.once === true,
      createdAt: num(r.createdAt),
      attempts: num(r.attempts),
      nextAttemptAt: num(r.nextAttemptAt),
      state: r.state as DeliveryState,
      result: str(r.result, 500),
      finishedAt: num(r.finishedAt),
    });
  }
  return list;
}

export function toPublic(w: Webhook): PublicWebhook {
  const { secret, ...rest } = w;
  return { ...rest, hasSecret: secret !== "" };
}

export function matchesFilter(w: Webhook, newStatusId: number): boolean {
  return w.statusFilter.length === 0 || w.statusFilter.includes(newStatusId);
}

/** Every open delivery stays; of the finished ones only the newest are kept. */
export function trimDeliveries(list: Delivery[]): Delivery[] {
  const keep = new Set(
    list
      .filter((d) => d.state !== "pending")
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .slice(0, MAX_FINISHED_DELIVERIES),
  );
  return list.filter((d) => d.state === "pending" || keep.has(d));
}

export type CauseKind = "mail" | "comment" | "support" | "portal" | "unknown";

/** Why the status changed. Never carries mail or comment text. */
export type Cause = {
  /** True when guessed from the thread, false when the portal made the change. */
  derived: boolean;
  kind: CauseKind;
  by: string;
  /** ISO time, or "" when unknown. */
  at: string;
  summary: string;
};

export type WebhookPayload = {
  ticket: { id: number; title: string; url: string; customer: string };
  status: { old: { id: number; name: string }; new: { id: number; name: string } };
  cause: Cause;
  changedAt: string;
  technician: string;
  webhook: { id: string; name: string };
  test: boolean;
};

export const PLACEHOLDERS: string[] = [
  "ticket.id",
  "ticket.title",
  "ticket.url",
  "customer",
  "status.old",
  "status.new",
  "cause.summary",
  "cause.kind",
  "cause.by",
  "cause.at",
  "changedAt",
  "technician",
  "webhook.name",
  "json",
];

const isoOf = (unix: number): string => new Date(unix * 1000).toISOString();

function clock(unix: number): string {
  const m = berlinMinuteOfDay(unix);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const THREAD_CAUSES: Partial<Record<ThreadEntry["kind"], { kind: CauseKind; label: string }>> = {
  "Mail eingehend": { kind: "mail", label: "Mail von" },
  "Mail ausgehend": { kind: "mail", label: "Mail von" },
  Kommentar: { kind: "comment", label: "Kommentar von" },
  "Interne Notiz": { kind: "comment", label: "Kommentar von" },
  Leistung: { kind: "support", label: "Zeitbuchung von" },
};

/**
 * Best guess at what moved the status: the newest mail, comment or support in
 * (sinceUnix, untilUnix]. A change made in the portal is known, not guessed.
 */
export function deriveCause(
  thread: ThreadEntry[],
  sinceUnix: number,
  untilUnix: number,
  portal?: { at: number; by: string },
): Cause {
  if (portal) {
    return {
      derived: false,
      kind: "portal",
      by: portal.by,
      at: isoOf(portal.at),
      summary: `Im Portal von ${portal.by} geändert um ${clock(portal.at)}`,
    };
  }
  let best: ThreadEntry | null = null;
  for (const e of thread) {
    if (!THREAD_CAUSES[e.kind] || e.at <= sinceUnix || e.at > untilUnix) continue;
    if (!best || e.at >= best.at) best = e;
  }
  const mapped = best && THREAD_CAUSES[best.kind];
  if (!best || !mapped) {
    return { derived: true, kind: "unknown", by: "", at: "", summary: "Kein Anlass im Verlauf gefunden" };
  }
  return {
    derived: true,
    kind: mapped.kind,
    by: best.author,
    at: isoOf(best.at),
    summary: `${mapped.label} ${best.author} um ${clock(best.at)}`,
  };
}

function placeholderValue(name: string, p: WebhookPayload): string | number | undefined {
  switch (name) {
    case "ticket.id": return p.ticket.id;
    case "ticket.title": return p.ticket.title;
    case "ticket.url": return p.ticket.url;
    case "customer": return p.ticket.customer;
    case "status.old": return p.status.old.name;
    case "status.new": return p.status.new.name;
    case "cause.summary": return p.cause.summary;
    case "cause.kind": return p.cause.kind;
    case "cause.by": return p.cause.by;
    case "cause.at": return p.cause.at;
    case "changedAt": return p.changedAt;
    case "technician": return p.technician;
    case "webhook.name": return p.webhook.name;
    case "json": return JSON.stringify(p);
    default: return undefined;
  }
}

/**
 * Fills `{{name}}` placeholders. Strings are JSON-escaped without quotes (so
 * they sit inside a JSON string), numbers stay numbers, `{{json}}` is the
 * whole payload. Throws a German message for an unknown placeholder.
 */
export function renderTemplate(template: string, payload: WebhookPayload): string {
  return template.replace(/\{\{\s*([\w.]*)\s*\}\}/g, (_all, name: string) => {
    const value = placeholderValue(name, payload);
    if (value === undefined) throw new Error(`Unbekannter Platzhalter: {{${name}}}`);
    if (name === "json") return String(value);
    return typeof value === "number" ? String(value) : JSON.stringify(value).slice(1, -1);
  });
}

export function samplePayload(webhook: { id: string; name: string }): WebhookPayload {
  const at = Math.floor(Date.now() / 1000);
  return {
    ticket: { id: 12345, title: "Beispielticket", url: "", customer: "Beispiel GmbH" },
    status: { old: { id: 1, name: "Neu" }, new: { id: 2, name: "Erledigt" } },
    cause: {
      derived: true,
      kind: "mail",
      by: "Max Mustermann",
      at: isoOf(at),
      summary: `Mail von Max Mustermann um ${clock(at)}`,
    },
    changedAt: isoOf(at),
    technician: "Erika Beispiel",
    webhook: { id: webhook.id, name: webhook.name },
    test: true,
  };
}

/** Null when the template renders to valid JSON, else a German reason. */
export function templateError(template: string): string | null {
  let body: string;
  try {
    body = renderTemplate(template, samplePayload({ id: "sample", name: "Beispiel" }));
  } catch (e) {
    return e instanceof Error ? e.message : "Die Vorlage ist ungültig";
  }
  try {
    JSON.parse(body);
    return null;
  } catch {
    return "Die Vorlage ergibt kein gültiges JSON";
  }
}
