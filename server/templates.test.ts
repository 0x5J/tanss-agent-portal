import { describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { buildPhoneCallsBody, buildSupportsListBody, type TanssClient, type TanssSession } from "./tanss.ts";
import { createMemoryStore } from "./store.ts";

const SECRET = "x".repeat(32);
const SESSION: TanssSession = { employeeId: 7, apiKey: "a", refresh: "r", expire: 9_999_999_999 };
const at = (iso: string) => Date.parse(iso) / 1000;

const ITEMS = [
  { id: 1, date: at("2026-08-25T09:00:00+02:00"), duration: 60, planningType: "SUPPORT", text: "Gebucht", ticketId: 4711, employeeId: 7 },
  { id: 900, date: at("2026-08-25T11:00:00+02:00"), duration: 45, planningType: "APPOINTMENT_FIX", outlookTitle: "Jour fixe", teamsUrl: "https://teams", companyId: 5 },
];
const CALLS = [
  { id: 12, date: at("2026-08-25T14:00:00+02:00"), direction: "IN", connectionEstablished: true, durationCall: 200, fromPhoneNumber: "+49401", fromPhoneNrInfos: { result: { name: "Müller AG", companyId: 7 } } },
  { id: 13, date: at("2026-08-25T15:00:00+02:00"), direction: "IN", connectionEstablished: false, durationCall: 5 },
];

function fakeTanss(over: Partial<TanssClient> = {}, spy?: (name: string, args: unknown[]) => void): TanssClient {
  return {
    login: async () => ({ ...SESSION }),
    listSupports: async (...args: unknown[]) => {
      spy?.("listSupports", args);
      return { items: ITEMS, linked: { companies: { "5": { name: "Kranz GmbH" } } } };
    },
    listPhoneCalls: async (...args: unknown[]) => {
      spy?.("listPhoneCalls", args);
      return CALLS;
    },
    createSupport: async () => ({ id: 555 }),
    ...over,
  } as unknown as TanssClient;
}

async function loggedIn(tanss: TanssClient, store = createMemoryStore()) {
  const app = await buildApp({ sessionSecret: SECRET, tanss, enableRateLimit: false, store });
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "sb", password: "pw", token: "123456" } });
  const raw = res.headers["set-cookie"];
  return { app, store, cookie: Array.isArray(raw) ? raw[0] : String(raw ?? "") };
}

describe("request bodies", () => {
  it("asks for supports and appointments in one call", () => {
    expect(buildSupportsListBody(7, 1, 2)).toMatchObject({ planningTypes: ["SUPPORT"] });
    expect(buildSupportsListBody(7, 1, 2, ["SUPPORT", "APPOINTMENT_FIX"]).planningTypes).toEqual(["SUPPORT", "APPOINTMENT_FIX"]);
    expect(buildPhoneCallsBody(7, 1, 2)).toEqual({ timeframe: { from: 1, to: 2 }, employeeId: 7, showTrysAsWell: false });
  });
});

describe("templates next to the day", () => {
  it("keeps appointments out of the booked time and offers them separately", async () => {
    const { app, cookie } = await loggedIn(fakeTanss());
    const body = (await app.inject({ method: "GET", url: "/me/supports?day=2026-08-25", headers: { cookie } })).json();
    // The appointment must never show up as booked time.
    expect(body.supports.map((s: { id: number }) => s.id)).toEqual([1]);
    expect(body.templates.map((t: { key: string }) => t.key)).toEqual(["termin:900", "anruf:12"]);
    expect(body.templates[0]).toMatchObject({ location: "REMOTE", title: "Jour fixe", companyName: "Kranz GmbH", duration: 45 });
    // The unanswered five-second call is not work.
    expect(body.templates.some((t: { key: string }) => t.key === "anruf:13")).toBe(false);
  });

  it("stops offering a template once it was booked", async () => {
    const { app, cookie, store } = await loggedIn(fakeTanss());
    const booked = await app.inject({
      method: "POST",
      url: "/me/supports",
      headers: { cookie },
      payload: {
        date: "2026-08-25", startMinute: 11 * 60, duration: 45, companyId: 5,
        typeId: 3, location: "REMOTE", text: "Jour fixe", fromTemplate: "termin:900",
      },
    });
    expect(booked.statusCode).toBe(200);
    expect(store.templateBookings(7)).toEqual({ "termin:900|2026-08-25": 555 });
    const body = (await app.inject({ method: "GET", url: "/me/supports?day=2026-08-25", headers: { cookie } })).json();
    expect(body.templates.map((t: { key: string }) => t.key)).toEqual(["anruf:12"]);
  });

  it("still shows the day when phone calls are not available", async () => {
    const tanss = fakeTanss({
      listPhoneCalls: async () => {
        throw new Error("Telefonie-Modul fehlt");
      },
    });
    const { app, cookie } = await loggedIn(tanss);
    const res = await app.inject({ method: "GET", url: "/me/supports?day=2026-08-25", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().templates.map((t: { key: string }) => t.key)).toEqual(["termin:900"]);
  });
});

describe("robustness", () => {
  it("falls back to plain supports when the calendar types are refused", async () => {
    const asked: unknown[][] = [];
    const tanss = fakeTanss({
      listSupports: async (...args: unknown[]) => {
        asked.push(args);
        if (args[3]) throw new Error("planningTypes nicht unterstützt");
        return { items: [ITEMS[0]], linked: {} };
      },
    } as Partial<TanssClient>);
    const { app, cookie } = await loggedIn(tanss);
    const res = await app.inject({ method: "GET", url: "/me/supports?day=2026-08-25", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().supports).toHaveLength(1);
    // Asked with the calendar types first, then without.
    expect(asked).toHaveLength(2);
    expect(asked[1][3]).toBeUndefined();
  });
});

describe("Bausteine", () => {
  it("stores what survives the tolerant reader and hands it back", async () => {
    const { app, cookie, store } = await loggedIn(fakeTanss());
    const put = await app.inject({
      method: "PUT",
      url: "/me/routines",
      headers: { cookie },
      payload: {
        routines: [
          { id: "a", text: "Mail und Monitoring", minMinutes: 60, maxMinutes: 15 },
          { text: "   " },
          { text: "Triage", ticketId: 4711, ticketLabel: "#4711 Triage", companyId: 9 },
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    const saved = put.json().routines;
    expect(saved).toHaveLength(2);
    // Reversed range corrected, not rejected.
    expect(saved[0]).toMatchObject({ minMinutes: 15, maxMinutes: 60 });
    // One target, never both.
    expect(saved[1]).toMatchObject({ ticketId: 4711, companyId: null });
    expect(store.routines(7)).toHaveLength(2);
    const get = await app.inject({ method: "GET", url: "/me/routines", headers: { cookie } });
    expect(get.json().routines).toHaveLength(2);
  });

  it("requires a session", async () => {
    const app = await buildApp({ sessionSecret: SECRET, tanss: fakeTanss(), enableRateLimit: false });
    expect((await app.inject({ method: "GET", url: "/me/routines" })).statusCode).toBe(401);
  });
});
