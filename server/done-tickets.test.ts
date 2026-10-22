import { describe, expect, it } from "vitest";
import { SOLUTION_LOOKBACK_DAYS } from "../shared/solution.ts";
import { createDoneTickets } from "./done-tickets.ts";
import { TanssError, type CustomTicketFilter, type LinkedEntities, type Obj, type TanssClient, type TanssSession } from "./tanss.ts";

const SESSION: TanssSession = { employeeId: 7, apiKey: "key-1", refresh: "r", expire: 9_999_999_999 };
const NOW = 1_800_000_000_000;

const ticket = (id: number, modifiedTime = 1_000 - id): Obj => ({ id, title: `T${id}`, modifiedTime });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ticket(from + i));

type Answer = { items: Obj[]; linked?: LinkedEntities };

/** Fake whose customTicketList answers by includeDoneTickets and page, and records every call. */
function fakeTanss(
  answer: (withDone: boolean, page: number) => Answer,
  failOn?: () => TanssError | undefined,
) {
  const calls: CustomTicketFilter[] = [];
  const tanss = {
    async customTicketList(_session: TanssSession, filter: CustomTicketFilter) {
      calls.push(filter);
      const failure = failOn?.();
      if (failure) throw failure;
      const a = answer(filter.includeDoneTickets === true, filter.page);
      return { items: a.items, linked: a.linked ?? {} };
    },
  } as unknown as TanssClient;
  return { tanss, calls, withDone: () => calls.filter((c) => c.includeDoneTickets === true), withoutDone: () => calls.filter((c) => !c.includeDoneTickets) };
}

describe("createDoneTickets", () => {
  it("pages through done and open lists from page 1 and keeps only done tickets", async () => {
    const fake = fakeTanss((withDone, page) => {
      if (!withDone) return { items: range(1, 10) };
      return { items: page === 1 ? range(1, 100) : range(101, 103) };
    });
    const store = createDoneTickets({ tanss: fake.tanss, now: () => NOW });

    const result = await store.get(SESSION, 42);

    expect(result.done.map((t) => t.id).sort((a, b) => Number(a) - Number(b))).toEqual(range(11, 103).map((t) => t.id));
    expect(result.truncated).toBe(false);
    expect(fake.withDone().map((c) => c.page)).toEqual([1, 2]);
    expect(fake.withoutDone().map((c) => c.page)).toEqual([1]);
    const to = Math.floor(NOW / 1000);
    for (const c of fake.calls) {
      expect(c.itemsPerPage).toBe(100);
      expect(c.companies).toEqual([42]);
      expect(c.modifiedWithinTimeframe).toEqual({ from: to - SOLUTION_LOOKBACK_DAYS * 86_400, to });
    }
  });

  it("stops after five pages and says so", async () => {
    const fake = fakeTanss((withDone, page) => ({ items: withDone ? range(page * 100, page * 100 + 99) : [] }));
    const store = createDoneTickets({ tanss: fake.tanss, now: () => NOW });

    const result = await store.get(SESSION, 42);

    expect(fake.withDone().map((c) => c.page)).toEqual([1, 2, 3, 4, 5]);
    expect(result.done).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });

  it("reads at most ten pages of open tickets", async () => {
    const fake = fakeTanss((withDone, page) => ({ items: withDone ? [] : range(page * 100, page * 100 + 99) }));
    const store = createDoneTickets({ tanss: fake.tanss, now: () => NOW });

    await store.get(SESSION, 42);

    expect(fake.withoutDone().map((c) => c.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("sorts by modifiedTime, newest first", async () => {
    const fake = fakeTanss((withDone) => ({
      items: withDone ? [ticket(1, 300), ticket(2, 500), ticket(3, 100), ticket(4, 400)] : [ticket(4, 400)],
    }));
    const store = createDoneTickets({ tanss: fake.tanss, now: () => NOW });

    const result = await store.get(SESSION, 42);

    expect(result.done.map((t) => t.id)).toEqual([2, 1, 3]);
  });

  it("merges the linked entities of both lists per type", async () => {
    const fake = fakeTanss((withDone): Answer =>
      withDone
        ? { items: [ticket(1)], linked: { companies: { "42": { name: "Kunde" } }, employees: { "7": { name: "A" } } } }
        : { items: [], linked: { companies: { "43": { name: "Anderer" } } } },
    );
    const store = createDoneTickets({ tanss: fake.tanss, now: () => NOW });

    const result = await store.get(SESSION, 42);

    expect(result.linked).toEqual({
      companies: { "42": { name: "Kunde" }, "43": { name: "Anderer" } },
      employees: { "7": { name: "A" } },
    });
  });

  it("serves a second call within ten minutes from memory", async () => {
    const fake = fakeTanss((withDone) => ({ items: withDone ? [ticket(1)] : [] }));
    let now = NOW;
    const store = createDoneTickets({ tanss: fake.tanss, now: () => now });

    const first = await store.get(SESSION, 42);
    const callsAfterFirst = fake.calls.length;
    now = NOW + 10 * 60_000;
    const second = await store.get(SESSION, 42);
    expect(second).toEqual(first);
    expect(fake.calls).toHaveLength(callsAfterFirst);

    await store.get({ ...SESSION, employeeId: 8 }, 42);
    expect(fake.calls.length).toBeGreaterThan(callsAfterFirst);

    const callsAfterOther = fake.calls.length;
    now = NOW + 10 * 60_000 + 1;
    await store.get(SESSION, 42);
    expect(fake.calls.length).toBeGreaterThan(callsAfterOther);
  });

  it("keeps at most 20 entries", async () => {
    const fake = fakeTanss((withDone) => ({ items: withDone ? [ticket(1)] : [] }));
    const store = createDoneTickets({ tanss: fake.tanss, now: () => NOW });

    for (let company = 1; company <= 21; company++) await store.get(SESSION, company);
    const before = fake.calls.length;
    await store.get(SESSION, 21);
    expect(fake.calls).toHaveLength(before);
    await store.get(SESSION, 1);
    expect(fake.calls.length).toBeGreaterThan(before);
  });

  it("does not cache a failure", async () => {
    let fail = true;
    const fake = fakeTanss(
      (withDone) => ({ items: withDone ? [ticket(1)] : [] }),
      () => (fail ? new TanssError("boom", 500) : undefined),
    );
    const store = createDoneTickets({ tanss: fake.tanss, now: () => NOW });

    await expect(store.get(SESSION, 42)).rejects.toBeInstanceOf(TanssError);
    fail = false;
    const result = await store.get(SESSION, 42);

    expect(result.done.map((t) => t.id)).toEqual([1]);
  });
});
