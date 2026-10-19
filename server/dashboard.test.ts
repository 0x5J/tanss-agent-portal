import { describe, expect, it } from "vitest";
import { buildApp, type AppOptions } from "./app.ts";
import { createPoller } from "./poller.ts";
import { createMemoryStore } from "./store.ts";
import { TanssError, type TanssClient, type TanssSession } from "./tanss.ts";
import { EMPTY_FILTERS, type SavedView } from "../shared/filters.ts";

const SECRET = "x".repeat(32);
const SESSION: TanssSession = { employeeId: 7, apiKey: "Bearer a", refresh: "Bearer r", expire: 9_999_999_999 };

const TICKETS = {
  items: [
    { id: 1, title: "Firewall", statusId: 2, assignedToEmployeeId: 7, creationDate: 1_750_000_000 },
    { id: 2, title: "SOC Alarm", statusId: 2, assignedToDepartmentId: 4, creationDate: 1_750_000_500 },
  ],
  linked: {
    ticketStates: { "2": { name: "Neu" } },
    employees: { "7": { name: "Sören" } },
    departments: { "4": { name: "SOC" } },
  },
  waitingStates: [],
};

function fakeTanss(overrides: Partial<TanssClient> = {}): TanssClient {
  const base: Partial<TanssClient> = {
    login: async () => ({ ...SESSION }),
    ticketList: async () => TICKETS,
  };
  return { ...base, ...overrides } as TanssClient;
}

async function loggedIn(tanss: TanssClient, opts: Partial<AppOptions> = {}) {
  const app = await buildApp({ sessionSecret: SECRET, tanss, enableRateLimit: false, ...opts });
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "sb", password: "pw", token: "123456" },
  });
  const cookie = res.headers["set-cookie"];
  return { app, cookie: Array.isArray(cookie) ? cookie[0] : String(cookie ?? "") };
}

/** A gate that always hands out a session — the poller's login is tested in login.test.ts. */
function fakeGate(make: () => TanssSession) {
  return {
    login: async () => make(),
    health: () => ({ lastSuccessAt: 0, failures: 0, lastError: "", retryAfter: 0, stopped: false }),
  };
}

const SOC_VIEW: SavedView = { id: "v1", name: "SOC", list: "all", filters: { ...EMPTY_FILTERS, department: ["SOC"] } };

