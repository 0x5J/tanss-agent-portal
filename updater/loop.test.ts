import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UpdateRequest, UpdateStatus } from "../shared/update.ts";
import { checkUpdateDir, createLoop, readStatus } from "./loop.ts";

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

  it("confirms the request in status.json before it runs", async () => {
    writeFileSync(path.join(dir, "request.json"), JSON.stringify(request));
    let seen: unknown = null;
    const { loop } = setup(async (r) => {
      seen = readJson("status.json");
      return done(r.id);
    });
    await loop.tick();
    expect(seen).toEqual({ id: "r1", state: "pulling", from: "", to: "0.2.0", message: "Auftrag angenommen", at: 4242 });
  });

  it("keeps the request when the confirmation cannot be written", async () => {
    // A directory in place of status.json makes the atomic rename fail.
    mkdirSync(path.join(dir, "status.json"));
    writeFileSync(path.join(dir, "request.json"), JSON.stringify(request));
    const { loop, calls } = setup();
    await expect(loop.tick()).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(dir, "request.json"))).toBe(true);
  });

  it("does not replay a request that was confirmed before a crash", async () => {
    writeFileSync(
      path.join(dir, "status.json"),
      JSON.stringify({ id: "r1", state: "pulling", from: "", to: "0.2.0", message: "Auftrag angenommen", at: 1 }),
    );
    writeFileSync(path.join(dir, "request.json"), JSON.stringify(request));
    const { loop, calls } = setup();
    await loop.tick();
    expect(calls).toHaveLength(0);
    expect(existsSync(path.join(dir, "request.json"))).toBe(false);
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

  describe("symlink hardening", () => {
    let outside: string;
    beforeEach(() => {
      outside = mkdtempSync(path.join(tmpdir(), "updater-outside-"));
    });
    afterEach(() => {
      rmSync(outside, { recursive: true, force: true });
    });

    const unreadable = { state: "failed", message: "Auftrag unlesbar" };

    it("replaces a symlinked heartbeat.json instead of writing through it", async () => {
      const victim = path.join(outside, "victim");
      writeFileSync(victim, "keep");
      symlinkSync(victim, path.join(dir, "heartbeat.json"));
      const { loop } = setup();
      await loop.tick();
      expect(readFileSync(victim, "utf8")).toBe("keep");
      expect(lstatSync(path.join(dir, "heartbeat.json")).isFile()).toBe(true);
      expect(readJson("heartbeat.json")).toEqual({ at: 4242, version: "0.1.0" });
    });

    it("replaces a symlinked status.json instead of writing through it", async () => {
      const victim = path.join(outside, "victim");
      writeFileSync(victim, "keep");
      symlinkSync(victim, path.join(dir, "status.json"));
      writeFileSync(path.join(dir, "request.json"), JSON.stringify(request));
      const { loop, calls } = setup();
      await loop.tick();
      expect(calls).toHaveLength(1);
      expect(readFileSync(victim, "utf8")).toBe("keep");
      expect(lstatSync(path.join(dir, "status.json")).isFile()).toBe(true);
      expect(readJson("status.json")).toEqual(done("r1"));
    });

    it("does not write through a planted temp-file symlink", async () => {
      const victim = path.join(outside, "victim");
      writeFileSync(victim, "keep");
      symlinkSync(victim, path.join(dir, "heartbeat.json.tmp"));
      const { loop } = setup();
      await loop.tick();
      expect(readFileSync(victim, "utf8")).toBe("keep");
    });

    it("treats a symlinked request.json as unreadable and removes only the link", async () => {
      const target = path.join(outside, "request.json");
      writeFileSync(target, JSON.stringify(request));
      symlinkSync(target, path.join(dir, "request.json"));
      const { loop, calls } = setup();
      await loop.tick();
      expect(calls).toHaveLength(0);
      expect(() => lstatSync(path.join(dir, "request.json"))).toThrow();
      expect(existsSync(target)).toBe(true);
      expect(readJson("status.json")).toMatchObject(unreadable);
    });

    it("treats a request.json over 4096 bytes as unreadable", async () => {
      writeFileSync(
        path.join(dir, "request.json"),
        JSON.stringify({ ...request, padding: "x".repeat(5000) }),
      );
      const { loop, calls } = setup();
      await loop.tick();
      expect(calls).toHaveLength(0);
      expect(existsSync(path.join(dir, "request.json"))).toBe(false);
      expect(readJson("status.json")).toMatchObject(unreadable);
    });

    it("ignores a symlinked status.json when guarding against duplicates", async () => {
      const target = path.join(outside, "status.json");
      writeFileSync(target, JSON.stringify(done("r1")));
      symlinkSync(target, path.join(dir, "status.json"));
      writeFileSync(path.join(dir, "request.json"), JSON.stringify(request));
      const { loop, calls } = setup();
      await loop.tick();
      expect(calls).toHaveLength(1);
    });

    it("writes files readable by the portal user even under a strict umask", async () => {
      const old = process.umask(0o077);
      try {
        writeFileSync(path.join(dir, "request.json"), JSON.stringify(request));
        const { loop } = setup();
        await loop.tick();
      } finally {
        process.umask(old);
      }
      for (const name of ["heartbeat.json", "status.json"]) {
        expect(lstatSync(path.join(dir, name)).mode & 0o777).toBe(0o644);
      }
    });

    it("leaves no temporary files behind", async () => {
      writeFileSync(path.join(dir, "request.json"), JSON.stringify(request));
      const { loop } = setup();
      await loop.tick();
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });
  });
});

