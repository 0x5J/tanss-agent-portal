import { describe, expect, it } from "vitest";
import { createLoginGate, isCredentialRejection } from "./login.ts";
import { createPoller } from "./poller.ts";
import { createMemoryStore } from "./store.ts";
import { createTanssClient, TanssError, tanssErrorText, type TanssClient, type TanssSession } from "./tanss.ts";

const SESSION: TanssSession = { employeeId: 7, apiKey: "a", refresh: "r", expire: 9_999_999_999 };

function gateWith(login: TanssClient["login"], startMs = 1_000_000_000_000) {
  let clock = startMs;
  const stops: string[] = [];
  const gate = createLoginGate({
    tanss: { login } as TanssClient,
    credentials: { username: "sb", password: "pw" },
    totp: null,
    now: () => clock,
    onStop: (reason) => stops.push(reason),
  });
  return { gate, stops, advance: (minutes: number) => (clock += minutes * 60_000) };
}

describe("what TANSS says when it rejects a login", () => {
  it("reads the reason out of error.message, the field the live login uses", () => {
    expect(tanssErrorText({ message: "LOGIN_ERROR_INVALID_USERNAME_OR_PASSWORD" })).toBe(
      "Benutzername oder Passwort ist falsch",
    );
    expect(tanssErrorText({ message: "LOGIN_ERROR_INVALID_TOKEN" })).toBe("Der 2FA-Code wurde abgelehnt");
    // text/localizedText keep precedence, and free prose stays untouched.
    expect(tanssErrorText({ text: "Kaputt", message: "EGAL" })).toBe("Kaputt");
    expect(tanssErrorText({ message: "Etwas ist schiefgelaufen" })).toBe("Etwas ist schiefgelaufen");
  });

  it("turns the live 404 rejection into a rejection, not a missing route", async () => {
    const client = createTanssClient({
      baseUrl: "http://tanss.test",
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "LOGIN_ERROR_INVALID_USERNAME_OR_PASSWORD" } }), {
          status: 404,
        }),
    });
    const error = await client.login({ username: "sb", password: "x", token: "123456" }).catch((e: unknown) => e);
    expect((error as TanssError).message).toBe("Benutzername oder Passwort ist falsch");
    // The safety rule depends on this: a rejection must never look like an outage.
    expect(isCredentialRejection(error)).toBe(true);
  });
});

describe("isCredentialRejection", () => {
  it("knows a rejection from an outage", () => {
    expect(isCredentialRejection(new TanssError("Benutzername oder Passwort ist falsch", 403))).toBe(true);
    expect(isCredentialRejection(new TanssError("Der 2FA-Code wurde abgelehnt", 401))).toBe(true);
    // The live installation answers a bad login with 404 plus this text.
    expect(isCredentialRejection(new TanssError("LOGIN_ERROR_INVALID_USERNAME_OR_PASSWORD", 404))).toBe(true);
    expect(isCredentialRejection(new TanssError("TANSS hat auf die Anmeldung nicht geantwortet (30 s)", 504))).toBe(false);
    expect(isCredentialRejection(new TanssError("502 Proxy Error", 502))).toBe(false);
    expect(isCredentialRejection(new Error("kaputt"))).toBe(false);
  });
});