describe("saved views on the server", () => {
  it("stores and returns them per employee, dropping broken entries", async () => {
    const store = createMemoryStore();
    const { app, cookie } = await loggedIn(fakeTanss(), { store });
    const put = await app.inject({
      method: "PUT",
      url: "/me/views",
      headers: { cookie },
      payload: { views: [SOC_VIEW, { kaputt: true }] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().views).toHaveLength(1);
    const get = await app.inject({ method: "GET", url: "/me/views", headers: { cookie } });
    expect(get.json().views[0]).toMatchObject({ id: "v1", name: "SOC" });
    expect(store.views(7)).toHaveLength(1);
  });

  it("requires a session", async () => {
    const app = await buildApp({ sessionSecret: SECRET, tanss: fakeTanss(), enableRateLimit: false });
    expect((await app.inject({ method: "GET", url: "/me/views" })).statusCode).toBe(401);
  });
});

describe("dashboard route", () => {
  it("returns the stored days and whether the poller runs", async () => {
    const store = createMemoryStore();
    store.setDashboard(7, [
      { day: "2026-08-24", samples: [{ minute: 600, counts: { "list:own": 3 } }], seen: {}, claims: [], assignees: {}, names: {} },
    ]);
    const { app, cookie } = await loggedIn(fakeTanss(), { store, polling: true });
    const res = await app.inject({ method: "GET", url: "/me/dashboard", headers: { cookie } });
    const body = res.json();
    expect(body.polling).toBe(true);
    expect(body.intervalMinutes).toBe(5);
    expect(body.days[0].samples[0].counts["list:own"]).toBe(3);
  });
});

describe("self-healing session", () => {
  it("logs in again on a 401 and retries the call once", async () => {
    // The board loads four lists (own, general, technician, projects); the
    // whole first load has to fail for the session to heal itself.
    let failures = 4;
    const tanss = fakeTanss({
      ticketList: async () => {
        if (failures-- > 0) throw new TanssError("Sitzung abgelaufen, bitte erneut anmelden", 401);
        return TICKETS;
      },
    });
    let relogins = 0;
    const relogin = async () => {
      relogins++;
      return { ...SESSION, apiKey: "Bearer neu", refresh: "Bearer neu-r" };
    };
    const store = createMemoryStore();
    const { app, cookie } = await loggedIn(tanss, { relogin, store });
    const res = await app.inject({ method: "GET", url: "/me/tickets", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(relogins).toBe(1);
    // The fresh pair lands in the shared session so the healing sticks.
    expect(store.session()).toMatchObject({ apiKey: "Bearer neu", refresh: "Bearer neu-r" });
  });

  it("does not heal a foreign employee's cookie", async () => {
    const tanss = fakeTanss({
      ticketList: async () => {
        throw new TanssError("Sitzung abgelaufen, bitte erneut anmelden", 401);
      },
    });
    const relogin = async () => ({ ...SESSION, employeeId: 8 });
    const { app, cookie } = await loggedIn(tanss, { relogin });
    const res = await app.inject({ method: "GET", url: "/me/tickets", headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });

  it("without credentials the 401 still logs the user out", async () => {
    const tanss = fakeTanss({
      ticketList: async () => {
        throw new TanssError("Sitzung abgelaufen, bitte erneut anmelden", 401);
      },
    });
    const { app, cookie } = await loggedIn(tanss);
    const res = await app.inject({ method: "GET", url: "/me/tickets", headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });
});

describe("poller", () => {
  it("logs in, counts the lists and records a sample", async () => {
    const store = createMemoryStore();
    store.setViews(7, [SOC_VIEW]);
    let logins = 0;
    const poller = createPoller({
      tanss: fakeTanss(),
      store,
      gate: fakeGate(() => {
        logins++;
        return { ...SESSION };
      }),
      now: () => 1_750_000_000_000,
    });
    await poller.tick();
    await poller.tick();
    expect(logins).toBe(1);
    const days = store.dashboard(7);
    expect(days).toHaveLength(1);
    const sample = days[0].samples[0];
    expect(sample.counts["list:own"]).toBe(1);
    expect(sample.counts["list:general"]).toBe(1);
    expect(sample.counts["view:v1"]).toBe(1);
    expect(Object.keys(days[0].seen["view:v1"])).toEqual(["2"]);
  });

  it("survives a dead session with one fresh login inside the tick", async () => {
    const store = createMemoryStore();
    let calls = 0;
    const tanss = fakeTanss({
      ticketList: async () => {
        if (++calls <= 3) throw new TanssError("Sitzung abgelaufen", 401);
        return TICKETS;
      },
    });
    let logins = 0;
    const poller = createPoller({ tanss, store, gate: fakeGate(() => (logins++, { ...SESSION })) });
    await poller.tick();
    expect(logins).toBe(2);
    expect(store.dashboard(7)[0].samples).toHaveLength(1);
  });

  it("reports an error and leaves a gap instead of throwing", async () => {
    const store = createMemoryStore();
    const errors: string[] = [];
    const poller = createPoller({
      tanss: fakeTanss({
        ticketList: async () => {
          throw new TanssError("TANSS weg", 502);
        },
      }),
      store,
      gate: fakeGate(() => ({ ...SESSION })),
      onError: (m) => errors.push(m),
    });
    await poller.tick();
    expect(errors).toEqual(["TANSS weg"]);
    expect(store.dashboard(7)).toHaveLength(0);
  });
});