describe("checkUpdateDir", () => {
  const me = process.getuid?.() ?? 0;

  it("accepts a plain folder with the protocol files and temp files", () => {
    for (const name of ["request.json", "status.json", "heartbeat.json", ".status.json.0b1c.tmp", ".request.json.tmp"]) {
      writeFileSync(path.join(dir, name), "{}");
    }
    expect(checkUpdateDir(dir, [me])).toBeNull();
  });

  it("accepts an empty folder", () => {
    expect(checkUpdateDir(dir, [me])).toBeNull();
  });

  it("rejects a folder with a foreign file", () => {
    writeFileSync(path.join(dir, "status.json"), "{}");
    writeFileSync(path.join(dir, "id_rsa"), "secret");
    expect(checkUpdateDir(dir, [me])).toContain("id_rsa");
  });

  it("rejects a foreign subfolder", () => {
    mkdirSync(path.join(dir, "etc"));
    expect(checkUpdateDir(dir, [me])).toContain("etc");
  });

  it("rejects a folder owned by another user", () => {
    expect(checkUpdateDir(dir, [me + 1])).toContain(`gehört Benutzer ${me}`);
  });

  it("accepts only root or uid 1000 by default", () => {
    const result = checkUpdateDir(dir);
    if (me === 0 || me === 1000) expect(result).toBeNull();
    else expect(result).toContain(`gehört Benutzer ${me}`);
  });

  it("rejects a symlink in place of the folder", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "updater-outside-"));
    try {
      const link = path.join(dir, "link");
      symlinkSync(outside, link);
      expect(checkUpdateDir(link, [me])).toContain("symbolischer Link");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a file in place of the folder", () => {
    const file = path.join(dir, "file");
    writeFileSync(file, "x");
    expect(checkUpdateDir(file, [me])).toContain("kein Ordner");
  });

  it("rejects a missing folder", () => {
    expect(checkUpdateDir(path.join(dir, "gone"), [me])).toContain("nicht lesbar");
  });
});

describe("readStatus", () => {
  it("reads a status written by the updater", () => {
    writeFileSync(path.join(dir, "status.json"), JSON.stringify(done("r1")));
    expect(readStatus(dir)).toEqual(done("r1"));
  });

  it("gives null for a missing, garbled or wrongly shaped file", () => {
    expect(readStatus(dir)).toBeNull();
    writeFileSync(path.join(dir, "status.json"), "{ nicht json");
    expect(readStatus(dir)).toBeNull();
    writeFileSync(path.join(dir, "status.json"), JSON.stringify({ id: "r1", state: "unterwegs", to: "0.2.0" }));
    expect(readStatus(dir)).toBeNull();
  });

  it("does not follow a symlinked status.json", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "updater-outside-"));
    try {
      writeFileSync(path.join(outside, "status.json"), JSON.stringify(done("r1")));
      symlinkSync(path.join(outside, "status.json"), path.join(dir, "status.json"));
      expect(readStatus(dir)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
