// One update run: pull the requested version, replace the portal container
// and verify the new one via /health. Anything that goes wrong after the old
// container was touched is undone, so the old version keeps running.
import { isVersion, type UpdateRequest, type UpdateState, type UpdateStatus } from "../shared/update.ts";
import type { ContainerInfo, DockerApi } from "./docker.ts";
import { createSpec } from "./recreate.ts";

const DEFAULT_PORT = 3848;
const STOP_TIMEOUT_SECONDS = 30;
const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_INTERVAL_MS = 2_000;
const PREVIOUS_SUFFIX = "-vorher";
const COMPOSE_PROJECT = "com.docker.compose.project";
const COMPOSE_SERVICE = "com.docker.compose.service";
const COMPOSE_IMAGE = "com.docker.compose.image";

export interface UpdateDeps {
  docker: DockerApi;
  repo: string;
  findPortal(): Promise<string>;
  health(url: string): Promise<string | null>;
  report(status: UpdateStatus): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  healthTimeoutMs?: number;
}

const UNKNOWN_ERROR = "unbekannter Fehler";

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text || UNKNOWN_ERROR;
}

/** Splits "registry:port/repo:tag" into repo and tag; digests and missing tags give tag null. */
function parseReference(ref: string): { repo: string; tag: string | null; digest: boolean } {
  if (ref.includes("@")) return { repo: ref.slice(0, ref.indexOf("@")), tag: null, digest: true };
  const colon = ref.lastIndexOf(":");
  if (colon > ref.lastIndexOf("/")) return { repo: ref.slice(0, colon), tag: ref.slice(colon + 1), digest: false };
  return { repo: ref, tag: null, digest: false };
}

/** IP of the container's primary network; empty while it has none yet. */
function containerIp(c: ContainerInfo): string {
  const networks = c.NetworkSettings?.Networks ?? {};
  const mode = c.HostConfig?.NetworkMode;
  if (typeof mode === "string" && Object.hasOwn(networks, mode)) return networks[mode]?.IPAddress ?? "";
  return Object.values(networks).find((n) => n.IPAddress)?.IPAddress ?? "";
}

