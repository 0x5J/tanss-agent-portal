/**
 * The webhook routes: the targets a technician keeps, the tickets they hang
 * on, and the log of calls made. Everything is scoped to the logged-in
 * employee; an id that belongs to somebody else is simply "not found".
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DEFAULT_TEMPLATE,
  MAX_WEBHOOKS,
  newId,
  templateError,
  toPublic,
  type Delivery,
  type Webhook,
  type WebhookLink,
} from "../shared/webhooks.ts";
import type { Store } from "./store.ts";
import type { TanssSession } from "./tanss.ts";
import type { WebhookWatcher } from "./webhook-watcher.ts";

export type WebhookRouteDeps = {
  store: Store;
  watcher: WebhookWatcher;
  employee: (request: FastifyRequest, reply: FastifyReply) => Promise<number>;
  withSession: <T>(request: FastifyRequest, reply: FastifyReply, work: (session: TanssSession) => Promise<T>) => Promise<T>;
  now: () => number;
};

const isHttpUrl = (value: string): boolean => {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

const webhookSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().max(2000).refine(isHttpUrl),
  statusFilter: z.array(z.number().int().positive()).max(50).default([]),
  template: z.string().max(20_000).optional(),
  secret: z.string().max(200).optional(),
  active: z.boolean().optional(),
});

const attachSchema = z.object({
  webhookId: z.string().min(1).max(100),
  once: z.boolean().default(false),
});

const NOT_FOUND = "Webhook nicht gefunden";
const NO_DELIVERY = "Zustellung nicht gefunden";

const withoutBody = ({ body: _body, ...rest }: Delivery) => rest;

export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): void {
  const { store, watcher, employee, withSession, now } = deps;
  const seconds = () => Math.floor(now() / 1000);
  const idOf = (request: FastifyRequest, name = "id") => (request.params as Record<string, string>)[name] ?? "";
  const ticketIdOf = (request: FastifyRequest) => Number(idOf(request));
  const validTicket = (id: number) => Number.isInteger(id) && id > 0;

  /** The checked body, or the German reason it is refused. */
  function parseBody(body: unknown): { ok: true; data: z.infer<typeof webhookSchema> } | { ok: false; error: string } {
    const parsed = webhookSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: "Webhook ungültig" };
    const template = parsed.data.template?.trim() ? parsed.data.template : undefined;
    if (template !== undefined) {
      const error = templateError(template);
      if (error) return { ok: false, error };
    }
    return { ok: true, data: { ...parsed.data, template: template ?? DEFAULT_TEMPLATE } };
  }

  app.get("/me/webhooks", async (request, reply) => {
    const employeeId = await employee(request, reply);
    return { webhooks: store.webhooks(employeeId).map(toPublic) };
  });

  app.post("/me/webhooks", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const parsed = parseBody(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const list = store.webhooks(employeeId);
    if (list.length >= MAX_WEBHOOKS) {
      return reply.code(400).send({ error: `Es sind höchstens ${MAX_WEBHOOKS} Webhooks möglich` });
    }
    const { data } = parsed;
    // The id is the server's to give; one sent along is ignored.
    const webhook: Webhook = {
      id: newId(),
      name: data.name,
      url: data.url,
      trigger: "status",
      statusFilter: [...new Set(data.statusFilter)],
      template: data.template ?? DEFAULT_TEMPLATE,
      secret: data.secret ?? "",
      active: data.active ?? true,
    };
    store.setWebhooks(employeeId, [...list, webhook]);
    return { webhook: toPublic(webhook) };
  });

  app.put("/me/webhooks/:id", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const id = idOf(request);
    const existing = store.webhooks(employeeId).find((w) => w.id === id);
    if (!existing) return reply.code(404).send({ error: NOT_FOUND });
    const parsed = parseBody(request.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { data } = parsed;
    const next: Webhook = {
      ...existing,
      name: data.name,
      url: data.url,
      statusFilter: [...new Set(data.statusFilter)],
      template: data.template ?? DEFAULT_TEMPLATE,
      // Missing keeps the stored secret, an empty string removes it.
      secret: data.secret === undefined ? existing.secret : data.secret,
      active: data.active ?? existing.active,
    };

    // A webhook that was off missed changes on purpose; switching it on starts
    // from where the tickets are now, so it does not fire for the time away.
    const baselines = new Map<number, { statusId: number; statusName: string; at: number }>();
    if (!existing.active && next.active) {
      const tickets = store.webhookLinks(employeeId).filter((l) => l.webhookId === id).map((l) => l.ticketId);
      if (tickets.length > 0) {
        await withSession(request, reply, async (session) => {
          for (const ticketId of tickets) {
            try {
              const base = await watcher.baseline(session, ticketId);
              baselines.set(ticketId, { ...base, at: seconds() });
            } catch {
              // This link stays as it was.
            }
          }
        });
      }
    }

    store.setWebhooks(
      employeeId,
      store.webhooks(employeeId).map((w) => (w.id === id ? next : w)),
    );
    if (baselines.size > 0) {
      store.setWebhookLinks(
        employeeId,
        store.webhookLinks(employeeId).map((l) => {
          const base = l.webhookId === id ? baselines.get(l.ticketId) : undefined;
          return base ? { ...l, lastStatusId: base.statusId, lastStatusName: base.statusName, checkedAt: base.at } : l;
        }),
      );
    }
    return { webhook: toPublic(next) };
  });

  app.delete("/me/webhooks/:id", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const id = idOf(request);
    if (!store.webhooks(employeeId).some((w) => w.id === id)) return reply.code(404).send({ error: NOT_FOUND });
    store.setWebhooks(
      employeeId,
      store.webhooks(employeeId).filter((w) => w.id !== id),
    );
    store.setWebhookLinks(
      employeeId,
      store.webhookLinks(employeeId).filter((l) => l.webhookId !== id),
    );
    return { ok: true };
  });

  app.post("/me/webhooks/:id/test", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const id = idOf(request);
    if (!store.webhooks(employeeId).some((w) => w.id === id)) return reply.code(404).send({ error: NOT_FOUND });
    return watcher.test(employeeId, id);
  });

  app.get("/me/webhooks/deliveries", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const deliveries = store
      .webhookDeliveries(employeeId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(withoutBody);
    return { deliveries };
  });

  app.post("/me/webhooks/deliveries/:id/resend", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const delivery = watcher.resend(employeeId, idOf(request));
    if (!delivery) return reply.code(404).send({ error: NO_DELIVERY });
    return { delivery: withoutBody(delivery) };
  });

  // --- on a ticket -----------------------------------------------------------

  app.get("/me/tickets/:id/webhooks", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const ticketId = ticketIdOf(request);
    if (!validTicket(ticketId)) return reply.code(400).send({ error: "Ticket ungültig" });
    return { links: store.webhookLinks(employeeId).filter((l) => l.ticketId === ticketId) };
  });

  app.post("/me/tickets/:id/webhooks", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const ticketId = ticketIdOf(request);
    const parsed = attachSchema.safeParse(request.body);
    if (!validTicket(ticketId) || !parsed.success) return reply.code(400).send({ error: "Anfrage ungültig" });
    const { webhookId, once } = parsed.data;
    if (!store.webhooks(employeeId).some((w) => w.id === webhookId)) return reply.code(404).send({ error: NOT_FOUND });
    const taken = () => store.webhookLinks(employeeId).some((l) => l.webhookId === webhookId && l.ticketId === ticketId);
    const duplicate = () => reply.code(409).send({ error: "Dieser Webhook hängt schon an dem Ticket" });
    if (taken()) return duplicate();

    const base = await withSession(request, reply, (session) => watcher.baseline(session, ticketId));
    // The webhook or an identical link may have changed while TANSS answered.
    if (!store.webhooks(employeeId).some((w) => w.id === webhookId)) return reply.code(404).send({ error: NOT_FOUND });
    if (taken()) return duplicate();
    const link: WebhookLink = {
      webhookId,
      ticketId,
      once,
      lastStatusId: base.statusId,
      lastStatusName: base.statusName,
      checkedAt: seconds(),
    };
    store.setWebhookLinks(employeeId, [...store.webhookLinks(employeeId), link]);
    return { link };
  });

  app.delete("/me/tickets/:id/webhooks/:webhookId", async (request, reply) => {
    const employeeId = await employee(request, reply);
    const ticketId = ticketIdOf(request);
    if (!validTicket(ticketId)) return reply.code(400).send({ error: "Ticket ungültig" });
    const webhookId = idOf(request, "webhookId");
    store.setWebhookLinks(
      employeeId,
      store.webhookLinks(employeeId).filter((l) => !(l.webhookId === webhookId && l.ticketId === ticketId)),
    );
    return { ok: true };
  });
}
