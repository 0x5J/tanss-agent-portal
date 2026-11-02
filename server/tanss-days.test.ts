import { describe, expect, it } from "vitest";
import { createTanssClient, type TanssSession } from "./tanss.ts";

const SESSION: TanssSession = { employeeId: 7, apiKey: "key-1", refresh: "r", expire: 9_999_999_999 };

function clientAnswering(status: number, content: unknown) {
  const seen: { url: string; method: string; apiToken: string | null }[] = [];
  const client = createTanssClient({
    baseUrl: "http://tanss.test",
    fetch: async (input, init) => {
      seen.push({ url: String(input), method: init?.method ?? "GET", apiToken: new Headers(init?.headers).get("apiToken") });
      return new Response(JSON.stringify({ meta: { text: "ok" }, content }), { status });
    },
  });
  return { client, seen };
}

describe("own daily services", () => {
  it("reads the status with GET and hands back what TANSS says", async () => {
    const { client, seen } = clientAnswering(200, { hasToConfirm: true, notConfirmedDays: ["2026-10-26"] });

    const result = await client.dayStatus(SESSION, "2026-11-02");

    expect(seen).toEqual([{ url: "http://tanss.test/api/v1/ownDailyServices/2026-11-02", method: "GET", apiToken: "key-1" }]);
    expect(result).toEqual({ mustConfirm: true, openDays: ["2026-10-26"] });
  });

  it("confirms a day with GET on its confirm address and accepts the 201", async () => {
    const { client, seen } = clientAnswering(201, {});

    await client.confirmDay(SESSION, "2026-10-26");

    expect(seen).toEqual([{ url: "http://tanss.test/api/v1/ownDailyServices/2026-10-26/confirm", method: "GET", apiToken: "key-1" }]);
  });

  it("throws when TANSS refuses the confirmation", async () => {
    const { client } = clientAnswering(403, {});

    await expect(client.confirmDay(SESSION, "2026-10-26")).rejects.toMatchObject({ status: 403 });
  });
});
