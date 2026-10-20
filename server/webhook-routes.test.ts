import { describe, expect, it } from "vitest";
import type { Delivery } from "../shared/webhooks.ts";
import { buildApp } from "./app.ts";
import { createSharedSession } from "./shared-session.ts";
import { createMemoryStore } from "./store.ts";
import { TanssError, type TanssClient } from "./tanss.ts";
import type { Fetcher } from "./webhook-sender.ts";
import { createWebhookWatcher } from "./webhook-watcher.ts";

const SECRET = "x".repeat(32);
const SESSION = { employeeId: 7, apiKey: "Bearer a", refresh: "Bearer r", expire: 9_999_999_999 };

async function setup(options: { statusOf?: (ticketId: number) => number; failTicket?: boolean } = {}) {
  let loginAs = 7;
  const state = { statusId: 2, failTicket: options.failTicket ?? false, failStatus: 502, updates: 0 };
  const ticketCalls: number[] = [];
  const client = {
    login: async () => ({ ...SESSION, employeeId: loginAs }),
    ticketById: async (_s: unknown, id: number) => {
      ticketCalls.push(id);
      if (state.failTicket) throw new TanssError("Nicht erreichbar", state.failStatus);
      return {
        item: { id, title: "Drucker", statusId: state.statusId, companyId: 5 },
        linked: {
          ticketStates: { "2": { name: "Neu" }, "3": { name: "Erledigt" }, "4": { name: "Wartet" } },
          companies: { "5": { name: "Kunde" } },
        },
      };
    },
    ticketHistory: async () => ({ content: { comments: [], supports: [], mails: [] }, linked: {} }),
    updateTicket: async () => {
      state.updates += 1;
      return {};
    },
    technicians: async () => [{ id: 7, name: "Ich" }],
  } as unknown as TanssClient;

  const store = createMemoryStore();
  const shared = createSharedSession({ store });
  const sent: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(null, { status: 204 });
  }) as unknown as Fetcher;
  const watcher = createWebhookWatcher({ tanss: client, store, shared, ticketUrl: "", fetcher });
  const noted: unknown[][] = [];
  const realNote = watcher.notePortalChange;
  watcher.notePortalChange = (...args) => {
    noted.push(args);
    realNote(...args);
  };
  const app = await buildApp({ sessionSecret: SECRET, tanss: client, enableRateLimit: false, store, shared, webhooks: watcher, totp: null });

  async function login(employeeId: number): Promise<string> {
    loginAs = employeeId;
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "sb", password: "pw", token: "123456" } });
    const cookie = res.headers["set-cookie"];
    return Array.isArray(cookie) ? cookie[0]! : String(cookie ?? "");
  }
  const call = (cookie: string, method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { app, store, watcher, state, sent, noted, ticketCalls, login, call };
}

const hookBody = { name: "Teams", url: "https://hook.example/a", secret: "geheim" };

