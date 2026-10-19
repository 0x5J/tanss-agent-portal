import { describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { parseTotpConfig, generateTotp } from "./totp.ts";
import { TanssError, type TanssClient } from "./tanss.ts";
import { createMemoryStore } from "./store.ts";
import { berlinDayRangeUnix } from "../shared/days.ts";

const SECRET = "x".repeat(32);
const SESSION = { employeeId: 7, apiKey: "Bearer a", refresh: "Bearer r", expire: 9_999_999_999 };

function fakeTanss(overrides: Partial<TanssClient> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const record = (name: string, result: unknown): any =>
    async (...args: unknown[]) => {
      calls.push({ name, args });
      return result;
    };
  const client: TanssClient = {
    login: async (input) => {
      calls.push({ name: "login", args: [input] });
      if (input.password !== "pw") throw new TanssError("Benutzername oder Passwort ist falsch", 403);
      if (input.token !== "123456" && !/^\d{6}$/.test(input.token ?? "")) {
        throw new TanssError("Der 2FA-Code wurde abgelehnt", 403);
      }
      return SESSION;
    },
    ticketList: record("ticketList", {
      items: [
        { id: 1, title: "A", statusId: 6, modified: 10 },
        { id: 2, title: "B", statusId: 2, modified: 20 },
      ],
      linked: { ticketStates: { "6": { name: "Wartet" }, "2": { name: "Neu" } } },
      waitingStates: [6],
    }),
    ticketById: record("ticketById", {
      item: { id: 1, title: "A", content: "Beschreibung", statusId: 2, companyId: 5, remitterId: 3 },
      linked: { companies: { "5": { name: "Kunde" } } },
    }),
    ticketHistory: record("ticketHistory", {
      content: { comments: [{ id: 9, date: 5, content: "Hi", internal: true }], supports: [], mails: [] },
      linked: {},
    }),
    updateTicket: record("updateTicket", { id: 1, statusId: 6 }),
    createComment: record("createComment", { id: 42 }),
    ticketStates: record("ticketStates", [{ id: 2, name: "Neu", rank: 1, active: true }]),
    technicians: record("technicians", [{ id: 7, name: "Ich" }]),
    supportTypes: record("supportTypes", [{ id: 3, name: "Remote" }]),
    listSupports: record("listSupports", { items: [], linked: {} }),
    createSupport: record("createSupport", { id: 77 }),
    supportById: record("supportById", { item: {}, linked: {} }),
    listPhoneCalls: record("listPhoneCalls", []),
    updateSupport: record("updateSupport", { id: 900 }),
    ticketSupports: record("ticketSupports", [{ ticketId: 2, date: 1_750_000_000 }]),
    search: record("search", { tickets: [], companies: [], linked: {} }),
    ...overrides,
  };
  return { client, calls };
}

async function loggedIn(client: TanssClient, totp?: string) {
  const app = await buildApp({
    sessionSecret: SECRET,
    tanss: client,
    enableRateLimit: false,
    totp: totp ? parseTotpConfig(totp) : null,
  });
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "sb", password: "pw", ...(totp ? {} : { token: "123456" }) },
  });
  const cookie = res.headers["set-cookie"];
  return { app, res, cookie: Array.isArray(cookie) ? cookie[0] : String(cookie ?? "") };
}

