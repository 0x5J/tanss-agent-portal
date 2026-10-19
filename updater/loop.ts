// The updater's file protocol with the portal: each tick publishes a heartbeat
// and picks up at most one request.json, runs it and publishes the result.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
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

/** The only names that belong in the update folder. */
const PROTOCOL_FILES = new Set([REQUEST_FILE, STATUS_FILE, HEARTBEAT_FILE]);
/** Temp files of the atomic writes on both sides, e.g. ".status.json.<uuid>.tmp". */
const TEMP_FILE = /^\..+\.tmp$/;
/** Finder and Explorer leave these behind when the folder is opened; not a wrong mount. */
const OS_METADATA = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Checks that the mounted folder is what compose.yaml mounts: a real folder
 * (no symlink) owned by root or the portal user, holding nothing but the
 * protocol files, their temp files and OS metadata. Anything else means a wrong mount, and adopting it (chown)
 * would hand a foreign folder to the portal user. Returns the problem in
 * German, or null when the folder looks right.
 */
export function checkUpdateDir(dir: string, owners: readonly number[] = [0, 1000]): string | null {
  let entries: string[];
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) return `${dir} ist ein symbolischer Link`;
    if (!stat.isDirectory()) return `${dir} ist kein Ordner`;
    if (!owners.includes(stat.uid)) {
      return `${dir} gehört Benutzer ${stat.uid}, erwartet ${owners.join(" oder ")}`;
    }
    entries = readdirSync(dir);
  } catch (err) {
    return `${dir} nicht lesbar: ${errorText(err)}`;
  }
  const foreign = entries
    .filter((name) => !PROTOCOL_FILES.has(name) && !TEMP_FILE.test(name) && !OS_METADATA.has(name))
    .sort();
  if (foreign.length > 0) return `unerwartete Einträge in ${dir}: ${foreign.join(", ")}`;
  return null;
}

/** Requests and statuses are tiny; anything bigger is not ours. */
const MAX_READ_BYTES = 4096;

/**
 * Writes tmp + rename so the portal never reads a half-written file. The
 * folder is writable by the less trusted portal and this process is root, so
 * the temp file has a random name, is created exclusively and never follows a
 * symlink; rename replaces a symlink at the target instead of following it.
 */
export function writeJsonAtomic(dir: string, name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.${randomUUID()}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    try {
      const data = Buffer.from(JSON.stringify(value));
      let written = 0;
      while (written < data.length) written += writeSync(fd, data, written);
      // The create mode is cut down by the umask; the portal user must read it.
      fchmodSync(fd, 0o644);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort
    }
    throw err;
  }
}

/**
 * Text of a small regular file. Anything else (a symlink via O_NOFOLLOW, a
 * directory, a file bigger than MAX_READ_BYTES) yields no text; `missing`
 * tells a plain absent file apart from those.
 */
function readSmallFile(file: string): { text: string } | { missing: boolean } {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    return { missing: (err as NodeJS.ErrnoException).code === "ENOENT" };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return { missing: false };
    const buf = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, read);
      if (n === 0) break;
      read += n;
    }
    return { text: buf.toString("utf8", 0, read) };
  } catch {
    return { missing: false };
  } finally {
    closeSync(fd);
  }
}

function readJson(file: string): unknown {
  const res = readSmallFile(file);
  if (!("text" in res)) return null;
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

function isRequest(v: unknown): v is UpdateRequest {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.version === "string" && typeof r.requestedAt === "number";
}

const STATES: readonly string[] = ["pulling", "starting", "checking", "done", "failed", "rolledBack"];

function isStatus(v: unknown): v is UpdateStatus {
  if (v === null || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.state === "string" &&
    STATES.includes(s.state) &&
    typeof s.from === "string" &&
    typeof s.to === "string" &&
    typeof s.message === "string" &&
    typeof s.at === "number"
  );
}

/** The last status the updater wrote, or null if there is none (or not a valid one). */
export function readStatus(dir: string): UpdateStatus | null {
  const value = readJson(path.join(dir, STATUS_FILE));
  return isStatus(value) ? value : null;
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
      const read = readSmallFile(file);
      if ("missing" in read && read.missing) return; // no request pending

      // rmSync removes a symlink itself, it does not follow it.
      function removeRequest(): void {
        try {
          rmSync(file, { force: true });
        } catch {
          // e.g. a directory in its place: still report it, never run it
        }
      }

      let raw: unknown = null;
      if ("text" in read) {
        try {
          raw = JSON.parse(read.text);
        } catch {
          // stays null: reported as unreadable below
        }
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
        removeRequest();
        return;
      }
      // Guards against a duplicate write of a request that was already handled
      // or confirmed before a crash.
      if (str(readJson(path.join(opts.dir, STATUS_FILE)), "id") === raw.id) {
        removeRequest();
        return;
      }

      // Confirm first, so the portal never sees neither a request nor a status;
      // then delete: a crash mid-update must never replay the request.
      write(STATUS_FILE, {
        id: raw.id,
        state: "pulling",
        from: "",
        to: raw.version,
        message: "Auftrag angenommen",
        at: opts.now(),
      } satisfies UpdateStatus);
      removeRequest();

      write(STATUS_FILE, await opts.run(raw));
    } finally {
      busy = false;
    }
  }

  return { tick };
}
