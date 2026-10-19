import { describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";
import { type TanssClient, type TanssSession } from "./tanss.ts";
import { lockReason } from "../shared/lock.ts";
import { toSupport } from "../shared/timeline.ts";

const SECRET = "x".repeat(32);
const SESSION: TanssSession = { employeeId: 7, apiKey: "a", refresh: "r", expire: 9_999_999_999 };

const BOOKING = {
  id: 900,
  date: Date.parse("2026-08-20T09:00:00+02:00") / 1000,
  duration: 60,
  ticketId: 4711,
  typeId: 3,
  location: "OFFICE",
  text: "Alte Fassung",
  employeeId: 7,
  linkTypeId: 11,
  linkId: 4711,
};

function fakeTanss(support: Record<string, unknown> = BOOKING, onUpdate?: (b: unknown) => void): TanssClient {
  return {
    login: async () => ({ ...SESSION }),
    supportById: async () => ({ item: support, linked: {} }),
    ticketById: async (_s: unknown, id: number) => ({ item: { id, companyId: 77 }, linked: {} }),
    updateSupport: async (_s: unknown, _id: number, body: unknown) => {
      onUpdate?.(body);
      return { id: 900 };
    },
  } as unknown as TanssClient;
}

async function loggedIn(tanss: TanssClient) {
  const app = await buildApp({ sessionSecret: SECRET, tanss, enableRateLimit: false });
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "sb", password: "pw", token: "123456" },
  });
  const raw = res.headers["set-cookie"];
  return { app, cookie: Array.isArray(raw) ? raw[0] : String(raw ?? "") };
}

describe("lockReason", () => {
  const base = toSupport(BOOKING, {});
  it("names the first reason that applies", () => {
    expect(lockReason(base, 7)).toBeNull();
    expect(lockReason({ ...base, booked: true }, 7)).toBe("booked");
    expect(lockReason({ ...base, clearanceStatus: "CLEARED" }, 7)).toBe("cleared");
    expect(lockReason({ ...base, voucherId: 5 }, 7)).toBe("voucher");
    // Somebody else's booking is off limits before anything else is asked.
    expect(lockReason({ ...base, employeeId: 8, booked: true }, 7)).toBe("foreign");
  });
});

