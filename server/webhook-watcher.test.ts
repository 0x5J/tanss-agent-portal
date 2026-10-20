import { describe, expect, it } from "vitest";
import type { Delivery, Webhook, WebhookLink, WebhookPayload } from "../shared/webhooks.ts";
import type { SharedSession } from "./shared-session.ts";
import { createMemoryStore, type Store } from "./store.ts";
import { TanssError, type TanssClient, type TanssSession } from "./tanss.ts";
import type { Fetcher } from "./webhook-sender.ts";
import { createWebhookWatcher } from "./webhook-watcher.ts";

const SESSION: TanssSession = { employeeId: 7, apiKey: "Bearer a", refresh: "Bearer r", expire: 9_999_999_999 };
const START = 1_760_000_000;
const TICKET_URL = "https://tanss.example/ticket/";

type Call = { name: string; args: unknown[] };

function fakeTanss(overrides: Partial<TanssClient> = {}) {
  const calls: Call[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const record = (name: string, result: unknown): any =>
    async (...args: unknown[]) => {
      calls.push({ name, args });
      return result;
    };
  const client = {
    ticketById: async (_s: TanssSession, id: number) => {
      calls.push({ name: "ticketById", args: [id] });
      return {
        item: { id, title: "Drucker streikt", statusId: 3, companyId: 5, creationDate: 1 },
        linked: {
          ticketStates: { "2": { name: "Neu" }, "3": { name: "Erledigt" } },
          companies: { "5": { name: "Kunde GmbH" } },
        },
      };
    },
    ticketHistory: async (_s: TanssSession, id: number) => {
      calls.push({ name: "ticketHistory", args: [id] });
      return {
        content: {
          comments: [],
          supports: [],
          mails: [{ id: 1, inbound: true, senderName: "Max Mustermann", date: START - 60, subject: "Geht wieder" }],
        },
        linked: {},
      };
    },
    technicians: record("technicians", [{ id: 7, name: "Erika Technik" }]),
    ...overrides,
  } as unknown as TanssClient;
  return { client, calls };
}

function fakeShared(employeeId = 7): SharedSession {
  return {
    run: (work) => work(SESSION),
    adopt: () => {},
    clear: () => {},
    state: () => ({ present: true, employeeId, expire: 0, updatedAt: 0, deadline: 0 }),
  };
}

function fakeFetcher(statuses: number[]) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(null, { status: statuses.shift() ?? 204 });
  }) as unknown as Fetcher;
  return { fetcher, seen };
}

function hook(partial: Partial<Webhook> = {}): Webhook {
  return {
    id: "w1",
    name: "Teams",
    url: "http://hook.local/a",
    trigger: "status",
    statusFilter: [],
    template: "{{json}}",
    secret: "",
    active: true,
    ...partial,
  };
}

function link(partial: Partial<WebhookLink> = {}): WebhookLink {
  return {
    webhookId: "w1",
    ticketId: 42,
    once: false,
    lastStatusId: 2,
    lastStatusName: "Neu",
    checkedAt: START - 300,
    ...partial,
  };
}

function setup(opts: {
  webhooks?: Webhook[];
  links?: WebhookLink[];
  tanss?: Partial<TanssClient>;
  employeeId?: number;
  statuses?: number[];
  store?: Store;
  ticketUrl?: string;
} = {}) {
  const store = opts.store ?? createMemoryStore();
  store.setSession({ employeeId: 7, apiKey: "a", refresh: "r", expire: 0, updatedAt: 0 });
  store.setWebhooks(7, opts.webhooks ?? [hook()]);
  store.setWebhookLinks(7, opts.links ?? [link()]);
  const { client, calls } = fakeTanss(opts.tanss);
  const { fetcher, seen } = fakeFetcher(opts.statuses ?? []);
  const clock = { now: START };
  const watcher = createWebhookWatcher({
    tanss: client,
    store,
    shared: fakeShared(opts.employeeId ?? 7),
    ticketUrl: opts.ticketUrl ?? TICKET_URL,
    fetcher,
    now: () => clock.now * 1000,
  });
  return { store, calls, seen, clock, watcher };
}

const deliveries = (store: Store): Delivery[] => store.webhookDeliveries(7);
const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];

