import { createHmac } from "node:crypto";
import type { Delivery } from "../shared/webhooks.ts";

export type Fetcher = typeof fetch;
export type SendResult = { ok: boolean; status: number; error: string };

export const SEND_TIMEOUT_MS = 10_000;
/** Waits before the second and third attempt. */
export const RETRY_DELAYS_S = [30, 120];

/** HMAC-SHA256 over "<timestamp>.<body>", as "sha256=<hex>". */
export function signature(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause: unknown = e.cause;
  if (typeof cause === "object" && cause !== null) {
    const { code, message } = cause as { code?: unknown; message?: unknown };
    const detail = typeof code === "string" && code ? code : typeof message === "string" ? message : "";
    if (detail) return `${e.message} (${detail})`;
  }
  return e.message;
}

/** One call to the target. Never throws: every failure becomes a result. */
export async function send(
  fetcher: Fetcher,
  opts: { url: string; body: string; deliveryId: string; secret: string; nowUnix: number; timeoutMs?: number },
): Promise<SendResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Portal-Delivery": opts.deliveryId,
    "X-Portal-Timestamp": String(opts.nowUnix),
  };
  if (opts.secret) headers["X-Portal-Signature"] = signature(opts.secret, opts.nowUnix, opts.body);
  try {
    const res = await fetcher(opts.url, {
      method: "POST",
      headers,
      body: opts.body,
      // A redirect would turn the call into a body-less GET; treat it as a failure.
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_TIMEOUT_MS),
    });
    void res.body?.cancel().catch(() => {});
    if (res.ok) return { ok: true, status: res.status, error: "" };
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, status: 0, error: "Zeitlimit überschritten" };
    }
    return { ok: false, status: 0, error: errorText(e) };
  }
}

/** Next state after an attempt; attempts counts this one. */
export function afterAttempt(d: Delivery, r: SendResult, nowUnix: number): Delivery {
  const attempts = d.attempts + 1;
  if (r.ok) return { ...d, attempts, state: "ok", result: String(r.status), finishedAt: nowUnix };
  if (attempts <= RETRY_DELAYS_S.length) {
    return { ...d, attempts, state: "pending", result: r.error, nextAttemptAt: nowUnix + RETRY_DELAYS_S[attempts - 1] };
  }
  return { ...d, attempts, state: "failed", result: r.error, finishedAt: nowUnix };
}
