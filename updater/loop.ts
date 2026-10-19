// The updater's file protocol with the portal: each tick publishes a heartbeat
// and picks up at most one request.json, runs it and publishes the result.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  HEARTBEAT_FILE,
  REQUEST_FILE,
  STATUS_FILE,
  type UpdateRequest,
  type UpdateStatus,
  type UpdaterHeartbeat,
} from "../shared/update.ts";

export interface LoopOptions {
  dir: string;
  version: string;
  run(request: UpdateRequest): Promise<UpdateStatus>;
  now(): number;
}

/** Writes tmp + rename so the portal never reads a half-written file. */
export function writeJsonAtomic(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o644 });
  renameSync(tmp, target);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isRequest(v: unknown): v is UpdateRequest {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.version === "string" && typeof r.requestedAt === "number";
}

function str(v: unknown, key: string): string {
  const value = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : "";
}

export function createLoop(opts: LoopOptions): { tick(): Promise<void> } {
  let busy = false;

  function write(name: string, value: unknown): void {
    writeJsonAtomic(opts.dir, name, value);
  }

  async function tick(): Promise<void> {
    // The heartbeat goes out even while an update runs, so the portal sees
    // the updater alive during a long pull.
    const heartbeat: UpdaterHeartbeat = { at: opts.now(), version: opts.version };
    write(HEARTBEAT_FILE, heartbeat);

    // A running update owns the loop; the next tick after it picks up the rest.
    if (busy) return;
    busy = true;
    try {
      const file = path.join(opts.dir, REQUEST_FILE);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        return; // no request pending
      }
      // Delete first: a crash mid-update must never replay the request.
      rmSync(file, { force: true });

      let raw: unknown = null;
      try {
        raw = JSON.parse(text);
      } catch {
        // stays null: reported as unreadable below
      }
      if (!isRequest(raw)) {
        write(STATUS_FILE, {
          id: str(raw, "id"),
          state: "failed",
          from: "",
          to: str(raw, "version"),
          message: "Auftrag unlesbar",
          at: opts.now(),
        } satisfies UpdateStatus);
        return;
      }
      // Guards against a duplicate write of a request that was already handled.
      if (str(readJson(path.join(opts.dir, STATUS_FILE)), "id") === raw.id) return;

      write(STATUS_FILE, await opts.run(raw));
    } finally {
      busy = false;
    }
  }

  return { tick };
}
