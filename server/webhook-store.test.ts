import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileStore, createMemoryStore, type Store } from "./store.ts";
import type { Delivery, Webhook, WebhookLink } from "../shared/webhooks.ts";

const hook = (over: Partial<Webhook> = {}): Webhook => ({
  id: "w1",
  name: "Chat",
  url: "https://example.test/hook",
  trigger: "status",
  auth: "signature",
  headerName: "",
  statusFilter: [3],
  template: "{{json}}",
  secret: "geheim",
  active: true,
  ...over,
});
const link = (over: Partial<WebhookLink> = {}): WebhookLink => ({
  webhookId: "w1",
  ticketId: 42,
  once: false,
  lastStatusId: 2,
  lastStatusName: "Offen",
  checkedAt: 1_700_000_000,
  ...over,
});
const delivery = (over: Partial<Delivery> = {}): Delivery => ({
  id: "d1",
  key: "w1|42|3|1",
  webhookId: "w1",
  webhookName: "Chat",
  url: "https://example.test/hook",
  ticketId: 42,
  statusOld: "Offen",
  statusNew: "Erledigt",
  body: "{}",
  once: false,
  createdAt: 1,
  attempts: 0,
  nextAttemptAt: 0,
  state: "pending",
  result: "",
  finishedAt: 0,
  ...over,
});

function behavesLikeAStore(make: () => Store) {
  it("keeps webhooks, links and deliveries apart per employee", () => {
    const store = make();
    store.setWebhooks(7, [hook()]);
    store.setWebhookLinks(7, [link()]);
    store.setWebhookDeliveries(7, [delivery()]);
    expect(store.webhooks(7)).toEqual([hook()]);
    expect(store.webhookLinks(7)).toEqual([link()]);
    expect(store.webhookDeliveries(7)).toEqual([delivery()]);
    expect(store.webhooks(8)).toEqual([]);
    expect(store.webhookLinks(8)).toEqual([]);
    expect(store.webhookDeliveries(8)).toEqual([]);
  });

  it("returns copies the caller cannot use to change stored state", () => {
    const store = make();
    store.setWebhooks(7, [hook()]);
    store.setWebhookLinks(7, [link()]);
    store.setWebhookDeliveries(7, [delivery()]);
    store.webhooks(7)[0].name = "changed";
    store.webhooks(7)[0].statusFilter.push(99);
    store.webhookLinks(7)[0].ticketId = 1;
    store.webhookDeliveries(7)[0].state = "ok";
    store.webhooks(7).push(hook({ id: "w2" }));
    expect(store.webhooks(7)).toEqual([hook()]);
    expect(store.webhookLinks(7)).toEqual([link()]);
    expect(store.webhookDeliveries(7)).toEqual([delivery()]);
  });

  it("does not let the caller's list change what was stored", () => {
    const store = make();
    const list = [hook()];
    store.setWebhooks(7, list);
    list[0].name = "changed";
    list.push(hook({ id: "w2" }));
    expect(store.webhooks(7)).toEqual([hook()]);
  });

  it("keeps all open deliveries and only the newest 200 finished ones", () => {
    const store = make();
    const finished = Array.from({ length: 250 }, (_, i) =>
      delivery({ id: `f${i}`, state: "ok", finishedAt: i + 1 }),
    );
    store.setWebhookDeliveries(7, [delivery({ id: "open" }), ...finished]);
    const stored = store.webhookDeliveries(7);
    expect(stored.filter((d) => d.state === "ok")).toHaveLength(200);
    expect(stored.some((d) => d.id === "open")).toBe(true);
    expect(stored.some((d) => d.id === "f0")).toBe(false);
    expect(stored.some((d) => d.id === "f249")).toBe(true);
  });
}

describe("webhook storage in the memory store", () => {
  behavesLikeAStore(createMemoryStore);
});

describe("webhook storage in the file store", () => {
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(path.join(tmpdir(), "webhooks-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  behavesLikeAStore(() => {
    const dir = mkdtempSync(path.join(tmpdir(), "webhooks-"));
    dirs.push(dir);
    return createFileStore(dir);
  });

  it("reads the same data after a restart", () => {
    withDir((dir) => {
      const store = createFileStore(dir);
      store.setWebhooks(7, [hook()]);
      store.setWebhookLinks(7, [link()]);
      store.setWebhookDeliveries(7, [delivery()]);
      store.setWebhooks(9, [hook({ id: "w9" })]);
      const again = createFileStore(dir);
      expect(again.webhooks(7)).toEqual([hook()]);
      expect(again.webhooks(9)).toEqual([hook({ id: "w9" })]);
      expect(again.webhookLinks(7)).toEqual([link()]);
      expect(again.webhookDeliveries(7)).toEqual([delivery()]);
      expect(again.webhooks(8)).toEqual([]);
    });
  });

  it("keeps a long template unchanged across a restart", () => {
    withDir((dir) => {
      const template = `{"text":"${"a".repeat(19_000)}"}`;
      createFileStore(dir).setWebhooks(7, [hook({ template })]);
      expect(createFileStore(dir).webhooks(7)[0]!.template).toBe(template);
    });
  });

  it("writes webhooks.json with mode 600, since it holds secrets", () => {
    withDir((dir) => {
      createFileStore(dir).setWebhooks(7, [hook()]);
      expect(statSync(path.join(dir, "webhooks.json")).mode & 0o777).toBe(0o600);
    });
  });

  it("writes links and deliveries with mode 600 too", () => {
    withDir((dir) => {
      const store = createFileStore(dir);
      store.setWebhookLinks(7, [link()]);
      store.setWebhookDeliveries(7, [delivery()]);
      expect(statSync(path.join(dir, "webhook-links.json")).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(dir, "webhook-deliveries.json")).mode & 0o777).toBe(0o600);
    });
  });

  it("trims the log on disk, not only in memory", () => {
    withDir((dir) => {
      const finished = Array.from({ length: 250 }, (_, i) =>
        delivery({ id: `f${i}`, state: "failed", finishedAt: i + 1 }),
      );
      createFileStore(dir).setWebhookDeliveries(7, finished);
      expect(createFileStore(dir).webhookDeliveries(7)).toHaveLength(200);
    });
  });
});
