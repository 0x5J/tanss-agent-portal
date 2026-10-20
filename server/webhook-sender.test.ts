import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Delivery } from "../shared/webhooks.ts";
import { afterAttempt, send, signature, type Fetcher } from "./webhook-sender.ts";

function delivery(partial: Partial<Delivery> = {}): Delivery {
  return {
    id: "d1",
    key: "k1",
    webhookId: "w1",
    webhookName: "Hook",
    url: "http://h",
    ticketId: 1,
    statusOld: "Neu",
    statusNew: "Erledigt",
    body: "{}",
    once: false,
    createdAt: 1000,
    attempts: 0,
    nextAttemptAt: 1000,
    state: "pending",
    result: "",
    finishedAt: 0,
    ...partial,
  };
}

const base = { url: "http://h", body: "{}", deliveryId: "d1", secret: "k", nowUnix: 1700000000 };

describe("webhook sender", () => {
  it("signs timestamp and body", () => {
    const expected = createHmac("sha256", "k").update('1700000000.{"a":1}').digest("hex");
    expect(signature("k", 1700000000, '{"a":1}')).toBe(`sha256=${expected}`);
  });

  it("posts JSON with delivery, timestamp and signature headers", async () => {
    const seen: RequestInit[] = [];
    const fetcher = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return new Response(null, { status: 204 });
    }) as unknown as Fetcher;
    const r = await send(fetcher, base);
    expect(r).toEqual({ ok: true, status: 204, error: "" });
    const h = new Headers(seen[0].headers);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].body).toBe("{}");
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("x-portal-delivery")).toBe("d1");
    expect(h.get("x-portal-timestamp")).toBe("1700000000");
    expect(h.get("x-portal-signature")).toBe(signature("k", 1700000000, "{}"));
  });

  it("omits the signature without a secret", async () => {
    const seen: RequestInit[] = [];
    const fetcher = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return new Response("", { status: 200 });
    }) as unknown as Fetcher;
    await send(fetcher, { ...base, secret: "" });
    const h = new Headers(seen[0].headers);
    expect(h.has("x-portal-signature")).toBe(false);
    expect(h.get("x-portal-timestamp")).toBe("1700000000");
  });

  it("a non-2xx answer and a thrown error are failures", async () => {
    const bad = (async () => new Response("", { status: 500 })) as unknown as Fetcher;
    expect(await send(bad, base)).toEqual({ ok: false, status: 500, error: "HTTP 500" });
    const redirect = (async () => new Response("", { status: 302 })) as unknown as Fetcher;
    expect(await send(redirect, base)).toEqual({ ok: false, status: 302, error: "HTTP 302" });
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as Fetcher;
    expect(await send(boom, base)).toEqual({ ok: false, status: 0, error: "ECONNREFUSED" });
  });

  it("does not follow redirects", async () => {
    const seen: RequestInit[] = [];
    const fetcher = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return new Response(null, { status: 301, headers: { location: "http://elsewhere" } });
    }) as unknown as Fetcher;
    expect(await send(fetcher, base)).toEqual({ ok: false, status: 301, error: "HTTP 301" });
    expect(seen[0].redirect).toBe("manual");
  });

  it("appends the cause of a thrown error", async () => {
    const withCode = (async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }) });
    }) as unknown as Fetcher;
    expect(await send(withCode, base)).toEqual({ ok: false, status: 0, error: "fetch failed (ECONNREFUSED)" });
    const withMessage = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("bad certificate") });
    }) as unknown as Fetcher;
    expect(await send(withMessage, base)).toEqual({ ok: false, status: 0, error: "fetch failed (bad certificate)" });
  });

  it("releases the response body", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => { cancelled = true; } });
    const fetcher = (async () => new Response(body, { status: 200 })) as unknown as Fetcher;
    expect((await send(fetcher, base)).ok).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("aborts a hanging call with a timeout message", async () => {
    const hanging = ((_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as Fetcher;
    const r = await send(hanging, { ...base, timeoutMs: 20 });
    expect(r).toEqual({ ok: false, status: 0, error: "Zeitlimit überschritten" });
  });

  it("retries after 30 s, then 120 s, then gives up", () => {
    const fail = { ok: false, status: 500, error: "HTTP 500" };
    const first = delivery({ state: "pending", attempts: 0 });
    let d = afterAttempt(first, fail, 1000);
    expect(first.attempts).toBe(0);
    expect(d).toMatchObject({ state: "pending", attempts: 1, nextAttemptAt: 1030, result: "HTTP 500" });
    d = afterAttempt(d, fail, 1030);
    expect(d).toMatchObject({ state: "pending", attempts: 2, nextAttemptAt: 1150 });
    d = afterAttempt(d, fail, 1150);
    expect(d).toMatchObject({ state: "failed", attempts: 3, result: "HTTP 500", finishedAt: 1150 });
  });

  it("success finishes with the status code as result", () => {
    const d = afterAttempt(delivery({ attempts: 1 }), { ok: true, status: 204, error: "" }, 2000);
    expect(d).toMatchObject({ state: "ok", attempts: 2, result: "204", finishedAt: 2000 });
  });
});
