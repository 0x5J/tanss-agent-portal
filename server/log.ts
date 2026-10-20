import { LOG_LIMIT, type LogEntry } from "../shared/log.ts";

export type CallLog = {
  add(entry: Omit<LogEntry, "id" | "at">, at?: number): LogEntry;
  /** Entries newer than `sinceId`, oldest first. */
  since(sinceId: number): LogEntry[];
  clear(): void;
  lastId(): number;
};

/** Longest payload kept per entry — enough to see a booking, not a whole list. */
const MAX_BODY = 2000;

/**
 * In-memory ring buffer of everything crossing a boundary. It is a debugging
 * aid, not an audit trail: it never touches disk and dies with the process.
 */
export function createCallLog(limit = LOG_LIMIT, now = Date.now): CallLog {
  let entries: LogEntry[] = [];
  let nextId = 1;

  return {
    add(entry, at) {
      const stored: LogEntry = {
        ...entry,
        body: entry.body.slice(0, MAX_BODY),
        response: entry.response.slice(0, MAX_BODY),
        id: nextId++,
        at: at ?? now(),
      };
      entries.push(stored);
      if (entries.length > limit) {
        entries = entries.slice(entries.length - limit);
      }
      return stored;
    },
    since(sinceId) {
      return entries.filter((entry) => entry.id > sinceId);
    },
    clear() {
      entries = [];
    },
    lastId() {
      return nextId - 1;
    },
  };
}

/**
 * The login payload carries username, password and the 2FA code, so its body is
 * never recorded. Everything else is the user's own data on their own machine.
 */
export function loggableBody(path: string, body: unknown): string {
  if (body === undefined) return "";
  if (path.includes("/login")) return "(Zugangsdaten nicht protokolliert)";
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

/**
 * What one technician may see: everything crossing the TANSS boundary, but of
 * the webhook calls only their own — a target URL can itself be the secret.
 */
export function visibleLog(entries: LogEntry[], employeeId: number): LogEntry[] {
  return entries.filter((entry) => entry.kind !== "webhook" || entry.employeeId === employeeId);
}
