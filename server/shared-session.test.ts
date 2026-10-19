import { describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { createPoller } from "./poller.ts";
import { createSharedSession, REFRESH_WINDOW_DAYS } from "./shared-session.ts";
import { createMemoryStore } from "./store.ts";
import { sealData } from "iron-session";
import { sessionOptions } from "./session.ts";
import { TanssError, type TanssClient, type TanssSession } from "./tanss.ts";

const SECRET = "x".repeat(32);
const SESSION: TanssSession = { employeeId: 7, apiKey: "Bearer a", refresh: "Bearer r", expire: 9_999_999_999 };
const TICKETS = {
  items: [{ id: 1, title: "Firewall", statusId: 2, assignedToEmployeeId: 7, creationDate: 1_750_000_000 }],
  linked: { ticketStates: { "2": { name: "Neu" } }, employees: { "7": { name: "Sören" } } },
  waitingStates: [],
};

function fakeTanss(overrides: Partial<TanssClient> = {}): TanssClient {
  return { login: async () => ({ ...SESSION }), ticketList: async () => TICKETS, ...overrides } as TanssClient;
}

describe("shared session", () => {
  it("hands out the stored pair and keeps whatever rotation happened", async () => {
    const store = createMemoryStore();
    const shared = createSharedSession({ store, now: () => 1_000_000_000_000 });
    shared.adopt(SESSION, 1_000_000_000);
    await shared.run(async (session) => {
      expect(session.apiKey).toBe("Bearer a");
      session.apiKey = "Bearer neu";
      session.refresh = "Bearer neu-r";
    });
    expect(store.session()).toMatchObject({ apiKey: "Bearer neu", refresh: "Bearer neu-r" });
  });

  it("serialises callers so two of them never rotate the same token", async () => {
    const store = createMemoryStore();
    const shared = createSharedSession({ store });
    shared.adopt(SESSION, Math.floor(Date.now() / 1000));
    const seen: string[] = [];
    // Both callers rotate; without the queue the second would start from the
    // pair the first one already replaced — TANSS would kill one of them.
    const rotate = (name: string) =>
      shared.run(async (session) => {
        seen.push(`${name}:${session.apiKey}`);
        await new Promise((r) => setTimeout(r, 5));
        session.apiKey = `Bearer ${name}`;
        session.refresh = `Bearer ${name}-r`;
      });
    await Promise.all([rotate("eins"), rotate("zwei")]);
    expect(seen).toEqual(["eins:Bearer a", "zwei:Bearer eins"]);
    expect(store.session()?.apiKey).toBe("Bearer zwei");
  });

  it("keeps working after a caller threw", async () => {
    const store = createMemoryStore();
    const shared = createSharedSession({ store });
    shared.adopt(SESSION, Math.floor(Date.now() / 1000));
    await expect(shared.run(async () => { throw new Error("kaputt"); })).rejects.toThrow("kaputt");
    await expect(shared.run(async (s) => s.apiKey)).resolves.toBe("Bearer a");
  });

  it("refuses and forgets a pair older than the refresh window", async () => {
    const store = createMemoryStore();
    let clock = 1_000_000_000_000;
    const shared = createSharedSession({ store, now: () => clock });
    shared.adopt(SESSION, Math.floor(clock / 1000));
    clock += (REFRESH_WINDOW_DAYS * 86_400 + 60) * 1000;
    await expect(shared.run(async () => "egal")).rejects.toThrow(/älter als 5 Tage/);
    expect(store.session()).toBeNull();
  });

  it("says there is nothing when no login has happened", async () => {
    const shared = createSharedSession({ store: createMemoryStore() });
    expect(shared.state().present).toBe(false);
    await expect(shared.run(async () => "egal")).rejects.toThrow(/Nicht angemeldet/);
  });
});

describe("the login seeds the collector", () => {
  it("stores the pair server-side and keeps it out of the cookie", async () => {
    const store = createMemoryStore();
    const app = await buildApp({ sessionSecret: SECRET, tanss: fakeTanss(), enableRateLimit: false, store });
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "sb", password: "pw", token: "123456" },
    });
    expect(res.statusCode).toBe(200);
    expect(store.session()).toMatchObject({ employeeId: 7, apiKey: "Bearer a", refresh: "Bearer r" });
    // Nothing readable in the cookie: it is encrypted, but it must not even
    // carry the tokens any more.
    const raw = res.headers["set-cookie"];
    const cookie = Array.isArray(raw) ? raw[0] : String(raw ?? "");
    expect(cookie).toMatch(/agent_portal=/);

    // And from that session alone the collector can measure — no password.
    const poller = createPoller({
      tanss: fakeTanss(),
      store,
      shared: createSharedSession({ store }),
    });
    await poller.tick();
    expect(store.dashboard(7)).toHaveLength(1);
    expect(poller.health().lastError).toBe("");
  });

  it("measures at once after the login instead of waiting five minutes", async () => {
    const store = createMemoryStore();
    let ticks = 0;
    const app = await buildApp({
      sessionSecret: SECRET,
      tanss: fakeTanss(),
      enableRateLimit: false,
      store,
      onLogin: () => {
        ticks++;
      },
    });
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "sb", password: "pw", token: "123456" },
    });
    expect(ticks).toBe(1);
  });

  it("measures right after an assignment so the takeover shows up at once", async () => {
    const store = createMemoryStore();
    let measured = 0;
    const app = await buildApp({
      sessionSecret: SECRET,
      tanss: {
        ...fakeTanss(),
        ticketById: async () => ({ item: { id: 1, title: "T", statusId: 2 }, linked: {} }),
        updateTicket: async () => ({ id: 1 }),
      } as unknown as TanssClient,
      enableRateLimit: false,
      store,
      onAssignment: () => {
        measured++;
      },
    });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "sb", password: "pw", token: "123456" },
    });
    const raw = login.headers["set-cookie"];
    const cookie = Array.isArray(raw) ? raw[0] : String(raw ?? "");
    const res = await app.inject({
      method: "PATCH",
      url: "/me/tickets/1",
      headers: { cookie },
      payload: { assignedToEmployeeId: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(measured).toBe(1);
    // A pure status change is not a takeover and must not trigger one.
    await app.inject({ method: "PATCH", url: "/me/tickets/1", headers: { cookie }, payload: { statusId: 6 } });
    expect(measured).toBe(1);
  });

  it("logging out leaves the collector's session alone", async () => {
    const store = createMemoryStore();
    const app = await buildApp({ sessionSecret: SECRET, tanss: fakeTanss(), enableRateLimit: false, store });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "sb", password: "pw", token: "123456" },
    });
    const raw = login.headers["set-cookie"];
    const cookie = Array.isArray(raw) ? raw[0] : String(raw ?? "");
    await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });
    expect(store.session()).not.toBeNull();
    // "Sammler stoppen" is the explicit way out.
    const stop = await app.inject({ method: "DELETE", url: "/me/session", headers: { cookie } });
    expect(stop.statusCode).toBe(200);
    expect(store.session()).toBeNull();
  });

  it("adopts a cookie from before the shared session once", async () => {
    const store = createMemoryStore();
    // A cookie minted by the old code carried the token pair itself.
    const sealed = await sealData(
      { employeeId: 7, apiKey: "Bearer alt", refresh: "Bearer alt-r", expire: 9_999_999_999 },
      { password: SECRET, ttl: sessionOptions(SECRET).ttl },
    );
    const cookie = `agent_portal=${sealed}`;

    const app = await buildApp({ sessionSecret: SECRET, tanss: fakeTanss(), enableRateLimit: false, store });
    expect(store.session()).toBeNull();
    const res = await app.inject({ method: "GET", url: "/me/tickets", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(store.session()).toMatchObject({ employeeId: 7, apiKey: "Bearer alt" });
  });

  it("never acts under a stored session that belongs to somebody else", async () => {
    const store = createMemoryStore();
    const app = await buildApp({ sessionSecret: SECRET, tanss: fakeTanss(), enableRateLimit: false, store });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "sb", password: "pw", token: "123456" },
    });
    const raw = login.headers["set-cookie"];
    const cookie = Array.isArray(raw) ? raw[0] : String(raw ?? "");
    store.setSession({ employeeId: 99, apiKey: "Bearer fremd", refresh: "Bearer f", expire: 0, updatedAt: 0 });
    const res = await app.inject({ method: "GET", url: "/me/tickets", headers: { cookie } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/anderen Konto/);
  });

  it("puts a fallback login into the shared session so the retry can use it", async () => {
    const store = createMemoryStore();
    const shared = createSharedSession({ store });
    let logins = 0;
    const gate = {
      login: async () => {
        logins++;
        return { ...SESSION, apiKey: "Bearer aus-fallback" };
      },
      health: () => ({ lastSuccessAt: 0, failures: 0, lastError: "", retryAfter: 0, stopped: false }),
    };
    // No session at all: the shared one throws 401, the gate has to step in.
    const poller = createPoller({ tanss: fakeTanss(), store, shared, gate });
    await poller.tick();
    expect(logins).toBe(1);
    // Without adopting, the retry would read the empty shared session again
    // and fail with the very same 401 — the fallback would be dead code.
    expect(store.session()).toMatchObject({ apiKey: "Bearer aus-fallback" });
    expect(store.dashboard(7)).toHaveLength(1);
    expect(poller.health().lastError).toBe("");
  });

  it("the collector stops asking when the session is gone and nothing can heal it", async () => {
    const store = createMemoryStore();
    let calls = 0;
    const poller = createPoller({
      tanss: fakeTanss({
        ticketList: async () => {
          calls++;
          throw new TanssError("Sitzung abgelaufen", 401);
        },
      }),
      store,
      shared: createSharedSession({ store }),
    });
    // No session at all: not a single request goes out.
    await poller.tick();
    expect(calls).toBe(0);
    expect(poller.health().lastError).toMatch(/Nicht angemeldet/);
  });
});
