// Entry point of the updater container: wires the Docker API, the portal
// health check and the file loop together.
import { lchownSync, mkdirSync } from "node:fs";
import os from "node:os";
import { STATUS_FILE, type UpdateStatus } from "../shared/update.ts";
import { createDockerApi } from "./docker.ts";
import { checkUpdateDir, createLoop, writeJsonAtomic } from "./loop.ts";
import { findPortalContainer, runUpdate } from "./update.ts";

const TICK_MS = 5_000;
const DIR_RECHECK_MS = 60_000;
const HEALTH_FETCH_TIMEOUT_MS = 3_000;

const dir = process.env.UPDATE_DIR || "/update";
const repo = process.env.PORTAL_REPO || "ghcr.io/0x5j/tanss-agent-portal";
const version = process.env.UPDATER_VERSION || "dev";
const selfId = os.hostname();

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

/** The version the portal reports on /health, or null if it does not answer. */
async function health(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS) });
    const body: unknown = await res.json();
    const v = body !== null && typeof body === "object" ? (body as Record<string, unknown>).version : undefined;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Checks the mounted folder and hands it to the portal user (uid 1000), which
 * writes request.json there; a folder Docker created as root would make that
 * fail. A folder that does not look like ours is never adopted.
 */
function adoptDir(): boolean {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // checkUpdateDir reports what is wrong
  }
  const problem = checkUpdateDir(dir);
  if (problem) {
    log(
      `FEHLER: Update-Ordner sieht nicht wie erwartet aus: ${problem}. ` +
        `Der Updater bleibt untätig und prüft in ${DIR_RECHECK_MS / 1000} s erneut.`,
    );
    return false;
  }
  try {
    lchownSync(dir, 1000, 1000);
  } catch (err) {
    log(`Update-Ordner ${dir} konnte nicht übernommen werden: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

const docker = createDockerApi();
let lastState = "";

function report(status: UpdateStatus): void {
  try {
    writeJsonAtomic(dir, STATUS_FILE, status);
  } catch (err) {
    log(`status.json nicht schreibbar: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (status.state !== lastState) {
    lastState = status.state;
    log(`Update auf ${status.to}: ${status.state}${status.message ? ` (${status.message})` : ""}`);
  }
}

const loop = createLoop({
  dir,
  version,
  now: () => Date.now(),
  run: (request) => {
    lastState = "";
    log(`Auftrag ${request.id}: Update auf ${request.version}`);
    return runUpdate(
      {
        docker,
        repo,
        findPortal: () => findPortalContainer(docker, selfId),
        health,
        report,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      request,
    );
  },
});

function tick(): void {
  loop.tick().catch((err: unknown) => {
    log(`Schleife fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  });
}

let timer: NodeJS.Timeout | null = null;

// Without a heartbeat the portal shows "Der Updater läuft nicht"; the process
// stays up idle, so `restart: unless-stopped` does not loop.
function start(): void {
  if (!adoptDir()) {
    timer = setTimeout(start, DIR_RECHECK_MS);
    return;
  }
  log(`Updater ${version} bereit, Portal-Image ${repo}`);
  tick();
  timer = setInterval(tick, TICK_MS);
}

start();

// An update has its own rollback semantics, so stopping mid-update is acceptable.
function stop(): void {
  if (timer) clearInterval(timer);
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
