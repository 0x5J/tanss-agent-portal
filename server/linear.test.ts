import { describe, expect, it } from "vitest";
import { createLinearClient, LinearError } from "./linear.ts";
import { berlinDayRangeUnix } from "../shared/days.ts";

const DAY = "2026-08-25";
const dayFrom = berlinDayRangeUnix(DAY).from;
const iso = (h: number, m = 0) => new Date((dayFrom + h * 3600 + m * 60) * 1000).toISOString();

function fakeFetch(handler: (body: { query: string; variables: Record<string, unknown> }) => unknown) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
    const data = handler(body);
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

const ISSUE = {
  identifier: "ESK-499",
  title: "Firewall-Cluster",
  url: "https://linear.app/x/ESK-499",
  project: { name: "SOC Betrieb" },
  team: { name: "Security" },
  history: {
    nodes: [
      { createdAt: iso(9), fromState: { name: "Todo" }, toState: { name: "In Progress" } },
      { createdAt: iso(11), fromState: { name: "In Progress" }, toState: { name: "Done" } },
    ],
    pageInfo: { hasNextPage: false },
  },
  comments: {
    nodes: [
      { createdAt: iso(11), body: "Bis 10:45 analysiert (Dauer: 1 h 15 min)", user: { id: "me" } },
      { createdAt: iso(12), body: "Kommentar von jemand anderem (Dauer: 3 h)", user: { id: "other" } },
    ],
  },
};

describe("linear client", () => {
  it("reads the day into activities, own comments only", async () => {
    const client = createLinearClient({
      apiKey: "lin_test",
      fetch: fakeFetch((body) =>
        body.query.includes("PortalViewer")
          ? { viewer: { id: "me" } }
          : { issues: { nodes: [ISSUE] } },
      ) as unknown as typeof fetch,
    });
    const result = await client.dayActivity(DAY);
    expect(result.issuesChecked).toBe(1);
    expect(result.capped).toBe(false);
    const [activity] = result.activities;
    expect(activity).toMatchObject({ issue: "ESK-499", project: "SOC Betrieb", commentMinutes: 75, historyTruncated: false });
    // Somebody else's three hours must not land in my day.
    expect(activity!.summary).toBe("Bis 10:45 analysiert (Dauer: 1 h 15 min)");
    expect(activity!.sessions).toEqual([{ start: 9 * 60 + 30, minutes: 75 }]);
  });

  it("falls back to the team when an issue has no project", async () => {
    const client = createLinearClient({
      apiKey: "k",
      fetch: fakeFetch((body) =>
        body.query.includes("PortalViewer")
          ? { viewer: { id: "me" } }
          : { issues: { nodes: [{ ...ISSUE, project: null }] } },
      ) as unknown as typeof fetch,
    });
    expect((await client.dayActivity(DAY)).activities[0]!.project).toBe("Security");
  });

  it("asks the viewer once and caches it", async () => {
    let viewerCalls = 0;
    const client = createLinearClient({
      apiKey: "k",
      fetch: fakeFetch((body) => {
        if (body.query.includes("PortalViewer")) {
          viewerCalls++;
          return { viewer: { id: "me" } };
        }
        return { issues: { nodes: [] } };
      }) as unknown as typeof fetch,
    });
    await client.dayActivity(DAY);
    await client.dayActivity(DAY);
    expect(viewerCalls).toBe(1);
  });

  it("says when a rejected key is the reason", async () => {
    const client = createLinearClient({
      apiKey: "falsch",
      fetch: (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
    });
    await expect(client.dayActivity(DAY)).rejects.toThrow(/API-Key/);
  });

  it("passes a GraphQL error through instead of pretending", async () => {
    const client = createLinearClient({
      apiKey: "k",
      fetch: (async () =>
        new Response(JSON.stringify({ errors: [{ message: "Feld unbekannt" }] }), { status: 200 })) as unknown as typeof fetch,
    });
    const error = await client.dayActivity(DAY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LinearError);
    expect((error as LinearError).message).toBe("Feld unbekannt");
  });

  it("says when the issue cap bit", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...ISSUE, identifier: `ESK-${i}` }));
    const client = createLinearClient({
      apiKey: "k",
      fetch: fakeFetch((body) =>
        body.query.includes("PortalViewer") ? { viewer: { id: "me" } } : { issues: { nodes: many } },
      ) as unknown as typeof fetch,
    });
    expect((await client.dayActivity(DAY)).capped).toBe(true);
  });
});
