export type LogKind = "request" | "tanss";

export type LogEntry = {
  /** Monotonically increasing, so the client can poll for what is new. */
  id: number;
  at: number;
  kind: LogKind;
  method: string;
  path: string;
  status: number;
  ok: boolean;
  durationMs: number;
  /** What the other side said, when it said anything. */
  message: string;
  /** Outgoing TANSS payload. Never set for the login call. */
  body: string;
  /** The URL actually reached. Differs from `path` after a redirect. */
  url: string;
  /** True when something between us and TANSS redirected the request. */
  redirected: boolean;
  /** Raw response text. Only kept for failures, where it is the evidence. */
  response: string;
  /** TANSS-side correlation id of a rejection, worth quoting towards TANSS. */
  traceId: string;
};

export const LOG_LIMIT = 300;