describe("webhook routes", () => {
  it("round-trips a webhook without ever returning the secret", async () => {
    const { login, call, store } = await setup();
    const cookie = await login(7);

    const created = await call(cookie, "POST", "/me/webhooks", { ...hookBody, id: "mine", statusFilter: [3] });
    expect(created.statusCode).toBe(200);
    const w = created.json().webhook;
    expect(w.id).not.toBe("mine");
    expect(w).toMatchObject({ name: "Teams", url: "https://hook.example/a", statusFilter: [3], hasSecret: true, active: true, template: "{{json}}" });
    expect(created.body).not.toContain("geheim");
    expect(store.webhooks(7)[0]!.secret).toBe("geheim");

    const list = await call(cookie, "GET", "/me/webhooks");
    expect(list.json().webhooks).toHaveLength(1);
    expect(list.body).not.toContain("geheim");

    // secret missing keeps it, "" removes it
    const kept = await call(cookie, "PUT", `/me/webhooks/${w.id}`, { name: "Neu", url: "https://hook.example/b" });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().webhook).toMatchObject({ name: "Neu", url: "https://hook.example/b", hasSecret: true });
    expect(store.webhooks(7)[0]!.secret).toBe("geheim");
    const removed = await call(cookie, "PUT", `/me/webhooks/${w.id}`, { name: "Neu", url: "https://hook.example/b", secret: "" });
    expect(removed.json().webhook.hasSecret).toBe(false);
    expect(store.webhooks(7)[0]!.secret).toBe("");

    const del = await call(cookie, "DELETE", `/me/webhooks/${w.id}`);
    expect(del.json()).toEqual({ ok: true });
    expect((await call(cookie, "GET", "/me/webhooks")).json().webhooks).toEqual([]);
  });

  it("stores the auth mode, trims a pasted secret and shows only its hint", async () => {
    const { login, call, store } = await setup();
    const cookie = await login(7);
    const token = "tok_abcdefghijklmnopqrstuvwxyz";
    const created = await call(cookie, "POST", "/me/webhooks", { ...hookBody, auth: "bearer", secret: `  ${token}\n` });
    expect(created.statusCode).toBe(200);
    expect(created.json().webhook).toMatchObject({ auth: "bearer", headerName: "", hasSecret: true, secretHint: "tok_…yz (30 Zeichen)" });
    expect(created.body).not.toContain(token);
    expect(store.webhooks(7)[0]!.secret).toBe(token);

    const id = created.json().webhook.id as string;
    const header = await call(cookie, "PUT", `/me/webhooks/${id}`, { ...hookBody, auth: "header", headerName: "X-Api-Key" });
    expect(header.json().webhook).toMatchObject({ auth: "header", headerName: "X-Api-Key" });
    // hookBody carries a secret, so it replaces the token
    expect(store.webhooks(7)[0]!.secret).toBe("geheim");

    expect((await call(cookie, "PUT", `/me/webhooks/${id}`, { ...hookBody, auth: "header", headerName: "X-Portal-Signature" })).statusCode).toBe(400);
    expect((await call(cookie, "PUT", `/me/webhooks/${id}`, { ...hookBody, auth: "header", headerName: "" })).statusCode).toBe(400);
    expect((await call(cookie, "POST", "/me/webhooks", { ...hookBody, auth: "basic" })).statusCode).toBe(400);
    // a mode other than "header" forgets the header name
    const back = await call(cookie, "PUT", `/me/webhooks/${id}`, { ...hookBody, auth: "signature" });
    expect(back.json().webhook).toMatchObject({ auth: "signature", headerName: "" });
  });

  it("refuses a secret of only whitespace instead of dropping the stored one", async () => {
    const { login, call, store } = await setup();
    const cookie = await login(7);
    const id = (await call(cookie, "POST", "/me/webhooks", { ...hookBody, auth: "bearer" })).json().webhook.id as string;
    for (const blank of [" ", "\n", " \t\r\n "]) {
      const res = await call(cookie, "PUT", `/me/webhooks/${id}`, { name: "Teams", url: "https://hook.example/a", secret: blank });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Der eingetragene Wert besteht nur aus Leerzeichen");
    }
    expect((await call(cookie, "POST", "/me/webhooks", { ...hookBody, secret: "  " })).statusCode).toBe(400);
    expect(store.webhooks(7)[0]!.secret).toBe("geheim");
    // an explicit empty string still removes it
    await call(cookie, "PUT", `/me/webhooks/${id}`, { name: "Teams", url: "https://hook.example/a", secret: "" });
    expect(store.webhooks(7)[0]!.secret).toBe("");
  });

  it("keeps every omitted optional field on PUT", async () => {
    const { login, call, store } = await setup();
    const cookie = await login(7);
    const template = '{"t":"{{ticket.title}}"}';
    const id = (
      await call(cookie, "POST", "/me/webhooks", { ...hookBody, template, statusFilter: [3, 4], active: false })
    ).json().webhook.id as string;
    const res = await call(cookie, "PUT", `/me/webhooks/${id}`, { name: "Neu", url: "https://hook.example/b" });
    expect(res.statusCode).toBe(200);
    expect(store.webhooks(7)[0]).toMatchObject({
      name: "Neu",
      url: "https://hook.example/b",
      template,
      statusFilter: [3, 4],
      secret: "geheim",
      active: false,
    });
    // fields that are sent do replace
    await call(cookie, "PUT", `/me/webhooks/${id}`, { name: "Neu", url: "https://hook.example/b", statusFilter: [], template: "{{json}}" });
    expect(store.webhooks(7)[0]).toMatchObject({ template: "{{json}}", statusFilter: [] });
  });

  it("requires a login", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/me/webhooks" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/me/webhooks/deliveries" })).statusCode).toBe(401);
  });

  it("rejects invalid input", async () => {
    const { login, call } = await setup();
    const cookie = await login(7);
    const post = (body: unknown) => call(cookie, "POST", "/me/webhooks", body);
    expect((await post({ ...hookBody, name: "" })).statusCode).toBe(400);
    expect((await post({ ...hookBody, name: "x".repeat(81) })).statusCode).toBe(400);
    expect((await post({ ...hookBody, url: "ftp://hook.example" })).statusCode).toBe(400);
    expect((await post({ ...hookBody, url: "kein url" })).statusCode).toBe(400);
    expect((await post({ ...hookBody, url: "https://user:pass@hook.example/a" })).statusCode).toBe(400);
    expect((await post({ ...hookBody, url: "https://user@hook.example/a" })).statusCode).toBe(400);
    expect((await post({ ...hookBody, statusFilter: [1.5] })).statusCode).toBe(400);
    expect((await post({ ...hookBody, secret: "s".repeat(2001) })).statusCode).toBe(400);
    const badTemplate = await post({ ...hookBody, template: "{{gibtsnicht}}" });
    expect(badTemplate.statusCode).toBe(400);
    expect(badTemplate.json().error).toBe("Unbekannter Platzhalter: {{gibtsnicht}}");
    const notJson = await post({ ...hookBody, template: "hallo" });
    expect(notJson.statusCode).toBe(400);
    expect(notJson.json().error).toBe("Die Vorlage ergibt kein gültiges JSON");
  });

  it("limits the number of webhooks", async () => {
    const { login, call } = await setup();
    const cookie = await login(7);
    for (let i = 0; i < 50; i += 1) {
      expect((await call(cookie, "POST", "/me/webhooks", { name: `h${i}`, url: "https://h.example" })).statusCode).toBe(200);
    }
    expect((await call(cookie, "POST", "/me/webhooks", { name: "zu viel", url: "https://h.example" })).statusCode).toBe(400);
  });

  it("attaches with the baseline from the ticket, refuses a duplicate, detaches", async () => {
    const { login, call, store } = await setup();
    const cookie = await login(7);
    const id = (await call(cookie, "POST", "/me/webhooks", hookBody)).json().webhook.id as string;

    const attached = await call(cookie, "POST", "/me/tickets/42/webhooks", { webhookId: id, once: true });
    expect(attached.statusCode).toBe(200);
    expect(attached.json().link).toMatchObject({ webhookId: id, ticketId: 42, once: true, lastStatusId: 2, lastStatusName: "Neu" });
    expect(attached.json().link.checkedAt).toBeGreaterThan(0);
    expect(store.webhookLinks(7)).toHaveLength(1);

    const again = await call(cookie, "POST", "/me/tickets/42/webhooks", { webhookId: id, once: false });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("Dieser Webhook hängt schon an dem Ticket");

    const listed = await call(cookie, "GET", "/me/tickets/42/webhooks");
    expect(listed.json().links).toHaveLength(1);
    expect((await call(cookie, "GET", "/me/tickets/43/webhooks")).json().links).toEqual([]);

    expect((await call(cookie, "DELETE", `/me/tickets/42/webhooks/${id}`)).json()).toEqual({ ok: true });
    expect(store.webhookLinks(7)).toEqual([]);

    // own webhook, but not attached to that ticket: 404 as well
    const notAttached = await call(cookie, "DELETE", `/me/tickets/42/webhooks/${id}`);
    expect(notAttached.statusCode).toBe(404);
    expect(notAttached.json().error).toBe("Webhook nicht gefunden");
    const missing = await call(cookie, "DELETE", "/me/tickets/42/webhooks/nope");
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("Webhook nicht gefunden");

    const unknown = await call(cookie, "POST", "/me/tickets/42/webhooks", { webhookId: "nope", once: false });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe("Webhook nicht gefunden");
  });

  it("lists how many tickets each webhook hangs on, counting only its own links", async () => {
    const { login, call } = await setup();
    const cookie = await login(7);
    const a = (await call(cookie, "POST", "/me/webhooks", hookBody)).json().webhook;
    const b = (await call(cookie, "POST", "/me/webhooks", { ...hookBody, name: "Zweiter" })).json().webhook;
    expect(a.linkCount).toBe(0);
    await call(cookie, "POST", "/me/tickets/42/webhooks", { webhookId: a.id, once: false });
    await call(cookie, "POST", "/me/tickets/43/webhooks", { webhookId: a.id, once: true });
    await call(cookie, "POST", "/me/tickets/42/webhooks", { webhookId: b.id, once: false });

    const counts = Object.fromEntries(
      (await call(cookie, "GET", "/me/webhooks")).json().webhooks.map((w: { name: string; linkCount: number }) => [w.name, w.linkCount]),
    );
    expect(counts).toEqual({ Teams: 2, Zweiter: 1 });
    const updated = await call(cookie, "PUT", `/me/webhooks/${a.id}`, { name: "Teams", url: "https://hook.example/a" });
    expect(updated.json().webhook.linkCount).toBe(2);

    const other = await login(8);
    const mine = (await call(other, "POST", "/me/webhooks", hookBody)).json().webhook;
    expect(mine.linkCount).toBe(0);
  });

  it("deleting a webhook releases its links", async () => {
    const { login, call, store } = await setup();
    const cookie = await login(7);
    const id = (await call(cookie, "POST", "/me/webhooks", hookBody)).json().webhook.id as string;
    await call(cookie, "POST", "/me/tickets/42/webhooks", { webhookId: id, once: false });
    await call(cookie, "POST", "/me/tickets/43/webhooks", { webhookId: id, once: false });
    await call(cookie, "DELETE", `/me/webhooks/${id}`);
    expect(store.webhookLinks(7)).toEqual([]);
  });

  it("keeps technician 8 away from the webhooks of technician 7", async () => {
    const { login, call, store } = await setup();
    const c7 = await login(7);
    const id = (await call(c7, "POST", "/me/webhooks", hookBody)).json().webhook.id as string;
    await call(c7, "POST", "/me/tickets/42/webhooks", { webhookId: id, once: false });
    const delivery: Delivery = {
      id: "d1", key: "k", webhookId: id, webhookName: "Teams", url: "https://hook.example/a", ticketId: 42,
      statusOld: "Neu", statusNew: "Erledigt", body: "{}", once: false, createdAt: 1, attempts: 1, nextAttemptAt: 1,
      state: "ok", result: "204", finishedAt: 1,
    };
    store.setWebhookDeliveries(7, [delivery]);

    const c8 = await login(8);
    expect((await call(c8, "GET", "/me/webhooks")).json().webhooks).toEqual([]);
    expect((await call(c8, "GET", "/me/webhooks/deliveries")).json().deliveries).toEqual([]);
    expect((await call(c8, "GET", "/me/tickets/42/webhooks")).json().links).toEqual([]);
    for (const [method, url, body] of [
      ["PUT", `/me/webhooks/${id}`, hookBody],
      ["DELETE", `/me/webhooks/${id}`, undefined],
      ["POST", `/me/webhooks/${id}/test`, undefined],
      ["POST", "/me/tickets/42/webhooks", { webhookId: id, once: false }],
      ["DELETE", `/me/tickets/42/webhooks/${id}`, undefined],
    ] as const) {
      const res = await call(c8, method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json().error).toBe("Webhook nicht gefunden");
    }
    const resend = await call(c8, "POST", "/me/webhooks/deliveries/d1/resend");
    expect(resend.statusCode).toBe(404);
    expect(resend.json().error).toBe("Zustellung nicht gefunden");
    expect(store.webhooks(7)).toHaveLength(1);
    expect(store.webhookLinks(7)).toHaveLength(1);
    expect(store.webhookDeliveries(7)).toHaveLength(1);
  });

  it("lists deliveries newest first without the body, and resends", async () => {
    const { login, call, store } = await setup();
    const cookie = await login(7);
    const base: Delivery = {
      id: "a", key: "ka", webhookId: "w", webhookName: "Teams", url: "https://hook.example/a", ticketId: 1,
      statusOld: "Neu", statusNew: "Erledigt", body: '{"x":1}', once: false, createdAt: 100, attempts: 1, nextAttemptAt: 100,
      state: "failed", result: "500", finishedAt: 100,
    };
    store.setWebhookDeliveries(7, [base, { ...base, id: "b", key: "kb", createdAt: 300 }, { ...base, id: "c", key: "kc", createdAt: 200 }]);
    const list = (await call(cookie, "GET", "/me/webhooks/deliveries")).json().deliveries as Delivery[];
    expect(list.map((d) => d.id)).toEqual(["b", "c", "a"]);
    expect(list.every((d) => !("body" in d))).toBe(true);

    const resent = await call(cookie, "POST", "/me/webhooks/deliveries/a/resend");
    expect(resent.statusCode).toBe(200);
    expect(resent.json().delivery).toMatchObject({ state: "pending", ticketId: 1 });
    expect(resent.json().delivery.id).not.toBe("a");
    expect(store.webhookDeliveries(7)).toHaveLength(4);
    expect((await call(cookie, "POST", "/me/webhooks/deliveries/zzz/resend")).statusCode).toBe(404);
  });

  it("marks only finished deliveries with a body as resendable, and refuses to resend a pending one", async () => {
    const { login, call, store } = await setup();
    const cookie = await login(7);
    const base: Delivery = {
      id: "ok", key: "k1", webhookId: "w", webhookName: "Teams", url: "https://hook.example/a", ticketId: 1,
      statusOld: "Neu", statusNew: "Erledigt", body: '{"x":1}', once: false, createdAt: 500, attempts: 1, nextAttemptAt: 100,
      state: "ok", result: "204", finishedAt: 100,
    };
    store.setWebhookDeliveries(7, [
      base,
      { ...base, id: "pending", key: "k2", createdAt: 400, state: "pending", finishedAt: 0 },
      { ...base, id: "gone", key: "k3", createdAt: 300, body: "", state: "failed", attempts: 0, result: "Ticket nicht mehr abrufbar – Verknüpfung entfernt" },
      { ...base, id: "failed", key: "k4", createdAt: 200, state: "failed", result: "HTTP 500" },
    ]);
    const list = (await call(cookie, "GET", "/me/webhooks/deliveries")).json().deliveries as (Delivery & { resendable: boolean })[];
    expect(Object.fromEntries(list.map((d) => [d.id, d.resendable]))).toEqual({ ok: true, pending: false, gone: false, failed: true });
    expect(list.every((d) => !("body" in d))).toBe(true);

    const running = await call(cookie, "POST", "/me/webhooks/deliveries/pending/resend");
    expect(running.statusCode).toBe(409);
    expect(running.json().error).toBe("Diese Zustellung läuft noch");
    expect((await call(cookie, "POST", "/me/webhooks/deliveries/gone/resend")).statusCode).toBe(404);
    expect(store.webhookDeliveries(7)).toHaveLength(4);
  });

  it("sends a test call", async () => {
    const { login, call, sent } = await setup();
    const cookie = await login(7);
    const id = (await call(cookie, "POST", "/me/webhooks", hookBody)).json().webhook.id as string;
    const res = await call(cookie, "POST", `/me/webhooks/${id}/test`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: 204 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://hook.example/a");
  });

  it("tells the watcher about a status change made in the portal", async () => {
    const { login, call, noted, state } = await setup();
    const cookie = await login(7);
    const before = Math.floor(Date.now() / 1000);

    expect((await call(cookie, "PATCH", "/me/tickets/42", { statusId: 3 })).statusCode).toBe(200);
    expect(noted).toHaveLength(1);
    expect(noted[0]![0]).toBe(7);
    expect(noted[0]![1]).toBe(42);
    expect(noted[0]![2] as number).toBeGreaterThanOrEqual(before);

    // same status as before, or no status in the patch: nothing to note
    await call(cookie, "PATCH", "/me/tickets/42", { statusId: 2 });
    await call(cookie, "PATCH", "/me/tickets/42", { assignedToEmployeeId: 7 });
    expect(noted).toHaveLength(1);
    expect(state.updates).toBe(3);
  });

  it("sets the baseline anew when a webhook is switched on again", async () => {
    const { login, call, state, watcher, store, sent } = await setup();
    const cookie = await login(7);
    const id = (await call(cookie, "POST", "/me/webhooks", { name: "Teams", url: "https://hook.example/a" })).json().webhook.id as string;
    await call(cookie, "POST", "/me/tickets/42/webhooks", { webhookId: id, once: false });
    const put = (active: boolean) =>
      call(cookie, "PUT", `/me/webhooks/${id}`, { name: "Teams", url: "https://hook.example/a", active });

    expect((await put(false)).json().webhook.active).toBe(false);
    state.statusId = 3; // changes while the webhook is off
    expect((await put(true)).json().webhook.active).toBe(true);
    expect(store.webhookLinks(7)[0]).toMatchObject({ lastStatusId: 3, lastStatusName: "Erledigt" });

    await watcher.check();
    await watcher.flush();
    expect(store.webhookDeliveries(7)).toEqual([]);
    expect(sent).toEqual([]);

    // a change after reactivation is still caught
    state.statusId = 4;
    await watcher.check();
    expect(store.webhookDeliveries(7)).toHaveLength(1);
  });

  it("lets the next check take the baseline when it cannot be fetched on reactivation", async () => {
    const { login, call, state, store, watcher, sent } = await setup();
    const cookie = await login(7);
    const id = (await call(cookie, "POST", "/me/webhooks", { name: "Teams", url: "https://hook.example/a" })).json().webhook.id as string;
    await call(cookie, "POST", "/me/tickets/42/webhooks", { webhookId: id, once: false });
    const link = store.webhookLinks(7)[0]!;
    const put = (active: boolean) =>
      call(cookie, "PUT", `/me/webhooks/${id}`, { name: "Teams", url: "https://hook.example/a", active });
    await put(false);
    state.statusId = 3; // changes while the webhook is off
    state.failTicket = true;
    const res = await put(true);
    expect(res.statusCode).toBe(200);
    expect(res.json().webhook.active).toBe(true);
    expect(store.webhookLinks(7)[0]).toEqual({ ...link, rebaseline: true });

    // TANSS answers again: the first check only takes the current status, it sends nothing
    state.failTicket = false;
    await watcher.check();
    await watcher.flush();
    expect(store.webhookDeliveries(7)).toEqual([]);
    expect(sent).toEqual([]);
    expect(store.webhookLinks(7)[0]).toMatchObject({ lastStatusId: 3, lastStatusName: "Erledigt" });
    expect(store.webhookLinks(7)[0]).not.toHaveProperty("rebaseline");

    // a change after that is caught as usual
    state.statusId = 4;
    await watcher.check();
    expect(store.webhookDeliveries(7)).toHaveLength(1);
  });

  it("passes a 401 during reactivation on and saves nothing", async () => {
    const { login, call, state, store } = await setup();
    const cookie = await login(7);
    const id = (await call(cookie, "POST", "/me/webhooks", { name: "Teams", url: "https://hook.example/a" })).json().webhook.id as string;
    await call(cookie, "POST", "/me/tickets/42/webhooks", { webhookId: id, once: false });
    const put = (active: boolean) =>
      call(cookie, "PUT", `/me/webhooks/${id}`, { name: "Teams", url: "https://hook.example/a", active });
    await put(false);
    const link = store.webhookLinks(7)[0]!;
    state.failTicket = true;
    state.failStatus = 401;
    const res = await put(true);
    expect(res.statusCode).toBe(401);
    expect(store.webhooks(7)[0]!.active).toBe(false);
    expect(store.webhookLinks(7)[0]).toEqual(link);
  });
});
