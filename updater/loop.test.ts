import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UpdateRequest, UpdateStatus } from "../shared/update.ts";
import { createLoop } from "./loop.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "updater-loop-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const request: UpdateRequest = { id: "r1", version: "0.2.0", requestedAt: 1000 };

function done(id: string): UpdateStatus {
  return { id, state: "done", from: "0.1.0", to: "0.2.0", message: "", at: 2000 };
}

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join(dir, name), "utf8"));
}

function setup(run: (r: UpdateRequest) => Promise<UpdateStatus> = async (r) => done(r.id)) {
  const calls: UpdateRequest[] = [];
  const loop = createLoop({
    dir,
    version: "0.1.0",
    run: async (r) => {
      calls.push(r);
      return run(r);
    },
    now: () => 4242,
  });
  return { loop, calls };
}

describe("createLoop", () => {
  it("writes the heartbeat on every tick", async () => {
    const { loop, calls } = setup();
    await loop.tick();
    expect(readJson("heartbeat.json")).toEqual({ at: 4242, version: "0.1.0" });
    expect(calls).toHaveLength(0);
  });

  it("creates the folder if it is missing", async () => {
    const nested = path.join(dir, "sub", "update");
    const loop = createLoop({ dir: nested, version: "x", run: async (r) => done(r.id), now: () => 1 });
    await loop.tick();
    expect(JSON.parse(readFileSync(path.join(nested, "heartbeat.json"), "utf8"))).toEqual({ at: 1, version: "x" });
  });

  it("runs a valid request once, removes it and stores the result", async () => {
    writeFileSync(path.join(dir, "request.json"), JSON.stringify(request));
    const { loop, calls } = setup();
    await loop.tick();
    expect(calls).toEqual([request]);
    expect(existsSync(path.join(dir, "request.json"))).toBe(false);
    expect(readJson("status.json")).toEqual(done("r1"));
    await loop.tick();
    expect(calls).toHaveLength(1);
  });

  it("deletes the request before running it", async () => {
    writeFileSync(path.join(dir, "request.json"), JSON.stringify(request));
    let existedDuringRun = true;
    const { loop } = setup(async (r) => {
      existedDuringRun = existsSync(path.join(dir, "request.json"));
      return done(r.id);
    });
    await loop.tick();
    expect(existedDuringRun).toBe(false);
  });

  it("reports a garbled request as failed", async () => {
    writeFileSync(path.join(dir, "request.json"), "{ nicht json");
    const { loop, calls } = setup();
    await loop.tick();
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(dir, "request.json"))).toBe(false);
    expect(readJson("status.json")).toEqual({
      id: "",
      state: "failed",
      from: "",
      to: "",
      message: "Auftrag unlesbar",
      at: 4242,
    });
  });

  it("reports a request with a wrong shape as failed, keeping id and version it has", async () => {
    writeFileSync(path.join(dir, "request.json"), JSON.stringify({ id: "r9", version: "0.3.0", requestedAt: "heute" }));
    const { loop, calls } = setup();
    await loop.tick();
    expect(calls).toHaveLength(0);
    expect(readJson("status.json")).toMatchObject({
      id: "r9",
      state: "failed",
      to: "0.3.0",
      message: "Auftrag unlesbar",
    });
  });

  it("ignores a request whose id is already in status.json", async () => {
    writeFileSync(path.join(dir, "status.json"), JSON.stringify(done("r1")));
    writeFileSync(path.join(dir, "request.json"), JSON.stringify(request));
    const { loop, calls } = setup();
    await loop.tick();
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(dir, "request.json"))).toBe(false);
    expect(readJson("status.json")).toEqual(done("r1"));
  });

  it("does not start a second update while one is running", async () => {
    writeFileSync(path.join(dir, "request.json"), JSON.stringify(request));
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { loop, calls } = setup(async (r) => {
      await gate;
      return done(r.id);
    });
    const first = loop.tick();
    writeFileSync(path.join(dir, "request.json"), JSON.stringify({ ...request, id: "r2" }));
    rmSync(path.join(dir, "heartbeat.json"));
    await loop.tick();
    // the overlapping tick still proves the updater is alive
    expect(existsSync(path.join(dir, "heartbeat.json"))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(existsSync(path.join(dir, "request.json"))).toBe(true);
    release();
    await first;
    await loop.tick();
    expect(calls.map((c) => c.id)).toEqual(["r1", "r2"]);
  });

  it("leaves no temporary files behind", async () => {
    writeFileSync(path.join(dir, "request.json"), JSON.stringify(request));
    const { loop } = setup();
    await loop.tick();
    expect(existsSync(path.join(dir, "status.json.tmp"))).toBe(false);
    expect(existsSync(path.join(dir, "heartbeat.json.tmp"))).toBe(false);
  });
});