describe("login", () => {
  it("rejects without token when no seed is configured", async () => {
    const { client } = fakeTanss();
    const app = await buildApp({ sessionSecret: SECRET, tanss: client, enableRateLimit: false });
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "a", password: "b" } });
    expect(res.statusCode).toBe(400);
    const config = await app.inject({ method: "GET", url: "/auth/config" });
    expect(config.json().tokenRequired).toBe(true);
  });

  it("relays the TANSS rejection", async () => {
    const { client } = fakeTanss();
    const app = await buildApp({ sessionSecret: SECRET, tanss: client, enableRateLimit: false });
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "a", password: "x", token: "123456" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/Passwort/);
  });

  it("sets a session cookie and answers /auth/me", async () => {
    const { client } = fakeTanss();
    const { res, app, cookie } = await loggedIn(client);
    expect(res.statusCode).toBe(200);
    expect(cookie).toMatch(/agent_portal=/);
    expect(cookie).toMatch(/HttpOnly/);
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
    expect(me.json()).toEqual({ employeeId: 7 });
  });

  it("generates the TOTP code from the seed", async () => {
    const { client, calls } = fakeTanss();
    const { res, app } = await loggedIn(client, "JBSWY3DPEHPK3PXP");
    expect(res.statusCode).toBe(200);
    const sent = (calls[0].args[0] as { token: string }).token;
    expect(sent).toMatch(/^\d{6}$/);
    expect(sent).toBe(generateTotp(parseTotpConfig("JBSWY3DPEHPK3PXP"), Date.now()));
    expect((await app.inject({ method: "GET", url: "/auth/config" })).json().tokenRequired).toBe(false);
  });
});

describe("logout", () => {
  it("revokes the cookie server-side, copies included", async () => {
    const { client } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    const get = (url: string, c: string) => app.inject({ method: "GET", url, headers: { cookie: c } });
    expect((await get("/auth/me", cookie)).statusCode).toBe(200);
    // The browser drops its cookie on logout; a copy taken before must not live on.
    await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });
    expect((await get("/auth/me", cookie)).statusCode).toBe(401);
    expect((await get("/me/session", cookie)).statusCode).toBe(401);
    expect((await get("/me/tickets", cookie)).statusCode).toBe(401);
    // Logging in again hands out a cookie that works.
    const again = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "sb", password: "pw", token: "123456" } });
    const raw = again.headers["set-cookie"];
    const fresh = Array.isArray(raw) ? raw[0] : String(raw ?? "");
    expect((await get("/auth/me", fresh)).statusCode).toBe(200);
    expect((await get("/auth/me", cookie)).statusCode).toBe(401);
  });
});