describe("editing a booking", () => {
  it("changes duration and text and keeps the rest of the object", async () => {
    let sent: Record<string, unknown> = {};
    const { app, cookie } = await loggedIn(fakeTanss(BOOKING, (b) => (sent = b as Record<string, unknown>)));
    const res = await app.inject({
      method: "PUT",
      url: "/me/supports/900",
      headers: { cookie },
      payload: { duration: 90, text: "Neue Fassung" },
    });
    expect(res.statusCode).toBe(200);
    expect(sent.duration).toBe(90);
    expect(sent.text).toBe("Neue Fassung");
    // TANSS takes the whole object; untouched fields must survive.
    expect(sent.typeId).toBe(3);
    expect(sent.linkId).toBe(4711);
    expect(res.json().support.duration).toBe(90);
  });

  it("moves the booking to another time of the same day", async () => {
    let sent: Record<string, unknown> = {};
    const { app, cookie } = await loggedIn(fakeTanss(BOOKING, (b) => (sent = b as Record<string, unknown>)));
    await app.inject({
      method: "PUT",
      url: "/me/supports/900",
      headers: { cookie },
      payload: { startMinute: 14 * 60 + 30 },
    });
    expect(sent.date).toBe(Date.parse("2026-08-20T14:30:00+02:00") / 1000);
  });

  it("rewrites the assignment when the target changes", async () => {
    let sent: Record<string, unknown> = {};
    const { app, cookie } = await loggedIn(fakeTanss(BOOKING, (b) => (sent = b as Record<string, unknown>)));
    await app.inject({
      method: "PUT",
      url: "/me/supports/900",
      headers: { cookie },
      payload: { companyId: 55 },
    });
    // A stale linkId would book onto the old ticket.
    expect(sent).toMatchObject({ companyId: 55, ticketId: 0, linkTypeId: 2, linkId: 55 });
  });

  it("takes the company from the ticket when retargeting onto one", async () => {
    let sent: Record<string, unknown> = {};
    const { app, cookie } = await loggedIn(fakeTanss(BOOKING, (b) => (sent = b as Record<string, unknown>)));
    await app.inject({
      method: "PUT",
      url: "/me/supports/900",
      headers: { cookie },
      payload: { ticketId: 4712 },
    });
    // companyId 0 makes TANSS refuse the assignment as outside the company.
    expect(sent).toMatchObject({ ticketId: 4712, linkTypeId: 11, linkId: 4712, companyId: 77 });
  });

  it("refuses an invoiced booking with the reason", async () => {
    const { app, cookie } = await loggedIn(fakeTanss({ ...BOOKING, booked: true }));
    const res = await app.inject({
      method: "PUT",
      url: "/me/supports/900",
      headers: { cookie },
      payload: { duration: 90 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/abgerechnet/);
  });

  it("refuses somebody else's booking with 403", async () => {
    const { app, cookie } = await loggedIn(fakeTanss({ ...BOOKING, employeeId: 8 }));
    const res = await app.inject({
      method: "PUT",
      url: "/me/supports/900",
      headers: { cookie },
      payload: { duration: 90 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/anderen Mitarbeiter/);
  });

  it("reads one booking and says whether it is locked", async () => {
    const { app, cookie } = await loggedIn(fakeTanss({ ...BOOKING, clearanceStatus: "CLEARED" }));
    const res = await app.inject({ method: "GET", url: "/me/supports/900", headers: { cookie } });
    expect(res.json()).toMatchObject({ locked: true, lockReason: "cleared" });
    expect(res.json().lockText).toMatch(/freigegeben/);
  });

  it("refuses a time that does not exist on that day", async () => {
    const { app, cookie } = await loggedIn(fakeTanss());
    const res = await app.inject({
      method: "PUT",
      url: "/me/supports/900",
      headers: { cookie },
      payload: { date: "2026-03-29", startMinute: 2 * 60 + 30 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Uhrzeit/);
  });
});

describe("Stufe 1: interne und nicht berechnete Zeit", () => {
  it("sends internal and the non-charged minutes when booking", async () => {
    let sent: Record<string, unknown> = {};
    const tanss = {
      login: async () => ({ ...SESSION }),
      ticketById: async (_s: unknown, id: number) => ({ item: { id, companyId: 77 }, linked: {} }),
      createSupport: async (_s: unknown, body: unknown) => {
        sent = body as Record<string, unknown>;
        return { id: 1 };
      },
    } as unknown as TanssClient;
    const { app, cookie } = await loggedIn(tanss);
    const res = await app.inject({
      method: "POST",
      url: "/me/supports",
      headers: { cookie },
      payload: {
        date: "2026-08-20",
        startMinute: 9 * 60,
        duration: 60,
        ticketId: 4711,
        typeId: 3,
        location: "OFFICE",
        text: "Arbeit",
        internal: true,
        durationNotCharged: 15,
        reasonNotChargedText: "Kulanz",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(sent).toMatchObject({ internal: true, durationNotCharged: 15, reasonNotChargedText: "Kulanz" });
  });

  it("refuses non-charged time longer than the booking", async () => {
    const tanss = { login: async () => ({ ...SESSION }), createSupport: async () => ({ id: 1 }) } as unknown as TanssClient;
    const { app, cookie } = await loggedIn(tanss);
    const res = await app.inject({
      method: "POST",
      url: "/me/supports",
      headers: { cookie },
      payload: {
        date: "2026-08-20",
        startMinute: 9 * 60,
        duration: 30,
        ticketId: 4711,
        typeId: 3,
        location: "OFFICE",
        text: "Arbeit",
        durationNotCharged: 45,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/länger als die Leistung/);
  });
});
