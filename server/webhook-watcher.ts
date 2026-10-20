import { SAMPLE_INTERVAL_MINUTES } from "../shared/dashboard.ts";
import { buildThread } from "../shared/thread.ts";
import { toTicketRow } from "../shared/tickets.ts";
import {
  deriveCause,
  matchesFilter,
  newId,
  renderTemplate,
  samplePayload,
  type Delivery,
  type Webhook,
  type WebhookLink,
  type WebhookPayload,
} from "../shared/webhooks.ts";
import type { SharedSession } from "./shared-session.ts";
import type { Store } from "./store.ts";
import { TanssError, type LinkedEntities, type TanssClient, type TanssSession } from "./tanss.ts";
import { afterAttempt, send, type Fetcher, type SendResult } from "./webhook-sender.ts";

export type WebhookWatcher = {
  /** Detection pass for the owner of the shared session. */
  check(): Promise<void>;
  /** Sends the due deliveries of the session owner. */
  flush(): Promise<void>;
  /** Check every SAMPLE_INTERVAL_MINUTES, flush every 15 s; timers unref'd. */
  start(): void;
  stop(): void;
  /** Remembers that the portal itself changed the status — in memory only. */
  notePortalChange(employeeId: number, ticketId: number, atUnix: number): void;
  /** Current status of a ticket as a new baseline. */
  baseline(session: TanssSession, ticketId: number): Promise<{ statusId: number; statusName: string }>;
  /** Sends the sample payload; not logged. */
  test(employeeId: number, webhookId: string): Promise<SendResult>;
  /** A new pending copy with a new id and the same body. */
  resend(employeeId: number, deliveryId: string): Delivery | null;
};

export const FLUSH_INTERVAL_MS = 15_000;
/** A portal mark older than this can no longer explain a change; it is dropped. */
const MARK_MAX_AGE_S = 2 * SAMPLE_INTERVAL_MINUTES * 60;

const GONE = "Ticket nicht mehr abrufbar – Verknüpfung entfernt";
const DELETED = "Webhook gelöscht";

type Obj = Record<string, unknown>;
/** What a delivery says about its event, before any attempt. */
type Head = Pick<Delivery, "key" | "webhookId" | "webhookName" | "url" | "ticketId" | "statusOld" | "statusNew" | "body" | "once">;

const sameLink = (a: { webhookId: string; ticketId: number }, b: { webhookId: string; ticketId: number }) =>
  a.webhookId === b.webhookId && a.ticketId === b.ticketId;

function statusOf(item: Obj, linked: LinkedEntities) {
  const row = toTicketRow(item, linked, []);
  return {
    statusId: row.statusId,
    statusName: row.statusName || `#${row.statusId}`,
    title: row.title,
    customer: row.companyName,
  };
}

/**
 * Watches the tickets that carry a webhook and delivers a call when their
 * status changes. Reads TANSS only. Order matters for "never lost, never
 * twice": a detected change is first written to the delivery queue, only then
 * does the link move on — and a delivery's key makes a repeated detection
 * after a crash in between a no-op.
 */
