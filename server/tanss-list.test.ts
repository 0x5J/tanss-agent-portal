import { describe, expect, it } from "vitest";
import { createTanssClient, type CustomTicketFilter, type TanssSession } from "./tanss.ts";

const SESSION: TanssSession = { employeeId: 7, apiKey: "key-1", refresh: "r", expire: 9_999_999_999 };

function clientAnswering(content: unknown) {
  const seen: { url: string; method: string; apiToken: string | null; body: unknown }[] = [];
  const client = createTanssClient({
    baseUrl: "http://tanss.test",
    fetch: async (input, init) => {
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        apiToken: new Headers(init?.headers).get("apiToken"),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(
        JSON.stringify({ meta: { linkedEntities: { companies: { "5": { name: "Kunde" } } } }, content }),
        { status: 200 },
      );
    },
  });
  return { client, seen };
}

describe("customTicketList", () => {
  it("sends the filter as PUT /api/v1/tickets and returns items and linked entities", async () => {
    const { client, seen } = clientAnswering([{ id: 1, title: "A" }]);
    const filter: CustomTicketFilter = {
      companies: [5],
      includeDoneTickets: true,
      modifiedWithinTimeframe: { from: 1_700_000_000, to: 1_750_000_000 },
      itemsPerPage: 100,
      page: 1,
    };

    const result = await client.customTicketList(SESSION, filter);

    expect(seen).toEqual([
      { url: "http://tanss.test/api/v1/tickets", method: "PUT", apiToken: "key-1", body: filter },
    ]);
    expect(result).toEqual({
      items: [{ id: 1, title: "A" }],
      linked: { companies: { "5": { name: "Kunde" } } },
    });
  });

  it("reads a non-array content as an empty list", async () => {
    const { client } = clientAnswering(null);
    const result = await client.customTicketList(SESSION, { itemsPerPage: 100, page: 1 });
    expect(result.items).toEqual([]);
  });
});
