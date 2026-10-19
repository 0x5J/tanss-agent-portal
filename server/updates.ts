import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  compareVersions,
  HEARTBEAT_FILE,
  HEARTBEAT_STALE_MS,
  isBusy,
  isVersion,
  REQUEST_FILE,
  STATUS_FILE,
  type ReleaseInfo,
  type UpdateChannel,
  type UpdateOverview,
  type UpdateRequest,
  type UpdateStatus,
  type UpdaterHeartbeat,
} from "../shared/update.ts";
import type { ReleaseSource } from "./releases.ts";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FIRST_CHECK_MS = 10_000;

/** A refused update request; `status` is the HTTP status the route should answer with. */
export class UpdateError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "UpdateError";
    this.status = status;
  }
}

export type UpdateService = {
  overview(): UpdateOverview;
  /** Asks the release source now; never throws, a failure lands in `checkError`. */
  check(): Promise<UpdateOverview>;
  /** Writes request.json for the offered release; throws UpdateError (409 / 503). */
  request(version: string): UpdateOverview;
  start(): void;
  stop(): void;
};

/** A missing or garbled file counts as absent. */
function readJson<T>(file: string): T | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return value !== null && typeof value === "object" ? (value as T) : null;
  } catch {
    return null;
  }
}

export function createUpdateService(opts: {
  dir: string;
  current: string;
  channel: UpdateChannel;
  enabled: boolean;
  source: ReleaseSource;
  now?: () => number;
  intervalMs?: number;
  firstCheckMs?: number;
  newId?: () => string;
}): UpdateService {
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? randomUUID;
  let latest: ReleaseInfo | null = null;
  let checkedAt: number | null = null;
  let checkError: string | null = null;
  let firstTimer: NodeJS.Timeout | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;

  const file = (name: string) => path.join(opts.dir, name);

  // Always read from disk: the updater writes these behind our back, and the
  // busy check must see a request written a moment ago.
  function overview(): UpdateOverview {
    const heartbeat = readJson<UpdaterHeartbeat>(file(HEARTBEAT_FILE));
    const alive = typeof heartbeat?.at === "number" && now() - heartbeat.at < HEARTBEAT_STALE_MS;
    return {
      current: opts.current,
      channel: opts.channel,
      enabled: opts.enabled,
      latest,
      checkedAt,
      checkError,
      updater: alive ? "ready" : "missing",
      requested: readJson<UpdateRequest>(file(REQUEST_FILE)),
      status: readJson<UpdateStatus>(file(STATUS_FILE)),
    };
  }

  async function check(): Promise<UpdateOverview> {
    if (!opts.enabled) return overview();
    try {
      latest = await opts.source.latest(opts.channel);
      checkedAt = now();
      checkError = null;
    } catch (e) {
      checkError = e instanceof Error ? e.message : String(e);
    }
    return overview();
  }

  function request(version: string): UpdateOverview {
    const o = overview();
    if (!o.latest || o.latest.version !== version) {
      throw new UpdateError(409, "Diese Version wird nicht angeboten");
    }
    if (!isVersion(o.current) || !isVersion(version) || compareVersions(version, o.current) <= 0) {
      throw new UpdateError(409, "Keine neuere Version verfügbar");
    }
    if (o.updater !== "ready") throw new UpdateError(409, "Der Updater läuft nicht");
    if (isBusy(o, now())) throw new UpdateError(409, "Es läuft bereits ein Update");

    const req: UpdateRequest = { id: newId(), version, requestedAt: now() };
    const target = file(REQUEST_FILE);
    const tmp = `${target}.tmp`;
    try {
      mkdirSync(opts.dir, { recursive: true });
      // 0o644: the updater runs as a different user and must be able to read it
      // (chmod too, as the create mode is cut down by the umask).
      writeFileSync(tmp, JSON.stringify(req), { mode: 0o644 });
      chmodSync(tmp, 0o644);
      renameSync(tmp, target);
    } catch {
      throw new UpdateError(503, "Update-Ordner nicht beschreibbar");
    }
    return overview();
  }

  function start(): void {
    if (firstTimer || intervalTimer) return;
    firstTimer = setTimeout(() => void check(), opts.firstCheckMs ?? DEFAULT_FIRST_CHECK_MS);
    firstTimer.unref();
    intervalTimer = setInterval(() => void check(), opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    intervalTimer.unref();
  }

  function stop(): void {
    if (firstTimer) clearTimeout(firstTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    firstTimer = null;
    intervalTimer = null;
  }

  return { overview, check, request, start, stop };
}
