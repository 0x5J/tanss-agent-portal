// Entry point of the updater container: wires the Docker API, the portal
// health check and the file loop together.
import { chownSync, mkdirSync } from "node:fs";
import os from "node:os";
import { STATUS_FILE, type UpdateStatus } from "../shared/update.ts";
import { createDockerApi } from "./docker.ts";
import { createLoop, writeJsonAtomic } from "./loop.ts";
import { findPortalContainer, runUpdate } from "./update.ts";

const TICK_MS = 5_000;
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

// The portal runs as uid 1000 and writes request.json here; a folder Docker
// created as root would make that fail.
try {
  mkdirSync(dir, { recursive: true });
  chownSync(dir, 1000, 1000);
} catch (err) {
  log(`Update-Ordner ${dir} konnte nicht übernommen werden: ${err instanceof Error ? err.message : String(err)}`);
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

log(`Updater ${version} bereit, Portal-Image ${repo}`);
tick();
const timer = setInterval(tick, TICK_MS);

// An update has its own rollback semantics, so stopping mid-update is acceptable.
function stop(): void {
  clearInterval(timer);
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