export function createWebhookWatcher(opts: {
  tanss: TanssClient;
  store: Store;
  shared: SharedSession;
  ticketUrl: string;
  fetcher?: Fetcher;
  now?: () => number;
}): WebhookWatcher {
  const { tanss, store, shared } = opts;
  const fetcher = opts.fetcher ?? fetch;
  const now = opts.now ?? Date.now;
  const seconds = () => Math.floor(now() / 1000);
  /** `${employeeId}:${ticketId}` → unix seconds of a status change made in the portal. */
  const portalMarks = new Map<string, number>();
  let checking = false;
  let flushing = false;
  let checkTimer: NodeJS.Timeout | null = null;
  let flushTimer: NodeJS.Timeout | null = null;

  const markKey = (employeeId: number, ticketId: number) => `${employeeId}:${ticketId}`;

  function addDeliveries(employeeId: number, fresh: Delivery[]): void {
    if (fresh.length === 0) return;
    store.setWebhookDeliveries(employeeId, [...store.webhookDeliveries(employeeId), ...fresh]);
  }

  /** Applies `change` to the stored links of one ticket; links removed meanwhile stay removed. */
  function updateLinks(employeeId: number, touched: WebhookLink[], change: (l: WebhookLink) => WebhookLink | null) {
    const next: WebhookLink[] = [];
    for (const l of store.webhookLinks(employeeId)) {
      if (!touched.some((t) => sameLink(t, l))) {
        next.push(l);
        continue;
      }
      const changed = change(l);
      if (changed) next.push(changed);
    }
    store.setWebhookLinks(employeeId, next);
  }

  /** A log entry that is done before it started: nothing will be sent. */
  function finished(base: Head, at: number, result: string): Delivery {
    return { ...base, id: newId(), createdAt: at, attempts: 0, nextAttemptAt: at, state: "failed", result, finishedAt: at };
  }

  async function checkTicket(
    session: TanssSession,
    employeeId: number,
    ticketId: number,
    links: WebhookLink[],
    hooks: Map<string, Webhook>,
    technician: () => Promise<string>,
  ): Promise<void> {
    let ticket: { item: Obj; linked: LinkedEntities };
    try {
      ticket = await tanss.ticketById(session, ticketId);
    } catch (error) {
      if (!(error instanceof TanssError) || error.status !== 404) return;
      const at = seconds();
      const known = new Set(store.webhookDeliveries(employeeId).map((d) => d.key));
      const logged: Delivery[] = [];
      for (const l of links) {
        const key = `${l.webhookId}|${ticketId}|gone|${l.checkedAt}`;
        if (known.has(key)) continue;
        const w = hooks.get(l.webhookId)!;
        logged.push(
          finished(
            { key, webhookId: w.id, webhookName: w.name, url: w.url, ticketId, statusOld: l.lastStatusName, statusNew: "", body: "", once: l.once },
            at,
            GONE,
          ),
        );
      }
      addDeliveries(employeeId, logged);
      updateLinks(employeeId, links, () => null);
      return;
    }

    const at = seconds();
    const current = statusOf(ticket.item, ticket.linked);
    const changed = links.filter((l) => l.lastStatusId !== current.statusId);
    if (changed.length > 0) {
      const windowStart = Math.min(...links.map((l) => l.checkedAt));
      const history = await tanss.ticketHistory(session, ticketId);
      const linked = { ...history.linked, ...ticket.linked };
      const thread = buildThread(ticket.item, history.content, linked, current.customer);
      const mark = portalMarks.get(markKey(employeeId, ticketId));
      const name = await technician();
      const portal = mark !== undefined && mark > windowStart && mark <= at ? { at: mark, by: name } : undefined;
      const cause = deriveCause(thread, windowStart, at, portal);

      const known = new Set(store.webhookDeliveries(employeeId).map((d) => d.key));
      const queued: Delivery[] = [];
      for (const l of changed) {
        const w = hooks.get(l.webhookId)!;
        if (!matchesFilter(w, current.statusId)) continue;
        const key = `${w.id}|${ticketId}|${l.lastStatusId}>${current.statusId}|${l.checkedAt}`;
        if (known.has(key)) continue;
        const payload: WebhookPayload = {
          ticket: {
            id: ticketId,
            title: current.title,
            url: opts.ticketUrl ? `${opts.ticketUrl}${ticketId}` : "",
            customer: current.customer,
          },
          status: {
            old: { id: l.lastStatusId, name: l.lastStatusName || `#${l.lastStatusId}` },
            new: { id: current.statusId, name: current.statusName },
          },
          cause,
          changedAt: new Date(at * 1000).toISOString(),
          technician: name,
          webhook: { id: w.id, name: w.name },
          test: false,
        };
        const base = {
          key,
          webhookId: w.id,
          webhookName: w.name,
          url: w.url,
          ticketId,
          statusOld: payload.status.old.name,
          statusNew: payload.status.new.name,
          once: l.once,
        };
        try {
          const body = renderTemplate(w.template, payload);
          queued.push({ ...base, id: newId(), body, createdAt: at, attempts: 0, nextAttemptAt: at, state: "pending", result: "", finishedAt: 0 });
        } catch (error) {
          queued.push(finished({ ...base, body: "" }, at, error instanceof Error ? error.message : "Vorlage ungültig"));
        }
      }
      // The queue first, then the new baseline: a crash in between repeats the
      // detection, and the key above turns the repeat into a no-op.
      addDeliveries(employeeId, queued);
    }
    updateLinks(employeeId, links, (l) => ({
      ...l,
      lastStatusId: current.statusId,
      lastStatusName: current.statusName,
      checkedAt: at,
    }));
    // Only the mark this pass could have used; one set while it ran is for the next change.
    const latest = portalMarks.get(markKey(employeeId, ticketId));
    if (changed.length > 0 && latest !== undefined && latest <= at) portalMarks.delete(markKey(employeeId, ticketId));
  }

  async function check(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      const oldest = seconds() - MARK_MAX_AGE_S;
      for (const [key, at] of portalMarks) if (at < oldest) portalMarks.delete(key);
      const state = shared.state(seconds());
      if (!state.present) return;
      const employeeId = state.employeeId;
      const hooks = new Map(store.webhooks(employeeId).filter((w) => w.active).map((w) => [w.id, w]));
      const byTicket = new Map<number, WebhookLink[]>();
      for (const l of store.webhookLinks(employeeId)) {
        if (!hooks.has(l.webhookId)) continue;
        const list = byTicket.get(l.ticketId) ?? [];
        list.push(l);
        byTicket.set(l.ticketId, list);
      }
      if (byTicket.size === 0) return;
      await shared.run(async (session) => {
        // The session may have changed hands since `state()`.
        if (session.employeeId !== employeeId) return;
        let name: Promise<string> | null = null;
        // Asked at most once per pass, and only when a change needs it.
        const technician = () =>
          (name ??= tanss
            .technicians(session)
            .then((list) => {
              const me = list.find((t) => Number(t.id) === employeeId);
              return me ? String(me.name ?? `${me.firstName ?? ""} ${me.lastName ?? ""}`).trim() : "";
            })
            .catch(() => ""));
        for (const [ticketId, links] of byTicket) {
          try {
            await checkTicket(session, employeeId, ticketId, links, hooks, technician);
          } catch {
            // This ticket stays as it was; the next pass catches up.
          }
        }
      });
    } catch {
      // No session, TANSS down: nothing changed, the next pass tries again.
    } finally {
      checking = false;
    }
  }

  async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      const employeeId = store.session()?.employeeId;
      if (!employeeId) return;
      const due = store
        .webhookDeliveries(employeeId)
        .filter((d) => d.state === "pending" && d.nextAttemptAt <= seconds())
        .map((d) => d.id);
      for (const id of due) {
        try {
          const d = store.webhookDeliveries(employeeId).find((x) => x.id === id);
          if (!d || d.state !== "pending") continue;
          const w = store.webhooks(employeeId).find((x) => x.id === d.webhookId);
          const at = seconds();
          // URL and secret are the webhook's current ones: a moved receiver
          // must not get retries at its old address, signed with the new secret.
          // The delivery records where the attempt actually went.
          const next: Delivery = w
            ? afterAttempt(
                { ...d, url: w.url },
                await send(fetcher, { url: w.url, body: d.body, deliveryId: d.id, secret: w.secret, nowUnix: at }),
                at,
              )
            : { ...d, state: "failed", result: DELETED, finishedAt: at };
          store.setWebhookDeliveries(
            employeeId,
            store.webhookDeliveries(employeeId).map((x) => (x.id === id ? next : x)),
          );
          if (next.state === "ok" && next.once) {
            store.setWebhookLinks(
              employeeId,
              store.webhookLinks(employeeId).filter((l) => !sameLink(l, next)),
            );
          }
        } catch {
          // Saving failed; the delivery stays pending and goes out again.
        }
      }
    } catch {
      // Nothing to do but wait for the next round.
    } finally {
      flushing = false;
    }
  }

  return {
    check,
    flush,
    start() {
      if (checkTimer) return;
      checkTimer = setInterval(() => void check(), SAMPLE_INTERVAL_MINUTES * 60_000);
      flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
      // A sidecar, not a reason for the process to stay alive.
      checkTimer.unref?.();
      flushTimer.unref?.();
      // Whatever was owed before a restart goes out right away.
      void flush();
    },
    stop() {
      if (checkTimer) clearInterval(checkTimer);
      if (flushTimer) clearInterval(flushTimer);
      checkTimer = null;
      flushTimer = null;
    },
    notePortalChange(employeeId, ticketId, atUnix) {
      portalMarks.set(markKey(employeeId, ticketId), atUnix);
    },
    async baseline(session, ticketId) {
      const ticket = await tanss.ticketById(session, ticketId);
      const { statusId, statusName } = statusOf(ticket.item, ticket.linked);
      return { statusId, statusName };
    },
    async test(employeeId, webhookId) {
      const w = store.webhooks(employeeId).find((x) => x.id === webhookId);
      if (!w) return { ok: false, status: 0, error: "Webhook nicht gefunden" };
      let body: string;
      try {
        body = renderTemplate(w.template, samplePayload({ id: w.id, name: w.name }));
      } catch (error) {
        return { ok: false, status: 0, error: error instanceof Error ? error.message : "Vorlage ungültig" };
      }
      return send(fetcher, { url: w.url, body, deliveryId: newId(), secret: w.secret, nowUnix: seconds() });
    },
    resend(employeeId, deliveryId) {
      const list = store.webhookDeliveries(employeeId);
      const original = list.find((d) => d.id === deliveryId);
      // Without a body there is nothing to send again (a removed link, a broken template).
      if (!original || !original.body) return null;
      const at = seconds();
      const current = store.webhooks(employeeId).find((w) => w.id === original.webhookId);
      const copy: Delivery = {
        ...original,
        // flush sends to the current URL anyway; the log should say so from the start.
        url: current?.url ?? original.url,
        id: newId(),
        createdAt: at,
        attempts: 0,
        nextAttemptAt: at,
        state: "pending",
        result: "",
        finishedAt: 0,
      };
      store.setWebhookDeliveries(employeeId, [...list, copy]);
      return copy;
    },
  };
}
