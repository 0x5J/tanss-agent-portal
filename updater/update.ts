// One update run: pull the requested version, check its provenance, replace
// the portal container and verify the new one via /health. Anything that goes wrong after the old
// container was touched is undone, so the old version keeps running.
import { compareVersions, isVersion, type UpdateRequest, type UpdateState, type UpdateStatus } from "../shared/update.ts";
import type { ContainerInfo, DockerApi } from "./docker.ts";
import { composeImageLabel, createSpec } from "./recreate.ts";

const DEFAULT_PORT = 3848;
const STOP_TIMEOUT_SECONDS = 30;
const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_INTERVAL_MS = 2_000;
const PREVIOUS_SUFFIX = "-vorher";
const COMPOSE_PROJECT = "com.docker.compose.project";
const COMPOSE_SERVICE = "com.docker.compose.service";
const COMPOSE_IMAGE = "com.docker.compose.image";
// The image reference from compose.yaml (e.g. ":latest"). The updater creates
// the new container from "<repo>:<version>", so it keeps the original
// reference here for the pin check and the retag of the next update.
const REFERENCE_LABEL = "io.github.0x5j.tanss-agent-portal.reference";
const MANUAL_UPDATE = "docker compose pull && docker compose up -d";
const IN_PROGRESS: readonly UpdateState[] = ["pulling", "starting", "checking"];

