import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseInfo, UpdateChannel } from "../shared/update.ts";
import type { ReleaseSource } from "./releases.ts";
import { createUpdateService, UpdateError } from "./updates.ts";

const NOW = 1_800_000_000_000;

const release = (version: string): ReleaseInfo => ({
  version,
  notes: `Notes ${version}`,
  url: `https://example.test/${version}`,
  prerelease: false,
  publishedAt: "2026-10-01T10:00:00Z",
});

function fakeSource(result: ReleaseInfo | null | Error) {
  const calls: UpdateChannel[] = [];
  const source: ReleaseSource = {
    async latest(channel) {
      calls.push(channel);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { source, calls };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "updates-"));
});

afterEach(() => {
  vi.useRealTimers();
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

function service(over: Partial<Parameters<typeof createUpdateService>[0]> = {}) {
  return createUpdateService({
    dir,
    current: "0.1.0",
    channel: "stable",
    enabled: true,
    source: fakeSource(release("0.2.0")).source,
    now: () => NOW,
    newId: () => "id-1",
    ...over,
  });
}

const writeJson = (name: string, value: unknown) => writeFileSync(path.join(dir, name), JSON.stringify(value));
const requestPath = () => path.join(dir, "request.json");
const heartbeat = (age = 1000) => writeJson("heartbeat.json", { at: NOW - age, version: "0.1.0" });

async function expectUpdateError(fn: () => unknown, status: number, message: string) {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(UpdateError);
  expect((caught as UpdateError).status).toBe(status);
  expect((caught as UpdateError).message).toBe(message);
}

describe("overview", () => {
  it("without files: updater missing, nothing offered", () => {
    const o = service().overview();
    expect(o).toEqual({
      current: "0.1.0",
      channel: "stable",
      enabled: true,
      latest: null,
      checkedAt: null,
      checkError: null,
      updater: "missing",
      requested: null,
      status: null,
    });
  });

  it("updater is ready with a fresh heartbeat", () => {
    heartbeat(5000);
    expect(service().overview().updater).toBe("ready");
  });

  it("updater is missing with a stale heartbeat", () => {
    heartbeat(61_000);
    expect(service().overview().updater).toBe("missing");
  });

  it("garbled status.json counts as absent", () => {
    writeFileSync(path.join(dir, "status.json"), "{not json");
    writeFileSync(path.join(dir, "heartbeat.json"), "");
    const o = service().overview();
    expect(o.status).toBeNull();
    expect(o.updater).toBe("missing");
  });

  it("reads status and open request from disk", () => {
    const status = { id: "x", state: "pulling", from: "0.1.0", to: "0.2.0", message: "", at: NOW };
    const req = { id: "x", version: "0.2.0", requestedAt: NOW };
    writeJson("status.json", status);
    writeJson("request.json", req);
    const o = service().overview();
    expect(o.status).toEqual(status);
    expect(o.requested).toEqual(req);
  });
});

describe("check", () => {
  it("stores the latest release and the check time", async () => {
    const { source, calls } = fakeSource(release("0.2.0"));
    const svc = service({ source, channel: "staging" });
    const o = await svc.check();
    expect(calls).toEqual(["staging"]);
    expect(o.latest?.version).toBe("0.2.0");
    expect(o.checkedAt).toBe(NOW);
    expect(o.checkError).toBeNull();
    expect(svc.overview().latest?.version).toBe("0.2.0");
  });

  it("keeps the previous release and reports the error when the source throws", async () => {
    let fail = false;
    const source: ReleaseSource = {
      async latest() {
        if (fail) throw new Error("GitHub antwortet nicht");
        return release("0.2.0");
      },
    };
    const svc = service({ source });
    await svc.check();
    fail = true;
    const o = await svc.check();
    expect(o.checkError).toContain("GitHub antwortet nicht");
    expect(o.latest?.version).toBe("0.2.0");
    fail = false;
    expect((await svc.check()).checkError).toBeNull();
  });

  it("does not ask the source when disabled", async () => {
    const { source, calls } = fakeSource(release("0.2.0"));
    const svc = service({ source, enabled: false });
    const o = await svc.check();
    expect(calls).toEqual([]);
    expect(o.enabled).toBe(false);
    expect(o.latest).toBeNull();
  });
});

describe("request", () => {
  async function ready(over: Partial<Parameters<typeof createUpdateService>[0]> = {}) {
    const svc = service(over);
    await svc.check();
    return svc;
  }

  it("writes request.json for the offered newer version", async () => {
    heartbeat();
    const svc = await ready();
    const o = svc.request("0.2.0");
    const expected = { id: "id-1", version: "0.2.0", requestedAt: NOW };
    expect(JSON.parse(readFileSync(requestPath(), "utf8"))).toEqual(expected);
    expect(o.requested).toEqual(expected);
  });

  it("rejects a version that is not the offered one", async () => {
    heartbeat();
    const svc = await ready();
    await expectUpdateError(() => svc.request("0.3.0"), 409, "Diese Version wird nicht angeboten");
    expect(existsSync(requestPath())).toBe(false);
  });

  it("rejects an offer that is not newer than the running version", async () => {
    heartbeat();
    const svc = await ready({ current: "0.2.0" });
    await expectUpdateError(() => svc.request("0.2.0"), 409, "Keine neuere Version verfügbar");
    expect(existsSync(requestPath())).toBe(false);
  });

  it("rejects when the updater is missing", async () => {
    const svc = await ready();
    await expectUpdateError(() => svc.request("0.2.0"), 409, "Der Updater läuft nicht");
    expect(existsSync(requestPath())).toBe(false);
  });

  it("rejects a second request right after the first", async () => {
    heartbeat();
    const svc = await ready();
    svc.request("0.2.0");
    const first = readFileSync(requestPath(), "utf8");
    await expectUpdateError(() => svc.request("0.2.0"), 409, "Es läuft bereits ein Update");
    expect(readFileSync(requestPath(), "utf8")).toBe(first);
  });

  it("rejects while the updater is working on a fresh status", async () => {
    heartbeat();
    writeJson("status.json", { id: "x", state: "pulling", from: "0.1.0", to: "0.2.0", message: "", at: NOW - 1000 });
    const svc = await ready();
    await expectUpdateError(() => svc.request("0.2.0"), 409, "Es läuft bereits ein Update");
  });

  it.skipIf(process.getuid?.() === 0)("reports an unwritable folder as 503", async () => {
    heartbeat();
    const svc = await ready();
    chmodSync(dir, 0o500);
    await expectUpdateError(() => svc.request("0.2.0"), 503, "Update-Ordner nicht beschreibbar");
  });

  it("leaves only names in the folder that the updater accepts, even on failure", async () => {
    heartbeat();
    const svc = await ready();
    // A directory in place of request.json makes the final rename fail.
    mkdirSync(requestPath());
    await expectUpdateError(() => svc.request("0.2.0"), 503, "Update-Ordner nicht beschreibbar");
    expect(readdirSync(dir).sort()).toEqual(["heartbeat.json", "request.json"]);
  });

  it("reads a folder that does not exist yet as updater missing", () => {
    const svc = service({ dir: path.join(dir, "sub", "update") });
    const o = svc.overview();
    expect(o.updater).toBe("missing");
    expect(o.requested).toBeNull();
    expect(o.status).toBeNull();
  });
});

describe("start/stop", () => {
  it("checks after the first delay, then on the interval, until stopped", async () => {
    vi.useFakeTimers();
    const { source, calls } = fakeSource(release("0.2.0"));
    const svc = service({ source, firstCheckMs: 1000, intervalMs: 5000 });
    svc.start();
    expect(calls.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.length).toBe(2);
    svc.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks 10 s after start and then every hour by default", async () => {
    vi.useFakeTimers();
    const { source, calls } = fakeSource(release("0.2.0"));
    const svc = service({ source });
    svc.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.length).toBe(1);
    // The hourly timer runs from start(), not from the first check.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 10_000 - 1);
    expect(calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.length).toBe(2);
    svc.stop();
  });

  it("stop before the first check cancels it", async () => {
    vi.useFakeTimers();
    const { source, calls } = fakeSource(release("0.2.0"));
    const svc = service({ source, firstCheckMs: 1000, intervalMs: 5000 });
    svc.start();
    svc.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.length).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
