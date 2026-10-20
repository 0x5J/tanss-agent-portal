import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEMPLATE,
  MAX_FINISHED_DELIVERIES,
  MAX_WEBHOOKS,
  matchesFilter,
  newId,
  parseDeliveries,
  parseLinks,
  parseWebhooks,
  toPublic,
  trimDeliveries,
  type Delivery,
} from "./webhooks.ts";

const delivery = (over: Partial<Delivery> = {}): Delivery => ({
  id: "d1",
  key: "w1:42:3",
  webhookId: "w1",
  webhookName: "n8n",
  url: "https://n8n.local/hook",
  ticketId: 42,
  statusOld: "Offen",
  statusNew: "Erledigt",
  body: "{}",
  once: false,
  createdAt: 1000,
  attempts: 0,
  nextAttemptAt: 1000,
  state: "pending",
  result: "",
  finishedAt: 0,
  ...over,
});

describe("parseWebhooks", () => {
  it("drops webhooks without name or with a non-http url", () => {
    const list = parseWebhooks([
      { id: "a", name: "n8n", url: "https://n8n.local/hook", statusFilter: [3], template: "{{json}}", secret: "s", active: true },
      { id: "b", name: "", url: "https://x" },
      { id: "c", name: "ftp", url: "ftp://x" },
    ]);
    expect(list.map((w) => w.id)).toEqual(["a"]);
    expect(list[0].trigger).toBe("status");
  });
  it("fills defaults for template and active", () => {
    const [w] = parseWebhooks([{ id: "a", name: "x", url: "http://h" }]);
    expect(w.template).toBe(DEFAULT_TEMPLATE);
    expect(w.active).toBe(true);
    expect(w.statusFilter).toEqual([]);
    expect(w.secret).toBe("");
    expect(parseWebhooks([{ id: "a", name: "x", url: "http://h", active: false }])[0].active).toBe(false);
  });
  it("assigns an id when missing and survives garbage", () => {
    expect(parseWebhooks("nope")).toEqual([]);
    expect(parseWebhooks([null, 5, "x"])).toEqual([]);
    const [w] = parseWebhooks([{ name: "x", url: "http://h" }]);
    expect(w.id).not.toBe("");
  });
  it("keeps only positive integer status ids", () => {
    const [w] = parseWebhooks([{ id: "a", name: "x", url: "http://h", statusFilter: [3, "4", 0, -1, 2.5, "x", null] }]);
    expect(w.statusFilter).toEqual([3, 4]);
  });
  it("caps the list at MAX_WEBHOOKS", () => {
    const many = Array.from({ length: MAX_WEBHOOKS + 10 }, (_, i) => ({ id: `w${i}`, name: "n", url: "http://h" }));
    expect(parseWebhooks(many)).toHaveLength(MAX_WEBHOOKS);
  });
});

describe("toPublic / matchesFilter", () => {
  it("toPublic hides the secret", () => {
    const [w] = parseWebhooks([{ id: "a", name: "x", url: "http://10.0.0.5/h", secret: "geheim" }]);
    expect(toPublic(w)).not.toHaveProperty("secret");
    expect(toPublic(w).hasSecret).toBe(true);
    const [n] = parseWebhooks([{ id: "b", name: "x", url: "http://h" }]);
    expect(toPublic(n).hasSecret).toBe(false);
  });
  it("empty filter matches every status, otherwise only listed ones", () => {
    const [all, some] = parseWebhooks([
      { id: "a", name: "a", url: "http://h" },
      { id: "b", name: "b", url: "http://h", statusFilter: [5] },
    ]);
    expect(matchesFilter(all, 9)).toBe(true);
    expect(matchesFilter(some, 9)).toBe(false);
    expect(matchesFilter(some, 5)).toBe(true);
  });
});

describe("parseLinks", () => {
  it("drops entries without webhook or ticket and fills defaults", () => {
    const list = parseLinks([
      { webhookId: "a", ticketId: 7, once: true, lastStatusId: 3, lastStatusName: "Offen", checkedAt: 99 },
      { webhookId: "", ticketId: 7 },
      { webhookId: "a", ticketId: 0 },
      { webhookId: "a", ticketId: 8 },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ webhookId: "a", ticketId: 7, once: true, lastStatusId: 3, lastStatusName: "Offen", checkedAt: 99 });
    expect(list[1]).toEqual({ webhookId: "a", ticketId: 8, once: false, lastStatusId: 0, lastStatusName: "", checkedAt: 0 });
    expect(parseLinks({})).toEqual([]);
  });
});

describe("parseDeliveries", () => {
  it("round-trips a valid delivery and drops broken ones", () => {
    const d = delivery({ state: "failed", attempts: 3, result: "HTTP 500", finishedAt: 5 });
    const list = parseDeliveries([d, { id: "" }, null, { ...d, id: "x", state: "weird" }]);
    expect(list[0]).toEqual(d);
    expect(list.map((x) => x.id)).toEqual(["d1"]);
    expect(parseDeliveries(undefined)).toEqual([]);
  });
});

describe("trimDeliveries", () => {
  it("keeps every pending and the newest 200 finished", () => {
    const finished = Array.from({ length: 250 }, (_, i) => delivery({ id: `f${i}`, state: "ok", finishedAt: i }));
    const out = trimDeliveries([delivery({ id: "p", state: "pending" }), ...finished]);
    expect(MAX_FINISHED_DELIVERIES).toBe(200);
    expect(out.filter((d) => d.state === "pending")).toHaveLength(1);
    expect(out.filter((d) => d.state !== "pending")).toHaveLength(200);
    expect(out.some((d) => d.id === "f249")).toBe(true);
    expect(out.some((d) => d.id === "f0")).toBe(false);
  });
});

describe("newId", () => {
  it("returns unique ids", () => {
    expect(newId()).not.toBe(newId());
  });
});