export interface UpdateDeps {
  docker: DockerApi;
  repo: string;
  findPortal(): Promise<string>;
  /** Rejects with the reason when the image digest was not built from the release. */
  verifyImage(digest: string, version: string): Promise<void>;
  health(url: string): Promise<string | null>;
  report(status: UpdateStatus): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  healthTimeoutMs?: number;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

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

/** The one well-formed digest of `repo` among the image's RepoDigests, else null. */
function singleRepoDigest(repoDigests: string[] | undefined, repo: string): string | null {
  const prefix = `${repo}@`;
  const digests = new Set(
    (repoDigests ?? []).filter((d) => d.startsWith(prefix)).map((d) => d.slice(prefix.length)),
  );
  const [digest] = digests;
  return digests.size === 1 && digest !== undefined && DIGEST.test(digest) ? digest : null;
}

/** The reference compose started the portal with, also after earlier updates. */
function composeReference(c: ContainerInfo): string {
  return c.Config.Labels?.[REFERENCE_LABEL] || c.Config.Image;
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

/** What recovering an interrupted update needs; no request, no repo. */
export type RecoverDeps = Pick<UpdateDeps, "docker" | "health" | "report" | "now" | "sleep" | "healthTimeoutMs">;

async function askHealth(deps: RecoverDeps, url: string): Promise<string | null> {
  try {
    return await deps.health(url);
  } catch {
    return null;
  }
}

function isPrevious(c: { Names: string[] }): boolean {
  return c.Names.some((n) => n.endsWith(PREVIOUS_SUFFIX));
}

/** All containers of the portal service in the updater's own compose project. */
async function portalContainers(docker: DockerApi, selfId: string): Promise<{ Id: string; Names: string[] }[]> {
  const self = await docker.inspectContainer(selfId);
  const project = self.Config.Labels?.[COMPOSE_PROJECT];
  if (!project) throw new Error("Updater läuft nicht unter Docker Compose");
  return docker.listContainers({ [COMPOSE_PROJECT]: project, [COMPOSE_SERVICE]: "portal" });
}

/** The portal container of the updater's own compose project. */
export async function findPortalContainer(docker: DockerApi, selfId: string): Promise<string> {
  // A "-vorher" container is the leftover of an interrupted update, not the portal.
  const portals = (await portalContainers(docker, selfId)).filter((c) => !isPrevious(c));
  if (portals.length === 0) throw new Error("Portal-Container nicht gefunden");
  if (portals.length > 1) throw new Error("mehrere Portal-Container gefunden");
  return portals[0]!.Id;
}

/** True when the container carries the "-vorher" name, false also when it cannot be inspected. */
async function carriesPreviousName(docker: DockerApi, id: string): Promise<boolean> {
  try {
    return (await docker.inspectContainer(id)).Name.endsWith(PREVIOUS_SUFFIX);
  } catch {
    return false;
  }
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
    oldImageRef = composeReference(old);
    port = portalPort(old);

    const ip = containerIp(old);
    const running = ip ? await askHealth(deps, healthUrl(ip, port)) : null;
    const imageTag = parseReference(old.Config.Image).tag;
    if (running && isVersion(running)) from = running;
    else if (imageTag && isVersion(imageTag)) from = imageTag;

    // A pinned version would be undone by the next `docker compose up -d`.
    const tag = parseReference(oldImageRef).tag;
    if (tag && isVersion(tag)) {
      return report(
        "failed",
        `PORTAL_TAG ist fest auf ${tag} gesetzt — zum Aktualisieren PORTAL_TAG in .env ändern und \`${MANUAL_UPDATE}\` ausführen`,
      );
    }
    if (isVersion(from) && compareVersions(version, from) <= 0) {
      return report("failed", `Version ${version} läuft bereits oder ist älter`);
    }

    report("pulling", "Image wird geladen");
    let pulledDigest: string | null;
    try {
      pulledDigest = await docker.pullImage(repo, version);
    } catch (err) {
      return report("failed", `Image ${imageRef} nicht ladbar: ${errorText(err)}`);
    }
    // The manifest list is only there (and only needed) when the daemon
    // reports the container's platform manifest, i.e. API >= 1.48.
    const newImage = old.ImageManifestDescriptor
      ? await docker.inspectImage(imageRef, { manifests: true })
      : await docker.inspectImage(imageRef);

    report("pulling", "Herkunft wird geprüft");
    const digest = pulledDigest ?? singleRepoDigest(newImage.RepoDigests, repo);
    if (!digest) return report("failed", `Image ${imageRef} ohne eindeutigen Digest — Update abgebrochen`);
    try {
      await deps.verifyImage(digest, version);
    } catch (err) {
      // The rejected image must not linger as a candidate for compose.
      await docker.removeImage(imageRef).catch(() => {});
      return report("failed", `Herkunft von ${imageRef} nicht bestätigt: ${errorText(err)} — Update abgebrochen`);
    }

    spec = createSpec(old, oldImage, imageRef);
    const labels = (spec.body as { Labels: Record<string, string> }).Labels;
    labels[REFERENCE_LABEL] = oldImageRef;
    // Keeps `docker compose up -d` from seeing drift and recreating the container.
    const label = composeImageLabel(old, oldImage, newImage);
    if (label !== undefined) labels[COMPOSE_IMAGE] = label;
  } catch (err) {
    return report("failed", errorText(err));
  }

  // From here on every completed step is recorded so a failure undoes exactly that.
  const name = spec.name;
  let renameAttempted = false;
  let renamed = false;
  let createAttempted = false;
  let newId: string | null = null;
  let ok = false;
  let cause = UNKNOWN_ERROR;
  try {
    report("starting", "Portal startet neu");
    await docker.stopContainer(old.Id, STOP_TIMEOUT_SECONDS);
    renameAttempted = true;
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
    // The daemon may have renamed despite an error on our side (e.g. a
    // dropped connection): ask it instead of trusting the call.
    if (!renamed && renameAttempted) renamed = await carriesPreviousName(docker, old.Id);
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

/**
 * Polls /health of a container until `accept` takes an answer or the health
 * timeout runs out. Returns the container's IP (empty if it never got one) and
 * the accepted or else the last answer.
 */
async function pollHealth(
  deps: RecoverDeps,
  id: string,
  port: number,
  accept: (answer: string) => boolean,
): Promise<{ ip: string; answer: string | null }> {
  const timeout = deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  const started = deps.now();
  let ip = "";
  let last: string | null = null;
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
      if (answer) {
        last = answer;
        if (accept(answer)) break;
      }
    }
    if (deps.now() - started >= timeout) break;
    await deps.sleep(HEALTH_INTERVAL_MS);
  }
  return { ip, answer: last };
}

/** Polls /health of the new container; returns null on success, else the reason. */
async function waitForVersion(
  deps: UpdateDeps,
  id: string,
  port: number,
  version: string,
): Promise<string | null> {
  const { ip, answer } = await pollHealth(deps, id, port, (a) => a === version);
  if (answer === version) return null;
  if (!ip) return "neuer Container bekommt keine IP-Adresse";
  if (answer) return `neue Version meldet ${answer} statt ${version}`;
  return "neue Version antwortet nicht";
}

/** The new version is healthy: cleanup problems are reported but never roll back. */
async function finish(
  deps: RecoverDeps,
  report: (state: UpdateState, message: string) => UpdateStatus,
  oldId: string,
  imageRef: string,
  oldImageRef: string,
  version: string,
  notes: string[] = [],
): Promise<UpdateStatus> {
  const problems = [...notes];
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

/**
 * Runs once at updater start, before the loop: an update the updater was
 * killed in the middle of (stop, crash, host restart) is finished or undone.
 * Returns the new status, or null when there was nothing to recover.
 */
export async function recoverInterrupted(
  deps: RecoverDeps,
  selfId: string,
  status: UpdateStatus | null,
): Promise<UpdateStatus | null> {
  const { docker } = deps;
  const found = await portalContainers(docker, selfId);
  const previous = found.find(isPrevious) ?? null;
  const open = status !== null && IN_PROGRESS.includes(status.state);
  if (!previous && !open) return null;

  const to = status?.to ?? "";
  function report(state: UpdateState, message: string): UpdateStatus {
    const next: UpdateStatus = {
      id: status?.id ?? "",
      state,
      from: status?.from || "unbekannt",
      to,
      message,
      at: deps.now(),
    };
    try {
      deps.report(next);
    } catch {
      // A status that cannot be written must not stop the recovery.
    }
    return next;
  }

  const currents = found.filter((c) => !isPrevious(c));
  if (currents.length > 1) {
    return report("failed", "Update unterbrochen: mehrere Portal-Container gefunden — bitte `docker compose up -d` ausführen");
  }

  try {
    const current = currents[0] ? await docker.inspectContainer(currents[0].Id) : null;
    // A stopped container cannot answer; do not wait the full timeout for it.
    const running = current !== null && current.State?.Running !== false;
    const answer =
      running && isVersion(to) ? (await pollHealth(deps, current.Id, portalPort(current), () => true)).answer : null;

    if (current && answer === to) {
      const note = "nach Unterbrechung";
      if (!previous) return report("done", `Update auf ${to} abgeschlossen (${note})`);
      const old = await docker.inspectContainer(previous.Id);
      return finish(deps, report, previous.Id, current.Config.Image, composeReference(old), to, [note]);
    }

    if (previous) {
      const name = (previous.Names.find((n) => n.endsWith(PREVIOUS_SUFFIX)) ?? "")
        .replace(/^\//, "")
        .slice(0, -PREVIOUS_SUFFIX.length);
      try {
        if (current) await docker.removeContainer(current.Id);
        await docker.renameContainer(previous.Id, name);
        await docker.startContainer(previous.Id);
      } catch (err) {
        return report(
          "failed",
          `Update unterbrochen, Wiederherstellung fehlgeschlagen: ${errorText(err)} — bitte \`docker compose up -d\` ausführen`,
        );
      }
      return report("rolledBack", "Update unterbrochen, vorherige Version wiederhergestellt");
    }

    // Interrupted between stopping the old container and renaming it.
    if (current && !running) await docker.startContainer(current.Id);
    return report("failed", "Update unterbrochen");
  } catch (err) {
    return report("failed", `Update unterbrochen: ${errorText(err)} — bitte \`docker compose up -d\` ausführen`);
  }
}