describe("tickets", () => {
  it("loads the projects list alongside the board", async () => {
    const kinds: string[] = [];
    const { client } = fakeTanss({
      ticketList: async (_s, kind) => {
        kinds.push(kind);
        return {
          items: kind === "projects" ? [{ id: 9, project: true }] : [{ id: 1 }],
          linked: {},
          waitingStates: [],
        };
      },
    });
    const { app, cookie } = await loggedIn(client);
    const res = await app.inject({ method: "GET", url: "/me/tickets", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(kinds).toContain("projects");
    const rows = res.json().rows as { id: number; isProject: boolean }[];
    expect(rows.find((r) => r.id === 9)?.isProject).toBe(true);
  });

  it("requires a session", async () => {
    const { client } = fakeTanss();
    const app = await buildApp({ sessionSecret: SECRET, tanss: client, enableRateLimit: false });
    const res = await app.inject({ method: "GET", url: "/me/tickets" });
    expect(res.statusCode).toBe(401);
  });

  it("merges the lists, deduplicated, and names the missing ones", async () => {
    let calls = 0;
    const { client } = fakeTanss({
      ticketList: async (_s, kind) => {
        calls++;
        if (kind === "technician") throw new TanssError("verboten", 403);
        return {
          items: kind === "own" ? [{ id: 1, statusId: 6, modified: 10 }, { id: 2, statusId: 2, modified: 20 }] : [{ id: 2, statusId: 2, modified: 20 }, { id: 3, modified: 5 }],
          linked: { employees: { "7": { name: "Ich" } } },
          waitingStates: [6],
        };
      },
    });
    const { app, cookie } = await loggedIn(client);
    const res = await app.inject({ method: "GET", url: "/me/tickets", headers: { cookie } });
    // own, general, technician and projects
    expect(calls).toBe(4);
    const body = res.json();
    expect(body.rows.map((r: { id: number }) => r.id)).toEqual([2, 1, 3]);
    expect(body.rows[1].waiting).toBe(true);
    expect(body.employeeName).toBe("Ich");
    expect(body.missing).toEqual(["technician"]);
  });

  it("builds the thread of a ticket", async () => {
    const { client } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    const res = await app.inject({ method: "GET", url: "/me/tickets/1", headers: { cookie } });
    expect(res.json().ticket.companyName).toBe("Kunde");
    expect(res.json().thread.map((e: { kind: string }) => e.kind)).toEqual(["Beschreibung", "Interne Notiz"]);
  });

  it("writes the whole ticket back on patch", async () => {
    const { client, calls } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    const res = await app.inject({ method: "PATCH", url: "/me/tickets/1", headers: { cookie }, payload: { statusId: 6 } });
    expect(res.statusCode).toBe(200);
    const update = calls.find((c) => c.name === "updateTicket");
    expect(update?.args[2]).toMatchObject({ id: 1, title: "A", content: "Beschreibung", statusId: 6, companyId: 5 });
  });

  it("changes the customer on patch and leaves the contact alone", async () => {
    const { client, calls } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    const res = await app.inject({ method: "PATCH", url: "/me/tickets/1", headers: { cookie }, payload: { companyId: 42 } });
    expect(res.statusCode).toBe(200);
    const update = calls.find((c) => c.name === "updateTicket");
    expect(update?.args[2]).toMatchObject({ id: 1, companyId: 42 });
    expect((update?.args[2] as { remitterId?: unknown }).remitterId).toBe(3);
  });

  it("sets the due date at the given Berlin time", async () => {
    const { client, calls } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    const res = await app.inject({
      method: "PATCH",
      url: "/me/tickets/1",
      headers: { cookie },
      payload: { dueDate: "2026-09-04", dueMinute: 17 * 60 },
    });
    expect(res.statusCode).toBe(200);
    const update = calls.find((c) => c.name === "updateTicket");
    expect((update?.args[2] as { dueDate: number }).dueDate).toBe(Date.parse("2026-09-04T17:00:00+02:00") / 1000);
    // The rest of the ticket travels back untouched.
    expect(update?.args[2]).toMatchObject({ id: 1, title: "A", companyId: 5 });
  });

  it("clears the due date when the date is empty", async () => {
    const { client, calls } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    const res = await app.inject({ method: "PATCH", url: "/me/tickets/1", headers: { cookie }, payload: { dueDate: "" } });
    expect(res.statusCode).toBe(200);
    expect((calls.find((c) => c.name === "updateTicket")?.args[2] as { dueDate: number }).dueDate).toBe(0);
  });

  it("refuses a due time that does not exist on that day", async () => {
    const { client, calls } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    // 2026-03-29 02:30 Berlin falls into the gap when the clocks go forward.
    const res = await app.inject({
      method: "PATCH",
      url: "/me/tickets/1",
      headers: { cookie },
      payload: { dueDate: "2026-03-29", dueMinute: 2 * 60 + 30 },
    });
    expect(res.statusCode).toBe(400);
    expect(calls.some((c) => c.name === "updateTicket")).toBe(false);
  });

  it("creates a comment", async () => {
    const { client, calls } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    const res = await app.inject({ method: "POST", url: "/me/tickets/1/comments", headers: { cookie }, payload: { content: "Hallo", internal: false } });
    expect(res.json()).toEqual({ ok: true, id: 42 });
    expect(calls.find((c) => c.name === "createComment")?.args[2]).toEqual({ title: "", content: "Hallo", internal: false });
    await app.inject({ method: "POST", url: "/me/tickets/1/comments", headers: { cookie }, payload: { content: "Entwurf", internal: true, title: "Mail-Entwurf: Antwort" } });
    expect(calls.filter((c) => c.name === "createComment")[1]?.args[2]).toEqual({ title: "Mail-Entwurf: Antwort", content: "Entwurf", internal: true });
  });
});

describe("activity", () => {
  it("reads histories and falls back to the support list", async () => {
    const { client, calls } = fakeTanss({
      ticketHistory: async (_s, id) => {
        if (id === 2) throw new TanssError("verboten", 403);
        return { content: { comments: [{ date: 1_760_000_000 }], supports: [], mails: [{ date: 1_790_000_000 }] }, linked: {} };
      },
    });
    const { app, cookie } = await loggedIn(client);
    const res = await app.inject({ method: "GET", url: "/me/tickets/activity?ids=1,2,2", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.activity["1"]).toEqual({ at: 1_760_000_000, kind: "comment", historyRead: true });
    expect(body.activity["2"]).toEqual({ at: 1_750_000_000, kind: "support", historyRead: false });
    expect(body.historyChecked).toBe(2);
    expect(body.historyRead).toBe(1);
    expect(body.supportsRead).toBe(true);
    const bulk = calls.find((c) => c.name === "ticketSupports");
    expect(bulk?.args[1]).toEqual([1, 2]);
  });
});

describe("supports", () => {
  it("books with the ticket as assignment", async () => {
    const { client, calls } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    const res = await app.inject({
      method: "POST",
      url: "/me/supports",
      headers: { cookie },
      payload: { date: "2026-08-20", startMinute: 9 * 60, duration: 30, ticketId: 1, typeId: 3, location: "REMOTE", text: "Arbeit" },
    });
    expect(res.statusCode).toBe(200);
    const payload = calls.find((c) => c.name === "createSupport")?.args[1] as Record<string, unknown>;
    expect(payload).toMatchObject({ linkTypeId: 11, linkId: 1, ticketId: 1, duration: 30, employeeId: 7, planningType: "SUPPORT" });
    expect(payload.date).toBe(Date.parse("2026-08-20T09:00:00+02:00") / 1000);
  });

  it("sends the ticket's company along, because TANSS checks the assignment against it", async () => {
    const { client, calls } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    await app.inject({
      method: "POST",
      url: "/me/supports",
      headers: { cookie },
      payload: { date: "2026-08-20", startMinute: 9 * 60, duration: 30, ticketId: 1, typeId: 3, location: "REMOTE", text: "Arbeit" },
    });
    const payload = calls.find((c) => c.name === "createSupport")?.args[1] as Record<string, unknown>;
    // Without it TANSS answers "Die angegebene Zuweisung existiert nicht innerhalb der Firma".
    expect(payload.companyId).toBe(5);
  });

  it("refuses a booking without ticket or company", async () => {
    const { client } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    const res = await app.inject({
      method: "POST",
      url: "/me/supports",
      headers: { cookie },
      payload: { date: "2026-08-20", startMinute: 0, duration: 30, typeId: 3, location: "OFFICE", text: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("persists a rotated token pair in the store, not in the cookie", async () => {
    const { client } = fakeTanss({
      listSupports: async (session) => {
        session.apiKey = "Bearer rotated";
        session.refresh = "Bearer r2";
        return { items: [], linked: {} };
      },
    });
    const store = createMemoryStore();
    const app = await buildApp({ sessionSecret: SECRET, tanss: client, enableRateLimit: false, store });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "sb", password: "pw", token: "123456" },
    });
    const raw = login.headers["set-cookie"];
    const cookie = Array.isArray(raw) ? raw[0] : String(raw ?? "");
    // The login itself already seeds the shared session — that is what the
    // dashboard collector later uses, without any stored password.
    expect(store.session()).toMatchObject({ employeeId: 7, apiKey: "Bearer a" });
    const res = await app.inject({ method: "GET", url: "/me/supports?day=2026-08-20", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().week[0]).toBe("2026-08-17");
    expect(store.session()).toMatchObject({ apiKey: "Bearer rotated", refresh: "Bearer r2" });
  });

  it("reads a range with exactly one TANSS call", async () => {
    const { client, calls } = fakeTanss({
      listSupports: async (...args: unknown[]) => {
        // A local push is needed here: overriding a client method bypasses
        // fakeTanss's own call recorder (same pattern as other tests that
        // override and then inspect the calls list).
        calls.push({ name: "listSupports", args });
        return {
          items: [{ id: 1, date: 1_756_000_000, duration: 60, ticketId: 5, companyId: 9, typeId: 3 }],
          linked: { companies: { "9": { name: "Kunde" } }, supportTypes: { "3": { name: "Remote" } } },
        };
      },
    });
    const { app, cookie } = await loggedIn(client);
    const res = await app.inject({
      method: "GET",
      url: "/me/supports/range?from=2026-08-01&to=2026-08-31",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.from).toBe("2026-08-01");
    expect(body.to).toBe("2026-08-31");
    expect(body.supports).toHaveLength(1);
    expect(body.supports[0].companyName).toBe("Kunde");
    const reads = calls.filter((c) => c.name === "listSupports");
    expect(reads).toHaveLength(1);
    // Berlin day boundaries, not UTC
    expect(reads[0].args[1]).toBe(berlinDayRangeUnix("2026-08-01").from);
    expect(reads[0].args[2]).toBe(berlinDayRangeUnix("2026-08-31").to);
  });

  it("writes nothing while evaluating", async () => {
    const { client, calls } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    await app.inject({
      method: "GET",
      url: "/me/supports/range?from=2026-08-01&to=2026-08-07",
      headers: { cookie },
    });
    const afterLogin = calls.filter((c) => c.name !== "login");
    expect(afterLogin.map((c) => c.name)).toEqual(["listSupports"]);
  });

  it("refuses broken ranges without asking TANSS, and says which way they are broken", async () => {
    const { client, calls } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    const cases: [string, string][] = [
      ["from=heute&to=2026-08-31", "Zeitraum ungültig"],
      ["from=2026-08-31&to=2026-08-01", "Zeitraum ungültig"],
      // Well shaped, yet no such day exists — at either end of the range.
      ["from=2026-02-30&to=2026-03-31", "Zeitraum ungültig"],
      ["from=2026-02-01&to=2026-02-30", "Zeitraum ungültig"],
      ["from=2025-01-01&to=2026-08-31", "Zeitraum zu lang (höchstens ein Jahr)"],
    ];
    for (const [query, message] of cases) {
      const res = await app.inject({ method: "GET", url: `/me/supports/range?${query}`, headers: { cookie } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(message);
    }
    expect(calls.some((c) => c.name === "listSupports")).toBe(false);
  });

  it("allows exactly a year and refuses the day after it", async () => {
    const { client, calls } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    // 2026-01-01 through 2027-01-01 is 366 days, the documented maximum.
    const ok = await app.inject({
      method: "GET",
      url: "/me/supports/range?from=2026-01-01&to=2027-01-01",
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
    const tooLong = await app.inject({
      method: "GET",
      url: "/me/supports/range?from=2026-01-01&to=2027-01-02",
      headers: { cookie },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error).toBe("Zeitraum zu lang (höchstens ein Jahr)");
    // The refused one never reached TANSS; only the allowed one did.
    expect(calls.filter((c) => c.name === "listSupports")).toHaveLength(1);
  });

  it("demands a session", async () => {
    const { client } = fakeTanss();
    const app = await buildApp({ sessionSecret: SECRET, tanss: client, enableRateLimit: false });
    const res = await app.inject({ method: "GET", url: "/me/supports/range?from=2026-08-01&to=2026-08-07" });
    expect(res.statusCode).toBe(401);
  });

  it("reads the range of another employee when asked for one", async () => {
    const { client, calls } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    const res = await app.inject({
      method: "GET",
      url: "/me/supports/range?from=2026-08-01&to=2026-08-07&employeeId=42",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().employeeId).toBe(42);
    const reads = calls.filter((c) => c.name === "listSupports");
    expect(reads).toHaveLength(1);
    expect(reads[0].args[4]).toBe(42);
  });

  it("falls back to the own employee when none is named", async () => {
    const { client, calls } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    const res = await app.inject({
      method: "GET",
      url: "/me/supports/range?from=2026-08-01&to=2026-08-07",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().employeeId).toBe(SESSION.employeeId);
    const reads = calls.filter((c) => c.name === "listSupports");
    expect(reads[0].args[4]).toBe(SESSION.employeeId);
  });

  it("refuses a broken employee id without asking TANSS", async () => {
    const { client, calls } = fakeTanss();
    const { app, cookie } = await loggedIn(client);
    for (const value of ["abc", "0", "-3", "1.5", ""]) {
      const res = await app.inject({
        method: "GET",
        url: `/me/supports/range?from=2026-08-01&to=2026-08-07&employeeId=${value}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Mitarbeiter ungültig");
    }
    expect(calls.some((c) => c.name === "listSupports")).toBe(false);
  });
});