describe("login gate", () => {
  it("never repeats credentials TANSS rejected", async () => {
    let attempts = 0;
    const { gate, stops, advance } = gateWith(async () => {
      attempts++;
      throw new TanssError("Benutzername oder Passwort ist falsch", 403);
    });
    await expect(gate.login()).rejects.toThrow(/falsch/);
    expect(attempts).toBe(1);
    // Not after a minute, not after a day: a rejected password stays untried.
    advance(60 * 24);
    await expect(gate.login()).rejects.toThrow(/lehnt die hinterlegten Zugangsdaten ab/);
    await expect(gate.login()).rejects.toThrow(/neu starten/);
    expect(attempts).toBe(1);
    expect(gate.health()).toMatchObject({ stopped: true, failures: 1 });
    expect(stops[0]).toMatch(/kein Konto gesperrt/);
  });

  it("backs off on an outage and gives up after four attempts", async () => {
    let attempts = 0;
    const { gate, stops, advance } = gateWith(async () => {
      attempts++;
      throw new TanssError("TANSS hat auf die Anmeldung nicht geantwortet (30 s)", 504);
    });
    await expect(gate.login()).rejects.toThrow();
    expect(attempts).toBe(1);
    // Blocked for five minutes — the old code tried again right here.
    advance(4);
    await expect(gate.login()).rejects.toThrow(/pausiert/);
    expect(attempts).toBe(1);
    advance(2);
    await expect(gate.login()).rejects.toThrow();
    expect(attempts).toBe(2);
    advance(16);
    await expect(gate.login()).rejects.toThrow();
    expect(attempts).toBe(3);
    advance(46);
    await expect(gate.login()).rejects.toThrow();
    expect(attempts).toBe(4);
    // Four is the ceiling; from here only an operator restarts it.
    advance(600);
    await expect(gate.login()).rejects.toThrow(/Automatische Anmeldung aus/);
    expect(attempts).toBe(4);
    expect(gate.health().stopped).toBe(true);
    expect(stops).toHaveLength(1);
  });

  it("counts the pause from the failure, not from the start of a hanging login", async () => {
    let clock = 1_000_000_000_000;
    let attempts = 0;
    const gate = createLoginGate({
      tanss: {
        login: async () => {
          attempts++;
          // A login that hangs for 30 s before it fails.
          clock += 30_000;
          throw new TanssError("TANSS hat auf die Anmeldung nicht geantwortet (30 s)", 504);
        },
      } as unknown as TanssClient,
      credentials: { username: "sb", password: "pw" },
      totp: null,
      now: () => clock,
    });
    await gate.login().catch(() => null);
    // Five minutes after the failure — not after the call began.
    clock += 4 * 60_000 + 45_000;
    await expect(gate.login()).rejects.toThrow(/pausiert/);
    expect(attempts).toBe(1);
    clock += 20_000;
    await gate.login().catch(() => null);
    expect(attempts).toBe(2);
  });

  it("counts an hour of outage as at most four attempts", async () => {
    let attempts = 0;
    const { gate, advance } = gateWith(async () => {
      attempts++;
      throw new TanssError("502 Proxy Error", 502);
    });
    for (let minute = 0; minute < 60; minute++) {
      await gate.login().catch(() => null);
      advance(1);
    }
    expect(attempts).toBeLessThanOrEqual(4);
  });

  it("shares one attempt between parallel callers", async () => {
    let attempts = 0;
    const { gate } = gateWith(async () => {
      attempts++;
      await new Promise((r) => setTimeout(r, 5));
      return { ...SESSION };
    });
    const [a, b] = await Promise.all([gate.login(), gate.login()]);
    expect(attempts).toBe(1);
    expect(a.apiKey).toBe(b.apiKey);
  });

  it("forgets the failures after a success", async () => {
    let fail = true;
    const { gate, advance } = gateWith(async () => {
      if (fail) throw new TanssError("502 Proxy Error", 502);
      return { ...SESSION };
    });
    await gate.login().catch(() => null);
    expect(gate.health().failures).toBe(1);
    fail = false;
    advance(6);
    await gate.login();
    expect(gate.health()).toMatchObject({ failures: 0, stopped: false, retryAfter: 0, lastError: "" });
  });
});

describe("poller with a broken login", () => {
  it("stops asking instead of hammering, and says so in its health", async () => {
    let attempts = 0;
    const tanss = {
      login: async () => {
        attempts++;
        throw new TanssError("Benutzername oder Passwort ist falsch", 403);
      },
      ticketList: async () => ({ items: [], linked: {}, waitingStates: [] }),
    } as unknown as TanssClient;
    const gate = createLoginGate({
      tanss,
      credentials: { username: "sb", password: "falsch" },
      totp: null,
    });
    const errors: string[] = [];
    const poller = createPoller({ tanss, store: createMemoryStore(), gate, onError: (m) => errors.push(m) });
    for (let i = 0; i < 12; i++) await poller.tick();
    expect(attempts).toBe(1);
    // Two lines in the log, not twelve: what TANSS said, then that the gate
    // stopped. Every further tick repeats the same message and stays quiet.
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/falsch/);
    expect(errors[1]).toMatch(/Automatische Anmeldung aus/);
    expect(poller.health()).toMatchObject({ stopped: true, lastSampleAt: 0 });
    expect(poller.health().lastError).toMatch(/falsch/);
  });
});
