import { SOLUTION_LOOKBACK_DAYS } from "../shared/solution.ts";
import type { LinkedEntities, Obj, TanssClient, TanssSession } from "./tanss.ts";

const PAGE_SIZE = 100;
/** Pages read of the list with done tickets; more than this is reported as truncated. */
const MAX_DONE_PAGES = 5;
/** Pages read of the list without done tickets (the ones to subtract). */
const MAX_OPEN_PAGES = 10;
const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 20;

export type DoneTickets = { done: Obj[]; linked: LinkedEntities; truncated: boolean };

/**
 * Done tickets of one customer from the last year, held in memory only.
 * TANSS has no "done only" filter: the list fetched with done tickets minus
 * the list fetched without them is the done set.
 */
export function createDoneTickets(opts: {
  tanss: TanssClient;
  now: () => number;
  ttlMs?: number;
  maxEntries?: number;
}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // Insertion order doubles as age: the first key is the oldest entry.
  const cache = new Map<string, { at: number; value: DoneTickets }>();

  async function fetchAll(
    session: TanssSession,
    companyId: number,
    includeDoneTickets: boolean,
    maxPages: number,
    timeframe: { from: number; to: number },
  ) {
    const items: Obj[] = [];
    const linked: LinkedEntities = {};
    let truncated = false;
    for (let page = 1; page <= maxPages; page++) {
      const result = await opts.tanss.customTicketList(session, {
        companies: [companyId],
        includeDoneTickets,
        modifiedWithinTimeframe: timeframe,
        itemsPerPage: PAGE_SIZE,
        page,
      });
      items.push(...result.items);
      mergeLinked(linked, result.linked);
      if (result.items.length < PAGE_SIZE) break;
      if (page === maxPages) truncated = true;
    }
    return { items, linked, truncated };
  }

  async function load(session: TanssSession, companyId: number): Promise<DoneTickets> {
    const to = Math.floor(opts.now() / 1000);
    const timeframe = { from: to - SOLUTION_LOOKBACK_DAYS * 86_400, to };
    const [withDone, open] = await Promise.all([
      fetchAll(session, companyId, true, MAX_DONE_PAGES, timeframe),
      fetchAll(session, companyId, false, MAX_OPEN_PAGES, timeframe),
    ]);
    const openIds = new Set(open.items.map((t) => Number(t.id)));
    const done = withDone.items
      .filter((t) => !openIds.has(Number(t.id)))
      .sort((a, b) => (Number(b.modifiedTime) || 0) - (Number(a.modifiedTime) || 0));
    const linked: LinkedEntities = {};
    mergeLinked(linked, withDone.linked);
    mergeLinked(linked, open.linked);
    return { done, linked, truncated: withDone.truncated };
  }

  return {
    /** Done tickets of one customer, newest first; cached per employee + company. */
    async get(session: TanssSession, companyId: number): Promise<DoneTickets> {
      const key = `${session.employeeId}:${companyId}`;
      const hit = cache.get(key);
      if (hit && opts.now() - hit.at <= ttlMs) return hit.value;
      cache.delete(key);
      const value = await load(session, companyId);
      cache.set(key, { at: opts.now(), value });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
      return value;
    },
  };
}

function mergeLinked(target: LinkedEntities, source: LinkedEntities | undefined): void {
  for (const [type, entities] of Object.entries(source ?? {})) {
    target[type] = { ...target[type], ...entities };
  }
}
