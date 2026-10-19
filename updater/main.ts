// Entry point of the updater container: wires the Docker API, the portal
// health check and the file loop together.
import { lchownSync, mkdirSync } from "node:fs";
import os from "node:os";
import { STATUS_FILE, type UpdateStatus } from "../shared/update.ts";
import { createDockerApi } from "./docker.ts";
import { checkUpdateDir, createLoop, readStatus, writeJsonAtomic } from "./loop.ts";
import { findPortalContainer, recoverInterrupted, runUpdate } from "./update.ts";

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

/** Set once adoptDir() accepted the folder; nothing is written into it before. */
let adopted = false;

function report(status: UpdateStatus): void {
  if (adopted) {
    try {
      writeJsonAtomic(dir, STATUS_FILE, status);
    } catch (err) {
      log(`status.json nicht schreibbar: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (status.state !== lastState) {
    lastState = status.state;
    log(`Update auf ${status.to}: ${status.state}${status.message ? ` (${status.message})` : ""}`);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The update that runs right now; a stop waits for it. */
let active: Promise<unknown> | null = null;

const loop = createLoop({
  dir,
  version,
  now: () => Date.now(),
  run: (request) => {
    lastState = "";
    log(`Auftrag ${request.id}: Update auf ${request.version}`);
    const run = runUpdate(
      {
        docker,
        repo,
        findPortal: () => findPortalContainer(docker, selfId),
        health,
        report,
        now: () => Date.now(),
        sleep,
      },
      request,
    );
    active = run;
    void run.finally(() => {
      active = null;
    });
    return run;
  },
});

function tick(): void {
  loop.tick().catch((err: unknown) => {
    log(`Schleife fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** Finishes or undoes an update this process was stopped in the middle of. */
async function recover(): Promise<void> {
  try {
    // report() logs the outcome.
    await recoverInterrupted({ docker, health, report, now: () => Date.now(), sleep }, selfId, readStatus(dir));
  } catch (err) {
    log(`Prüfung auf ein unterbrochenes Update fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let timer: NodeJS.Timeout | null = null;
let stopping = false;

// The recovery runs even when the folder is rejected: it only needs Docker,
// and an interrupted update must not leave the portal stopped. Without a
// heartbeat the portal shows "Der Updater läuft nicht"; the process stays up
// idle, so `restart: unless-stopped` does not loop.
async function start(): Promise<void> {
  adopted = adoptDir();
  const recovery = recover();
  active = recovery;
  await recovery;
  active = null;
  if (!stopping) serve();
}

function serve(): void {
  if (!adopted) adopted = adoptDir();
  if (!adopted) {
    timer = setTimeout(serve, DIR_RECHECK_MS);
    return;
  }
  log(`Updater ${version} bereit, Portal-Image ${repo}`);
  tick();
  timer = setInterval(tick, TICK_MS);
}

void start();

// A running update gets to finish (compose.yaml grants a long stop grace
// period); if it is killed anyway, the next start recovers.
function stop(): void {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  if (!active) process.exit(0);
  log("Beenden angefordert, laufendes Update wird abgeschlossen …");
  void active.finally(() => process.exit(0));
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