describe("webhook watcher", () => {
  it("no change, no delivery", async () => {
    const { store, watcher } = setup({ links: [link({ lastStatusId: 3, lastStatusName: "Erledigt" })] });
    await watcher.check();
    expect(deliveries(store)).toEqual([]);
    expect(store.webhookLinks(7)[0].checkedAt).toBe(START);
    expect(store.webhookLinks(7)[0].lastStatusId).toBe(3);
  });

  it("a change queues one delivery with old/new names and the derived cause", async () => {
    const { store, watcher } = setup();
    await watcher.check();
    const list = deliveries(store);
    expect(list).toHaveLength(1);
    const d = list[0];
    expect(d).toMatchObject({
      webhookId: "w1",
      webhookName: "Teams",
      url: "http://hook.local/a",
      ticketId: 42,
      statusOld: "Neu",
      statusNew: "Erledigt",
      state: "pending",
      attempts: 0,
      nextAttemptAt: START,
      createdAt: START,
      key: `w1|42|2>3|${START - 300}`,
    });
    const payload = JSON.parse(d.body) as WebhookPayload;
    expect(payload.status.old).toEqual({ id: 2, name: "Neu" });
    expect(payload.status.new).toEqual({ id: 3, name: "Erledigt" });
    expect(payload.cause.kind).toBe("mail");
    expect(payload.cause.derived).toBe(true);
    expect(payload.cause.by).toBe("Max Mustermann");
    expect(payload.ticket).toEqual({ id: 42, title: "Drucker streikt", url: `${TICKET_URL}42`, customer: "Kunde GmbH" });
    expect(payload.technician).toBe("Erika Technik");
    expect(payload.webhook).toEqual({ id: "w1", name: "Teams" });
    expect(payload.test).toBe(false);
    expect(payload.changedAt).toBe(new Date(START * 1000).toISOString());
    expect(store.webhookLinks(7)[0]).toMatchObject({ lastStatusId: 3, lastStatusName: "Erledigt", checkedAt: START });
  });

  it("filter: only the matching webhook sends, both links move on", async () => {
    const { store, watcher, calls } = setup({
      webhooks: [hook(), hook({ id: "w2", name: "Slack", statusFilter: [9] })],
      links: [link(), link({ webhookId: "w2" })],
    });
    await watcher.check();
    expect(deliveries(store).map((d) => d.webhookId)).toEqual(["w1"]);
    expect(store.webhookLinks(7).map((l) => [l.webhookId, l.lastStatusId, l.checkedAt])).toEqual([
      ["w1", 3, START],
      ["w2", 3, START],
    ]);
    // One ticket, one fetch — however many links hang on it.
    expect(calls.filter((c) => c.name === "ticketById")).toHaveLength(1);
    expect(calls.filter((c) => c.name === "ticketHistory")).toHaveLength(1);
  });

  it("crash between saving deliveries and links does not duplicate", async () => {
    const store = createMemoryStore();
    const real = store.setWebhookLinks.bind(store);
    let failOnce = false;
    store.setWebhookLinks = (id, list) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("Platte voll");
      }
      real(id, list);
    };
    const { watcher, clock } = setup({ store });
    failOnce = true;
    await expect(watcher.check()).resolves.toBeUndefined();
    expect(deliveries(store)).toHaveLength(1);
    expect(store.webhookLinks(7)[0].lastStatusId).toBe(2);
    clock.now += 300;
    await watcher.check();
    expect(deliveries(store)).toHaveLength(1);
    expect(store.webhookLinks(7)[0]).toMatchObject({ lastStatusId: 3, checkedAt: START + 300 });
  });

  it("a second call while one runs returns at once", async () => {
    const { store, watcher, calls, seen } = setup();
    await Promise.all([watcher.check(), watcher.check()]);
    expect(calls.filter((c) => c.name === "ticketById")).toHaveLength(1);
    await Promise.all([watcher.flush(), watcher.flush()]);
    expect(seen).toHaveLength(1);
    expect(deliveries(store)[0]).toMatchObject({ state: "ok", attempts: 1 });
  });

  it("inactive webhooks are not checked", async () => {
    const { store, watcher, calls } = setup({
      webhooks: [hook({ active: false })],
      links: [link()],
    });
    await watcher.check();
    expect(calls.filter((c) => c.name === "ticketById")).toEqual([]);
    expect(deliveries(store)).toEqual([]);
    expect(store.webhookLinks(7)[0]).toEqual(link());
  });

  it("a foreign session pauses the check", async () => {
    const store = createMemoryStore();
    store.setWebhooks(8, [hook()]);
    store.setWebhookLinks(8, [link()]);
    // state() says 8, but the session run hands out belongs to 7.
    const { watcher, calls } = setup({ employeeId: 8, store });
    await watcher.check();
    expect(calls).toEqual([]);
    expect(deliveries(store)).toEqual([]);
    expect(store.webhookDeliveries(8)).toEqual([]);
    expect(store.webhookLinks(7)[0]).toEqual(link());
    expect(store.webhookLinks(8)[0]).toEqual(link());
  });

  it("without a ticket URL the payload carries an empty one", async () => {
    const { store, watcher } = setup({ ticketUrl: "" });
    await watcher.check();
    expect((JSON.parse(deliveries(store)[0].body) as WebhookPayload).ticket.url).toBe("");
  });

  it("404 removes the link and logs it", async () => {
    const { store, watcher } = setup({
      tanss: {
        ticketById: async () => {
          throw new TanssError("Nicht gefunden", 404);
        },
      },
    });
    await watcher.check();
    expect(store.webhookLinks(7)).toEqual([]);
    const list = deliveries(store);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      webhookId: "w1",
      ticketId: 42,
      state: "failed",
      attempts: 0,
      result: "Ticket nicht mehr abrufbar – Verknüpfung entfernt",
      finishedAt: START,
    });
  });

  it("other errors leave the links alone", async () => {
    const { store, watcher } = setup({
      tanss: {
        ticketById: async () => {
          throw new TanssError("Serverfehler", 500);
        },
      },
    });
    await watcher.check();
    expect(store.webhookLinks(7)).toEqual([link()]);
    expect(deliveries(store)).toEqual([]);
  });

  it("portal change becomes the cause", async () => {
    const { store, watcher } = setup();
    watcher.notePortalChange(7, 42, START - 10);
    await watcher.check();
    const payload = JSON.parse(deliveries(store)[0].body) as WebhookPayload;
    expect(payload.cause.kind).toBe("portal");
    expect(payload.cause.derived).toBe(false);
    expect(payload.cause.by).toBe("Erika Technik");
  });

  it("a portal mark set during the pass survives for the next change", async () => {
    let status = 3;
    let watcherRef: { notePortalChange(e: number, t: number, a: number): void } | null = null;
    const { store, watcher, clock } = setup({
      tanss: {
        ticketById: async (_s: TanssSession, id: number) => ({
          item: { id, title: "T", statusId: status, companyId: 5 },
          linked: { ticketStates: { "2": { name: "Neu" }, "3": { name: "Erledigt" }, "4": { name: "Wartet" } } },
        }),
        ticketHistory: async () => {
          watcherRef?.notePortalChange(7, 42, START + 1);
          return { content: { comments: [], supports: [], mails: [] }, linked: {} };
        },
      } as Partial<TanssClient>,
    });
    watcherRef = watcher;
    await watcher.check();
    expect((JSON.parse(deliveries(store)[0].body) as WebhookPayload).cause.kind).toBe("unknown");
    watcherRef = null;
    status = 4;
    clock.now += 300;
    await watcher.check();
    const second = JSON.parse(deliveries(store)[1].body) as WebhookPayload;
    expect(second.cause).toMatchObject({ kind: "portal", derived: false });
    expect(second.cause.at).toBe(new Date((START + 1) * 1000).toISOString());
  });

  it("old portal marks are pruned", async () => {
    // The window reaches back far enough, but a mark older than two intervals is dropped.
    const { store, watcher } = setup({ links: [link({ checkedAt: START - 2000 })] });
    watcher.notePortalChange(7, 42, START - 1000);
    await watcher.check();
    expect((JSON.parse(deliveries(store)[0].body) as WebhookPayload).cause.kind).toBe("mail");
  });

  it("a portal mark outside the window is ignored", async () => {
    const { store, watcher } = setup();
    watcher.notePortalChange(7, 42, START - 1000);
    await watcher.check();
    const payload = JSON.parse(deliveries(store)[0].body) as WebhookPayload;
    expect(payload.cause.kind).toBe("mail");
  });

  it("a broken template still logs the delivery, as failed", async () => {
    const { store, watcher } = setup({ webhooks: [hook({ template: '{"x":"{{nope}}"}' })] });
    await watcher.check();
    expect(deliveries(store)[0]).toMatchObject({
      state: "failed",
      result: "Unbekannter Platzhalter: {{nope}}",
      finishedAt: START,
    });
    expect(store.webhookLinks(7)[0].lastStatusId).toBe(3);
  });

  it("flush sends, retries, and once unlinks on success", async () => {
    const { store, watcher, seen, clock } = setup({
      links: [link({ once: true })],
      webhooks: [hook({ secret: "geheim" })],
      statuses: [500, 204],
    });
    await watcher.check();
    await watcher.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("http://hook.local/a");
    expect(header(seen[0].init, "X-Portal-Signature")).toMatch(/^sha256=/);
    expect(deliveries(store)[0]).toMatchObject({ state: "pending", attempts: 1, result: "HTTP 500" });
    expect(store.webhookLinks(7)).toHaveLength(1);

    // Not due yet.
    clock.now += 10;
    await watcher.flush();
    expect(seen).toHaveLength(1);

    clock.now += 20;
    await watcher.flush();
    expect(seen).toHaveLength(2);
    expect(header(seen[1].init, "X-Portal-Delivery")).toBe(header(seen[0].init, "X-Portal-Delivery"));
    expect(deliveries(store)[0]).toMatchObject({ state: "ok", attempts: 2, result: "204" });
    expect(store.webhookLinks(7)).toEqual([]);
  });

  it("a changed webhook URL takes effect for pending deliveries", async () => {
    const { store, watcher, seen } = setup();
    await watcher.check();
    store.setWebhooks(7, [hook({ url: "http://neu.local/b" })]);
    await watcher.flush();
    expect(seen.map((s) => s.url)).toEqual(["http://neu.local/b"]);
    expect(deliveries(store)[0]).toMatchObject({ state: "ok", url: "http://neu.local/b" });
  });

  it("resend targets the current webhook URL", async () => {
    const { store, watcher } = setup();
    await watcher.check();
    await watcher.flush();
    store.setWebhooks(7, [hook({ url: "http://neu.local/b" })]);
    const copy = watcher.resend(7, deliveries(store)[0].id);
    expect(copy?.url).toBe("http://neu.local/b");
  });

  it("a deleted webhook finishes its open deliveries", async () => {
    const { store, watcher, seen } = setup();
    await watcher.check();
    store.setWebhooks(7, []);
    await watcher.flush();
    expect(seen).toEqual([]);
    expect(deliveries(store)[0]).toMatchObject({ state: "failed", result: "Webhook gelöscht", finishedAt: START });
  });

  it("a pending delivery survives a restart", async () => {
    const first = setup();
    await first.watcher.check();
    const id = deliveries(first.store)[0].id;
    const { fetcher, seen } = fakeFetcher([204]);
    const again = createWebhookWatcher({
      tanss: fakeTanss().client,
      store: first.store,
      shared: fakeShared(),
      ticketUrl: TICKET_URL,
      fetcher,
      now: () => START * 1000,
    });
    await again.flush();
    expect(seen).toHaveLength(1);
    expect(header(seen[0].init, "X-Portal-Delivery")).toBe(id);
    expect(seen[0].init.body).toBe(deliveries(first.store)[0].body);
    expect(deliveries(first.store)[0]).toMatchObject({ id, state: "ok" });
  });

  it("resend copies body with a new id", async () => {
    const { store, watcher, clock } = setup();
    await watcher.check();
    await watcher.flush();
    const original = deliveries(store)[0];
    clock.now += 100;
    const copy = watcher.resend(7, original.id);
    expect(copy).not.toBeNull();
    expect(copy!.id).not.toBe(original.id);
    expect(copy).toMatchObject({
      body: original.body,
      webhookId: "w1",
      state: "pending",
      attempts: 0,
      nextAttemptAt: START + 100,
      createdAt: START + 100,
      result: "",
      finishedAt: 0,
    });
    expect(deliveries(store)).toHaveLength(2);
    expect(watcher.resend(7, "fehlt")).toBeNull();
    expect(watcher.resend(8, original.id)).toBeNull();
  });

  it("test sends the sample payload without logging it", async () => {
    const { store, watcher, seen } = setup();
    const result = await watcher.test(7, "w1");
    expect(result).toEqual({ ok: true, status: 204, error: "" });
    expect((JSON.parse(String(seen[0].init.body)) as WebhookPayload).test).toBe(true);
    expect(deliveries(store)).toEqual([]);
  });

  it("baseline reads the current status", async () => {
    const { watcher } = setup();
    expect(await watcher.baseline(SESSION, 42)).toEqual({ statusId: 3, statusName: "Erledigt" });
  });
});
