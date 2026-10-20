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

function isHttpUrl(url: string): boolean {
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
      template: typeof r.template === "string" && r.template.trim() ? r.template.slice(0, 5000) : DEFAULT_TEMPLATE,
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
