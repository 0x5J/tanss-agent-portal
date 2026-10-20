import { createHmac } from "node:crypto";
import { secretHint, type Delivery, type WebhookAuth } from "../shared/webhooks.ts";

export type Fetcher = typeof fetch;
export type SendResult = { ok: boolean; status: number; error: string };

/**
 * One call as it went out and came back — for the log. The secret is never
 * in it: a bearer token or auth header shows only its hint.
 */
export type WebhookCall = {
  url: string;
  headers: Record<string, string>;
  body: string;
  ok: boolean;
  status: number;
  durationMs: number;
  /** What the receiver answered, cut to a readable length. */
  response: string;
  error: string;
};

/** Longest answer kept for the log; the error line quotes less. */
const MAX_RESPONSE = 2000;
const MAX_QUOTE = 200;

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

/**
 * The headers of one call: ours, plus how the receiver recognises the portal.
 * `shown` is the same set for the log, with the secret replaced by its hint.
 */
export function callHeaders(opts: {
  body: string;
  deliveryId: string;
  secret: string;
  nowUnix: number;
  auth: WebhookAuth;
  headerName: string;
}): { sent: Record<string, string>; shown: Record<string, string> } {
  const sent: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Portal-Delivery": opts.deliveryId,
    "X-Portal-Timestamp": String(opts.nowUnix),
  };
  const shown = { ...sent };
  if (!opts.secret) return { sent, shown };
  if (opts.auth === "bearer") {
    sent.Authorization = `Bearer ${opts.secret}`;
    shown.Authorization = `Bearer ${secretHint(opts.secret)}`;
  } else if (opts.auth === "header" && opts.headerName) {
    sent[opts.headerName] = opts.secret;
    shown[opts.headerName] = secretHint(opts.secret);
  } else {
    // The signature is derived, not the secret; it may be shown as is.
    sent["X-Portal-Signature"] = signature(opts.secret, opts.nowUnix, opts.body);
    shown["X-Portal-Signature"] = sent["X-Portal-Signature"];
  }
  return { sent, shown };
}

/** A receiver that keeps the answer open must not hold the queue. */
const READ_DEADLINE_MS = 2_000;

/**
 * Up to `limit` characters of the answer, then the rest is dropped and the
 * connection released — also when the receiver stops sending halfway.
 */
async function readBounded(res: Response, limit: number, deadlineMs: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), deadlineMs);
  });
  try {
    while (text.length < limit) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === "late" || next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
  } catch {
    // A broken answer is no answer.
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
  return text.slice(0, limit);
}

/** The answer on one line, short enough for an error message. */
function quote(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_QUOTE ? `${line.slice(0, MAX_QUOTE)}…` : line;
}

/** One call to the target. Never throws: every failure becomes a result. */
export async function send(
  fetcher: Fetcher,
  opts: {
    url: string;
    body: string;
    deliveryId: string;
    secret: string;
    nowUnix: number;
    timeoutMs?: number;
    auth?: WebhookAuth;
    headerName?: string;
    /** Sees every call with what was sent and answered — the portal's log. */
    onCall?: (call: WebhookCall) => void;
  },
): Promise<SendResult> {
  const { sent, shown } = callHeaders({ ...opts, auth: opts.auth ?? "signature", headerName: opts.headerName ?? "" });
  const started = Date.now();
  const finish = (result: SendResult, response = ""): SendResult => {
    opts.onCall?.({
      url: opts.url,
      headers: shown,
      body: opts.body,
      ok: result.ok,
      status: result.status,
      durationMs: Date.now() - started,
      response,
      error: result.error,
    });
    return result;
  };
  try {
    const res = await fetcher(opts.url, {
      method: "POST",
      headers: sent,
      body: opts.body,
      // A redirect would turn the call into a body-less GET; treat it as a failure.
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_TIMEOUT_MS),
    });
    // The answer is the evidence when something is refused; read a bounded part of it.
    const response = await readBounded(res, MAX_RESPONSE, READ_DEADLINE_MS);
    if (res.ok) return finish({ ok: true, status: res.status, error: "" }, response);
    const location = res.headers.get("location");
    const detail = location ? `Weiterleitung nach ${location}` : quote(response);
    return finish({ ok: false, status: res.status, error: `HTTP ${res.status}${detail ? `: ${detail}` : ""}` }, response);
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return finish({ ok: false, status: 0, error: "Zeitlimit überschritten" });
    }
    return finish({ ok: false, status: 0, error: errorText(e) });
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
