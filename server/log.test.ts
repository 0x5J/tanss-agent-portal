import { describe, expect, it } from "vitest";
import { createCallLog, loggableBody, visibleLog } from "./log.ts";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    kind: "tanss" as const,
    method: "POST",
    path: "/api/v1/supports",
    status: 200,
    ok: true,
    durationMs: 12,
    message: "",
    body: "",
    url: "https://tanss.example/backend/api/v1/supports",
    redirected: false,
    response: "",
    traceId: "",
    ...overrides,
  };
}

describe("createCallLog", () => {
  it("hands out increasing ids and keeps insertion order", () => {
    const log = createCallLog();
    log.add(entry());
    log.add(entry({ path: "/api/v1/tickets/own" }));
    expect(log.since(0).map((item) => item.id)).toEqual([1, 2]);
    expect(log.lastId()).toBe(2);
  });

  it("returns only what is newer than the given id, so polling stays cheap", () => {
    const log = createCallLog();
    log.add(entry());
    log.add(entry());
    log.add(entry());
    expect(log.since(2).map((item) => item.id)).toEqual([3]);
    expect(log.since(3)).toEqual([]);
  });

  it("drops the oldest entries once the buffer is full", () => {
    const log = createCallLog(3);
    for (let index = 0; index < 5; index++) log.add(entry());
    const kept = log.since(0);
    expect(kept.map((item) => item.id)).toEqual([3, 4, 5]);
  });

  it("keeps ids stable across a wrap, so a poller never re-reads an entry", () => {
    const log = createCallLog(2);
    log.add(entry());
    log.add(entry());
    const seen = log.lastId();
    log.add(entry());
    expect(log.since(seen).map((item) => item.id)).toEqual([3]);
  });

  it("caps an oversized payload instead of holding it whole", () => {
    const log = createCallLog();
    const stored = log.add(entry({ body: "x".repeat(5000) }));
    expect(stored.body.length).toBe(2000);
  });

  it("stamps the time from the injected clock", () => {
    const log = createCallLog(10, () => 1_700_000_000_000);
    expect(log.add(entry()).at).toBe(1_700_000_000_000);
  });

  it("forgets everything on clear but keeps counting ids", () => {
    const log = createCallLog();
    log.add(entry());
    log.clear();
    expect(log.since(0)).toEqual([]);
    expect(log.add(entry()).id).toBe(2);
  });
});

describe("loggableBody", () => {
  it("never records the login payload", () => {
    expect(loggableBody("/api/v1/login", { username: "sj", password: "geheim" })).toBe(
      "(Zugangsdaten nicht protokolliert)",
    );
  });

  it("records an ordinary payload so a rejected booking can be inspected", () => {
    expect(loggableBody("/api/v1/supports", { duration: 60 })).toBe('{"duration":60}');
  });

  it("records nothing for a request without a body", () => {
    expect(loggableBody("/api/v1/tickets/own", undefined)).toBe("");
  });
});

describe("visibleLog", () => {
  it("shows TANSS calls to everyone and webhook calls only to their owner", () => {
    const log = createCallLog();
    log.add(entry());
    log.add(entry({ kind: "webhook", employeeId: 7, path: "https://hooks.example/a" }));
    log.add(entry({ kind: "webhook", employeeId: 8, path: "https://hooks.example/b" }));
    log.add(entry({ kind: "webhook", path: "https://hooks.example/ohne-besitzer" }));
    expect(visibleLog(log.since(0), 7).map((e) => e.path)).toEqual(["/api/v1/supports", "https://hooks.example/a"]);
    expect(visibleLog(log.since(0), 8).map((e) => e.path)).toEqual(["/api/v1/supports", "https://hooks.example/b"]);
  });
});