function portalPort(c: ContainerInfo): number {
  const entry = (c.Config.Env ?? []).findLast((e) => e.startsWith("PORT="));
  const port = Number(entry?.slice("PORT=".length));
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

function healthUrl(ip: string, port: number): string {
  return `http://${ip}:${port}/health`;
}

async function askHealth(deps: UpdateDeps, url: string): Promise<string | null> {
  try {
    return await deps.health(url);
  } catch {
    return null;
  }
}

/** The portal container of the updater's own compose project. */
export async function findPortalContainer(docker: DockerApi, selfId: string): Promise<string> {
  const self = await docker.inspectContainer(selfId);
  const project = self.Config.Labels?.[COMPOSE_PROJECT];
  if (!project) throw new Error("Updater läuft nicht unter Docker Compose");
  const found = await docker.listContainers({ [COMPOSE_PROJECT]: project, [COMPOSE_SERVICE]: "portal" });
  // A "-vorher" container is the leftover of an interrupted update, not the portal.
  const portals = found.filter((c) => !c.Names.some((n) => n.endsWith(PREVIOUS_SUFFIX)));
  if (portals.length === 0) throw new Error("Portal-Container nicht gefunden");
  if (portals.length > 1) throw new Error("mehrere Portal-Container gefunden");
  return portals[0]!.Id;
}

export async function runUpdate(deps: UpdateDeps, request: UpdateRequest): Promise<UpdateStatus> {
  const { docker, repo } = deps;
  const version = request.version;
  let from = "unbekannt";

  function report(state: UpdateState, message: string): UpdateStatus {
    const status: UpdateStatus = { id: request.id, state, from, to: version, message, at: deps.now() };
    try {
      deps.report(status);
    } catch {
      // A status that cannot be written must not abort the update half-way.
    }
    return status;
  }

  if (!isVersion(version)) return report("failed", `Ungültige Version: ${version}`);

  // Nothing has been touched yet: any failure here simply ends the run.
  let old: ContainerInfo;
  let oldImageRef: string;
  let port: number;
  let spec: ReturnType<typeof createSpec>;
  const imageRef = `${repo}:${version}`;
  try {
    const oldId = await deps.findPortal();
    old = await docker.inspectContainer(oldId);
    const oldImage = await docker.inspectImage(old.Image);
    oldImageRef = old.Config.Image;
    port = portalPort(old);

    const ip = containerIp(old);
    const running = ip ? await askHealth(deps, healthUrl(ip, port)) : null;
    const tag = parseReference(oldImageRef).tag;
    if (running && isVersion(running)) from = running;
    else if (tag && isVersion(tag)) from = tag;

    report("pulling", "Image wird geladen");
    try {
      await docker.pullImage(repo, version);
    } catch (err) {
      return report("failed", `Image ${imageRef} nicht ladbar: ${errorText(err)}`);
    }
    const newImage = await docker.inspectImage(imageRef);

    spec = createSpec(old, oldImage, imageRef);
    if (old.Config.Labels && Object.hasOwn(old.Config.Labels, COMPOSE_IMAGE)) {
      // Keeps `docker compose up -d` from seeing drift and recreating the container.
      (spec.body as { Labels: Record<string, string> }).Labels[COMPOSE_IMAGE] = newImage.Id;
    }
  } catch (err) {
    return report("failed", errorText(err));
  }

  // From here on every completed step is recorded so a failure undoes exactly that.
  const name = spec.name;
  let renamed = false;
  let createAttempted = false;
  let newId: string | null = null;
  let ok = false;
  let cause = UNKNOWN_ERROR;
  try {
    report("starting", "Portal startet neu");
    await docker.stopContainer(old.Id, STOP_TIMEOUT_SECONDS);
    await docker.renameContainer(old.Id, `${name}${PREVIOUS_SUFFIX}`);
    renamed = true;
    createAttempted = true;
    newId = await docker.createContainer(name, spec.body);
    for (const extra of spec.extraNetworks) {
      await docker.connectNetwork(extra.name, newId, extra.endpoint);
    }
    await docker.startContainer(newId);

    report("checking", "neue Version wird geprüft");
    const failure = await waitForVersion(deps, newId, port, version);
    if (failure === null) ok = true;
    else cause = failure;
  } catch (err) {
    cause = errorText(err);
  }

  if (ok) return finish(deps, report, old.Id, imageRef, oldImageRef, version);

  try {
    if (newId) {
      await docker.removeContainer(newId).catch(() => {});
    } else if (createAttempted) {
      // The create may have gone through despite the error; the name is free
      // otherwise, as the old container carries the "-vorher" name.
      await docker.removeContainer(name).catch(() => {});
    }
    if (renamed) await docker.renameContainer(old.Id, name);
    await docker.startContainer(old.Id);
  } catch (err) {
    return report(
      "failed",
      `${cause}. Rollback fehlgeschlagen: ${errorText(err)} — bitte \`docker compose up -d\` ausführen`,
    );
  }
  return report("rolledBack", cause);
}

/** Polls /health of the new container; returns null on success, else the reason. */
async function waitForVersion(
  deps: UpdateDeps,
  id: string,
  port: number,
  version: string,
): Promise<string | null> {
  const timeout = deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  const started = deps.now();
  let ip = "";
  let reported: string | null = null;
  for (;;) {
    if (!ip) {
      try {
        ip = containerIp(await deps.docker.inspectContainer(id));
      } catch {
        // Not inspectable right now; try again on the next round.
      }
    }
    if (ip) {
      const answer = await askHealth(deps, healthUrl(ip, port));
      if (answer === version) return null;
      if (answer) reported = answer;
    }
    if (deps.now() - started >= timeout) break;
    await deps.sleep(HEALTH_INTERVAL_MS);
  }
  if (!ip) return "neuer Container bekommt keine IP-Adresse";
  if (reported) return `neue Version meldet ${reported} statt ${version}`;
  return "neue Version antwortet nicht";
}

/** The new version is healthy: cleanup problems are reported but never roll back. */
async function finish(
  deps: UpdateDeps,
  report: (state: UpdateState, message: string) => UpdateStatus,
  oldId: string,
  imageRef: string,
  oldImageRef: string,
  version: string,
): Promise<UpdateStatus> {
  const problems: string[] = [];
  try {
    await deps.docker.removeContainer(oldId);
  } catch (err) {
    problems.push(`alter Container nicht entfernt: ${errorText(err)}`);
  }

  // Point the old reference (e.g. :latest) at the new image so a later
  // `docker compose up -d` does not bring the old version back. Pinned
  // versions and digests stay untouched. An untagged reference means :latest.
  const ref = parseReference(oldImageRef);
  const tag = ref.tag ?? (ref.digest ? null : "latest");
  if (tag && !isVersion(tag)) {
    try {
      await deps.docker.tagImage(imageRef, ref.repo, tag);
    } catch (err) {
      problems.push(`Image nicht als ${ref.repo}:${tag} markiert: ${errorText(err)}`);
    }
  }

  const done = `Update auf ${version} abgeschlossen`;
  return report("done", problems.length ? `${done} (${problems.join("; ")})` : done);
}
