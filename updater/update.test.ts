import { describe, expect, it } from "vitest";
import type { UpdateStatus } from "../shared/update.ts";
import { type ContainerInfo, type DockerApi, DockerError, type ImageInfo } from "./docker.ts";
import { findPortalContainer, recoverInterrupted, runUpdate } from "./update.ts";

const REPO = "ghcr.io/0x5j/tanss-agent-portal";
const OLD_ID = "0ld0ld0ld0ld0ld0ld0ld0ld";
const NEW_ID = "new0new0new0new0new0new0";
const SELF_ID = "5e1f5e1f5e1f";
const NAME = "agent-portal-portal-1";
const OLD_IP = "172.18.0.3";
const NEW_IP = "172.18.0.7";
const NEW_IMAGE_ID = "sha256:new-image";

type Method = keyof DockerApi;
type Call = [Method, ...unknown[]];
type Failure = string | ((...args: unknown[]) => string | undefined);

function oldContainer(over: { image?: string; env?: string[]; labels?: Record<string, string> } = {}): ContainerInfo {
  return {
    Id: OLD_ID,
    Name: `/${NAME}`,
    Image: "sha256:old-image",
    Config: {
      Image: over.image ?? `${REPO}:latest`,
      Hostname: OLD_ID.slice(0, 12),
      Env: over.env ?? ["PORT=3848", "TZ=Europe/Berlin"],
      Labels: over.labels ?? {
        "com.docker.compose.project": "agent-portal",
        "com.docker.compose.service": "portal",
        "com.docker.compose.image": "sha256:old-image",
      },
    },
    HostConfig: { NetworkMode: "agent-portal_default" },
    NetworkSettings: {
      Networks: {
        proxy: { IPAddress: "172.19.0.5", Aliases: ["portal"] },
        "agent-portal_default": { IPAddress: OLD_IP, Aliases: ["portal"] },
      },
    },
  };
}

function newContainer(ip: string): ContainerInfo {
  const c = oldContainer();
  return {
    ...c,
    Id: NEW_ID,
    Config: { ...c.Config, Image: `${REPO}:0.2.0` },
    NetworkSettings: {
      Networks: {
        proxy: { IPAddress: ip ? "172.19.0.9" : "", Aliases: ["portal"] },
        "agent-portal_default": { IPAddress: ip, Aliases: ["portal"] },
      },
    },
  };
}

function image(id: string): ImageInfo {
  return { Id: id, Config: { Env: ["TZ=Europe/Berlin"], Labels: null } };
}

function fakeDocker(
  opts: {
    old?: ContainerInfo;
    self?: ContainerInfo;
    list?: { Id: string; Names: string[] }[];
    newIps?: string[];
    fail?: Partial<Record<Method, Failure>>;
    /** The daemon renames the old container even though the call reports an error. */
    applyFailedRename?: boolean;
    oldRunning?: boolean;
    newRunning?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const old = opts.old ?? oldContainer();
  const newIps = [...(opts.newIps ?? [NEW_IP])];
  let oldName = old.Name;

  function record(method: Method, ...args: unknown[]) {
    calls.push([method, ...args]);
    const failure = opts.fail?.[method];
    const message = typeof failure === "function" ? failure(...args) : failure;
    if (message) throw new DockerError(message, 500);
  }

  const docker: DockerApi = {
    async inspectContainer(id) {
      record("inspectContainer", id);
      if (id === OLD_ID) {
        const c = { ...structuredClone(old), Name: oldName };
        return opts.oldRunning === undefined ? c : { ...c, State: { Running: opts.oldRunning } };
      }
      if (id === NEW_ID) {
        const c = newContainer(newIps.length > 1 ? newIps.shift()! : (newIps[0] ?? ""));
        return opts.newRunning === undefined ? c : { ...c, State: { Running: opts.newRunning } };
      }
      if (id === SELF_ID && opts.self) return structuredClone(opts.self);
      throw new DockerError(`No such container: ${id}`, 404);
    },
    async listContainers(labels) {
      record("listContainers", labels);
      return opts.list ?? [];
    },
    async inspectImage(ref) {
      record("inspectImage", ref);
      if (ref === old.Image) return image("sha256:old-image");
      return image(NEW_IMAGE_ID);
    },
    async pullImage(repo, tag) {
      record("pullImage", repo, tag);
    },
    async tagImage(ref, repo, tag) {
      record("tagImage", ref, repo, tag);
    },
    async createContainer(name, body) {
      record("createContainer", name, body);
      return NEW_ID;
    },
    async startContainer(id) {
      record("startContainer", id);
    },
    async stopContainer(id, timeoutSeconds) {
      record("stopContainer", id, timeoutSeconds);
    },
    async removeContainer(id) {
      record("removeContainer", id);
    },
    async renameContainer(id, name) {
      if (opts.applyFailedRename && id === OLD_ID) oldName = `/${name}`;
      record("renameContainer", id, name);
      if (id === OLD_ID) oldName = `/${name}`;
    },
    async connectNetwork(network, id, endpoint) {
      record("connectNetwork", network, id, endpoint);
    },
  };
  return { docker, calls };
}

function setup(
  opts: {
    docker?: ReturnType<typeof fakeDocker>;
    health?: (url: string) => string | null;
    findPortal?: () => Promise<string>;
    healthTimeoutMs?: number;
  } = {},
) {
  const fake = opts.docker ?? fakeDocker();
  let clock = 1_000_000;
  const reports: UpdateStatus[] = [];
  const healthUrls: string[] = [];
  const sleeps: number[] = [];
  const health =
    opts.health ?? ((url: string) => (url.includes(OLD_IP) ? "0.1.0" : url.includes(NEW_IP) ? "0.2.0" : null));
  const deps = {
    docker: fake.docker,
    repo: REPO,
    findPortal: opts.findPortal ?? (async () => OLD_ID),
    async health(url: string) {
      healthUrls.push(url);
      return health(url);
    },
    report(status: UpdateStatus) {
      reports.push(status);
    },
    now: () => clock,
    async sleep(ms: number) {
      sleeps.push(ms);
      clock += ms;
    },
    healthTimeoutMs: opts.healthTimeoutMs,
  };
  return { deps, calls: fake.calls, reports, healthUrls, sleeps, elapsed: () => clock - 1_000_000 };
}

const REQUEST = { id: "req-1", version: "0.2.0", requestedAt: 1 };

function names(calls: Call[]): string[] {
  return calls.map(([method, ...args]) => {
    if (method === "createContainer") return `createContainer(${String(args[0])})`;
    if (method === "connectNetwork") return `connectNetwork(${String(args[0])}, ${String(args[1])})`;
    return `${method}(${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(", ")})`;
  });
}

function mutating(calls: Call[]): string[] {
  return names(calls.filter(([m]) => m !== "inspectContainer" && m !== "inspectImage" && m !== "listContainers"));
}

describe("runUpdate", () => {
  it("updates, checks the new version and cleans up", async () => {
    const t = setup();
    const result = await runUpdate(t.deps, REQUEST);

    expect(mutating(t.calls)).toEqual([
      `pullImage(${REPO}, 0.2.0)`,
      `stopContainer(${OLD_ID}, 30)`,
      `renameContainer(${OLD_ID}, ${NAME}-vorher)`,
      `createContainer(${NAME})`,
      `connectNetwork(proxy, ${NEW_ID})`,
      `startContainer(${NEW_ID})`,
      `removeContainer(${OLD_ID})`,
      `tagImage(${REPO}:0.2.0, ${REPO}, latest)`,
    ]);
    expect(t.healthUrls).toEqual([`http://${OLD_IP}:3848/health`, `http://${NEW_IP}:3848/health`]);
    expect(t.reports.map((r) => r.state)).toEqual(["pulling", "starting", "checking", "done"]);
    expect(result).toBe(t.reports.at(-1));
    expect(result).toEqual({
      id: "req-1",
      state: "done",
      from: "0.1.0",
      to: "0.2.0",
      message: "Update auf 0.2.0 abgeschlossen",
      at: 1_000_000,
    });
    for (const r of t.reports) {
      expect(r).toMatchObject({ id: "req-1", from: "0.1.0", to: "0.2.0" });
    }
  });

  it("creates the new container from the old one with the pulled image", async () => {
    const t = setup();
    await runUpdate(t.deps, REQUEST);
    const create = t.calls.find(([m]) => m === "createContainer")!;
    const body = create[2] as { Image: string; Labels: Record<string, string>; NetworkingConfig: unknown };
    expect(body.Image).toBe(`${REPO}:0.2.0`);
    expect(Object.keys((body.NetworkingConfig as { EndpointsConfig: object }).EndpointsConfig)).toEqual([
      "agent-portal_default",
    ]);
    // Ruling J: compose's image label follows the new image id.
    expect(body.Labels["com.docker.compose.image"]).toBe(NEW_IMAGE_ID);
    expect(body.Labels["com.docker.compose.project"]).toBe("agent-portal");
    expect(t.calls).toContainEqual(["inspectImage", `${REPO}:0.2.0`]);
  });

  it("does not add the compose image label when the old container had none", async () => {
    const t = setup({
      docker: fakeDocker({ old: oldContainer({ labels: { "com.docker.compose.project": "agent-portal" } }) }),
    });
    await runUpdate(t.deps, REQUEST);
    const body = t.calls.find(([m]) => m === "createContainer")![2] as { Labels: Record<string, string> };
    expect(body.Labels).toEqual({ "com.docker.compose.project": "agent-portal" });
  });

  it("uses PORT from the old container's environment", async () => {
    const t = setup({ docker: fakeDocker({ old: oldContainer({ env: ["TZ=Europe/Berlin", "PORT=4000"] }) }) });
    await runUpdate(t.deps, REQUEST);
    expect(t.healthUrls).toEqual([`http://${OLD_IP}:4000/health`, `http://${NEW_IP}:4000/health`]);
  });

  it("falls back to port 3848 without PORT", async () => {
    const t = setup({ docker: fakeDocker({ old: oldContainer({ env: ["TZ=Europe/Berlin"] }) }) });
    await runUpdate(t.deps, REQUEST);
    expect(t.healthUrls[0]).toBe(`http://${OLD_IP}:3848/health`);
  });

  it("refuses a pinned PORTAL_TAG without touching anything", async () => {
    const t = setup({ docker: fakeDocker({ old: oldContainer({ image: `${REPO}:0.1.0` }) }) });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result).toMatchObject({
      state: "failed",
      from: "0.1.0",
      to: "0.2.0",
      message:
        "PORTAL_TAG ist fest auf 0.1.0 gesetzt — zum Aktualisieren PORTAL_TAG in .env ändern und `docker compose pull && docker compose up -d` ausführen",
    });
    expect(mutating(t.calls)).toEqual([]);
    expect(t.reports).toEqual([result]);
  });

  it("takes from from the pinned tag when the old health check fails", async () => {
    const t = setup({
      docker: fakeDocker({ old: oldContainer({ image: `${REPO}:0.1.5` }) }),
      health: () => null,
    });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("failed");
    expect(result.from).toBe("0.1.5");
  });

  it("refuses the version that already runs without touching anything", async () => {
    const t = setup({ health: () => "0.2.0" });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result).toMatchObject({
      state: "failed",
      from: "0.2.0",
      message: "Version 0.2.0 läuft bereits oder ist älter",
    });
    expect(mutating(t.calls)).toEqual([]);
    expect(t.reports).toEqual([result]);
  });

  it("refuses a downgrade without touching anything", async () => {
    const t = setup({ health: () => "0.3.0" });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result).toMatchObject({ state: "failed", message: "Version 0.2.0 läuft bereits oder ist älter" });
    expect(mutating(t.calls)).toEqual([]);
  });

  it("reports from as unbekannt without health and without a version tag", async () => {
    const t = setup({
      health: (url) => {
        if (url.includes(OLD_IP)) throw new Error("ECONNREFUSED");
        return "0.2.0";
      },
    });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("done");
    expect(result.from).toBe("unbekannt");
  });

  it("rejects an invalid version without touching Docker", async () => {
    let asked = false;
    const t = setup({
      findPortal: async () => {
        asked = true;
        return OLD_ID;
      },
    });
    const result = await runUpdate(t.deps, { ...REQUEST, version: "latest" });
    expect(result).toMatchObject({ id: "req-1", state: "failed", to: "latest", message: "Ungültige Version: latest" });
    expect(t.calls).toEqual([]);
    expect(asked).toBe(false);
    expect(t.reports).toEqual([result]);
  });

  it("fails without touching anything when the portal container is not found", async () => {
    const t = setup({
      findPortal: async () => {
        throw new Error("Portal-Container nicht gefunden");
      },
    });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result).toMatchObject({ state: "failed", message: "Portal-Container nicht gefunden" });
    expect(t.calls).toEqual([]);
  });

  it("fails without stopping anything when the pull fails", async () => {
    const t = setup({ docker: fakeDocker({ fail: { pullImage: "manifest unknown" } }) });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("failed");
    expect(result.message).toBe(`Image ${REPO}:0.2.0 nicht ladbar: manifest unknown`);
    expect(mutating(t.calls)).toEqual([`pullImage(${REPO}, 0.2.0)`]);
    expect(t.reports.map((r) => r.state)).toEqual(["pulling", "failed"]);
  });

  it("rolls back when the new version reports the old version until the timeout", async () => {
    const t = setup({ health: () => "0.1.0" });
    const result = await runUpdate(t.deps, REQUEST);

    expect(result.state).toBe("rolledBack");
    expect(result.message).toContain("meldet 0.1.0 statt 0.2.0");
    expect(mutating(t.calls)).toEqual([
      `pullImage(${REPO}, 0.2.0)`,
      `stopContainer(${OLD_ID}, 30)`,
      `renameContainer(${OLD_ID}, ${NAME}-vorher)`,
      `createContainer(${NAME})`,
      `connectNetwork(proxy, ${NEW_ID})`,
      `startContainer(${NEW_ID})`,
      `removeContainer(${NEW_ID})`,
      `renameContainer(${OLD_ID}, ${NAME})`,
      `startContainer(${OLD_ID})`,
    ]);
    expect(t.reports.map((r) => r.state)).toEqual(["pulling", "starting", "checking", "rolledBack"]);
    // Polled every 2 s for the default 90 s.
    expect(new Set(t.sleeps)).toEqual(new Set([2000]));
    expect(t.elapsed()).toBeGreaterThanOrEqual(90_000);
    expect(t.elapsed()).toBeLessThan(92_000);
  });

  it("honours healthTimeoutMs and waits for a slow start", async () => {
    let polls = 0;
    const t = setup({
      healthTimeoutMs: 10_000,
      health: (url) => {
        if (url.includes(OLD_IP)) return "0.1.0";
        polls++;
        return polls < 4 ? null : "0.2.0";
      },
    });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("done");
    expect(t.sleeps).toEqual([2000, 2000, 2000]);
  });

  it("rolls back when the new version never answers", async () => {
    const t = setup({ healthTimeoutMs: 10_000, health: (url) => (url.includes(OLD_IP) ? "0.1.0" : null) });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("rolledBack");
    expect(result.message).toContain("neue Version antwortet nicht");
    expect(t.elapsed()).toBe(10_000);
  });

  it("re-inspects the new container until it has an IP", async () => {
    const t = setup({ docker: fakeDocker({ newIps: ["", "", NEW_IP] }) });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("done");
    expect(t.healthUrls).toEqual([`http://${OLD_IP}:3848/health`, `http://${NEW_IP}:3848/health`]);
    expect(t.calls.filter(([m, id]) => m === "inspectContainer" && id === NEW_ID)).toHaveLength(3);
  });

  it("rolls back when the new container never gets an IP", async () => {
    const t = setup({ docker: fakeDocker({ newIps: [""] }), healthTimeoutMs: 6_000 });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("rolledBack");
    expect(result.message).toContain("keine IP-Adresse");
    expect(t.healthUrls).toEqual([`http://${OLD_IP}:3848/health`]);
    expect(mutating(t.calls).slice(-3)).toEqual([
      `removeContainer(${NEW_ID})`,
      `renameContainer(${OLD_ID}, ${NAME})`,
      `startContainer(${OLD_ID})`,
    ]);
  });

  it("rolls back when createContainer fails", async () => {
    const t = setup({ docker: fakeDocker({ fail: { createContainer: "invalid mount config" } }) });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("rolledBack");
    expect(result.message).toContain("invalid mount config");
    expect(mutating(t.calls)).toEqual([
      `pullImage(${REPO}, 0.2.0)`,
      `stopContainer(${OLD_ID}, 30)`,
      `renameContainer(${OLD_ID}, ${NAME}-vorher)`,
      `createContainer(${NAME})`,
      // The create may have gone through despite the error: clear the name.
      `removeContainer(${NAME})`,
      `renameContainer(${OLD_ID}, ${NAME})`,
      `startContainer(${OLD_ID})`,
    ]);
    expect(t.reports.map((r) => r.state)).toEqual(["pulling", "starting", "rolledBack"]);
  });

  it("rolls back when connecting an extra network fails", async () => {
    const t = setup({ docker: fakeDocker({ fail: { connectNetwork: "network proxy not found" } }) });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("rolledBack");
    expect(result.message).toContain("network proxy not found");
    expect(mutating(t.calls).slice(-3)).toEqual([
      `removeContainer(${NEW_ID})`,
      `renameContainer(${OLD_ID}, ${NAME})`,
      `startContainer(${OLD_ID})`,
    ]);
  });

  it("rolls back when the new container does not start", async () => {
    const t = setup({
      docker: fakeDocker({ fail: { startContainer: (id) => (id === NEW_ID ? "port is already allocated" : undefined) } }),
    });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("rolledBack");
    expect(result.message).toContain("port is already allocated");
    expect(mutating(t.calls).slice(-3)).toEqual([
      `removeContainer(${NEW_ID})`,
      `renameContainer(${OLD_ID}, ${NAME})`,
      `startContainer(${OLD_ID})`,
    ]);
  });

  it("restarts the old container without renaming when stopping fails", async () => {
    const t = setup({ docker: fakeDocker({ fail: { stopContainer: "timeout after 90s" } }) });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("rolledBack");
    expect(result.message).toContain("timeout after 90s");
    expect(mutating(t.calls)).toEqual([
      `pullImage(${REPO}, 0.2.0)`,
      `stopContainer(${OLD_ID}, 30)`,
      `startContainer(${OLD_ID})`,
    ]);
  });

  it("does not rename back when renaming failed", async () => {
    const t = setup({ docker: fakeDocker({ fail: { renameContainer: "name already in use" } }) });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("rolledBack");
    expect(mutating(t.calls)).toEqual([
      `pullImage(${REPO}, 0.2.0)`,
      `stopContainer(${OLD_ID}, 30)`,
      `renameContainer(${OLD_ID}, ${NAME}-vorher)`,
      `startContainer(${OLD_ID})`,
    ]);
  });

  it("renames back when the rename went through despite an error", async () => {
    const t = setup({
      docker: fakeDocker({
        applyFailedRename: true,
        fail: { renameContainer: (_id, name) => (name === `${NAME}-vorher` ? "connection reset" : undefined) },
      }),
    });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("rolledBack");
    expect(result.message).toContain("connection reset");
    expect(mutating(t.calls)).toEqual([
      `pullImage(${REPO}, 0.2.0)`,
      `stopContainer(${OLD_ID}, 30)`,
      `renameContainer(${OLD_ID}, ${NAME}-vorher)`,
      `renameContainer(${OLD_ID}, ${NAME})`,
      `startContainer(${OLD_ID})`,
    ]);
  });

  it("still rolls back when removing the new container fails", async () => {
    const t = setup({
      health: (url) => (url.includes(OLD_IP) ? "0.1.0" : "0.1.0"),
      healthTimeoutMs: 4_000,
      docker: fakeDocker({ fail: { removeContainer: (id) => (id === NEW_ID ? "busy" : undefined) } }),
    });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("rolledBack");
    expect(mutating(t.calls).slice(-3)).toEqual([
      `removeContainer(${NEW_ID})`,
      `renameContainer(${OLD_ID}, ${NAME})`,
      `startContainer(${OLD_ID})`,
    ]);
  });

  it("reports failed with instructions when the rollback itself fails", async () => {
    const t = setup({
      health: () => "0.1.0",
      healthTimeoutMs: 4_000,
      docker: fakeDocker({
        fail: { startContainer: (id) => (id === OLD_ID ? "cannot start old" : undefined) },
      }),
    });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("failed");
    expect(result.message).toContain("meldet 0.1.0 statt 0.2.0");
    expect(result.message).toContain(
      "Rollback fehlgeschlagen: cannot start old — bitte `docker compose up -d` ausführen",
    );
    expect(result).toBe(t.reports.at(-1));
  });

  it("stops the rollback at a failed rename back", async () => {
    const t = setup({
      health: () => "0.1.0",
      healthTimeoutMs: 4_000,
      docker: fakeDocker({
        fail: { renameContainer: (_id, name) => (name === NAME ? "name in use" : undefined) },
      }),
    });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("failed");
    expect(result.message).toContain("Rollback fehlgeschlagen: name in use");
    expect(mutating(t.calls).slice(-2)).toEqual([`removeContainer(${NEW_ID})`, `renameContainer(${OLD_ID}, ${NAME})`]);
  });

  it("rolls back on an error without a message instead of taking it for success", async () => {
    const fake = fakeDocker();
    const t = setup({
      docker: {
        calls: fake.calls,
        docker: {
          ...fake.docker,
          async startContainer(id) {
            fake.calls.push(["startContainer", id]);
            if (id === NEW_ID) throw new Error("");
          },
        },
      },
    });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("rolledBack");
    expect(result.message).toBe("unbekannter Fehler");
    expect(names(t.calls)).not.toContain(`removeContainer(${OLD_ID})`);
    expect(mutating(t.calls).slice(-3)).toEqual([
      `removeContainer(${NEW_ID})`,
      `renameContainer(${OLD_ID}, ${NAME})`,
      `startContainer(${OLD_ID})`,
    ]);
  });

  it("stays done when removing the old container fails", async () => {
    const t = setup({
      docker: fakeDocker({ fail: { removeContainer: (id) => (id === OLD_ID ? "device busy" : undefined) } }),
    });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("done");
    expect(result.message).toMatch(/^Update auf 0\.2\.0 abgeschlossen/);
    expect(result.message).toContain("device busy");
    expect(names(t.calls)).not.toContain(`startContainer(${OLD_ID})`);
    expect(names(t.calls)).toContain(`tagImage(${REPO}:0.2.0, ${REPO}, latest)`);
  });

  it("stays done when the retag fails", async () => {
    const t = setup({ docker: fakeDocker({ fail: { tagImage: "no space left" } }) });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("done");
    expect(result.message).toMatch(/^Update auf 0\.2\.0 abgeschlossen/);
    expect(result.message).toContain("no space left");
    expect(names(t.calls)).not.toContain(`startContainer(${OLD_ID})`);
    expect(t.reports.map((r) => r.state)).toEqual(["pulling", "starting", "checking", "done"]);
  });

  it("does not retag a digest reference", async () => {
    const t = setup({
      docker: fakeDocker({ old: oldContainer({ image: `${REPO}@sha256:${"a".repeat(64)}` }) }),
    });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("done");
    expect(t.calls.some(([m]) => m === "tagImage")).toBe(false);
  });

  it("splits a registry with port correctly for the retag", async () => {
    const t = setup({ docker: fakeDocker({ old: oldContainer({ image: "127.0.0.1:5055/tanss-agent-portal:e2e" }) }) });
    await runUpdate(t.deps, REQUEST);
    expect(t.calls).toContainEqual(["tagImage", `${REPO}:0.2.0`, "127.0.0.1:5055/tanss-agent-portal", "e2e"]);
  });

  it("retags an untagged reference as latest", async () => {
    const t = setup({ docker: fakeDocker({ old: oldContainer({ image: "127.0.0.1:5055/tanss-agent-portal" }) }) });
    await runUpdate(t.deps, REQUEST);
    expect(t.calls).toContainEqual(["tagImage", `${REPO}:0.2.0`, "127.0.0.1:5055/tanss-agent-portal", "latest"]);
  });

  it("fails without touching anything when the old container cannot be inspected", async () => {
    const t = setup({ findPortal: async () => "gone" });
    const result = await runUpdate(t.deps, REQUEST);
    expect(result.state).toBe("failed");
    expect(result.message).toContain("No such container");
    expect(mutating(t.calls)).toEqual([]);
  });

  it("never throws, even when report throws", async () => {
    const t = setup();
    const result = await runUpdate(
      {
        ...t.deps,
        report() {
          throw new Error("disk full");
        },
      },
      REQUEST,
    );
    expect(result.state).toBe("done");
  });
});

describe("findPortalContainer", () => {
  function self(labels: Record<string, string> | null): ContainerInfo {
    return { ...oldContainer(), Id: SELF_ID, Name: "/agent-portal-updater-1", Config: { ...oldContainer().Config, Labels: labels } };
  }
  const SELF = self({ "com.docker.compose.project": "agent-portal", "com.docker.compose.service": "updater" });

  it("filters by the own compose project and the portal service", async () => {
    const fake = fakeDocker({ self: SELF, list: [{ Id: OLD_ID, Names: [`/${NAME}`] }] });
    await expect(findPortalContainer(fake.docker, SELF_ID)).resolves.toBe(OLD_ID);
    expect(fake.calls).toEqual([
      ["inspectContainer", SELF_ID],
      ["listContainers", { "com.docker.compose.project": "agent-portal", "com.docker.compose.service": "portal" }],
    ]);
  });

  it("throws when no portal container exists", async () => {
    const fake = fakeDocker({ self: SELF, list: [] });
    await expect(findPortalContainer(fake.docker, SELF_ID)).rejects.toThrow("Portal-Container nicht gefunden");
  });

  it("throws when several portal containers exist", async () => {
    const fake = fakeDocker({
      self: SELF,
      list: [
        { Id: OLD_ID, Names: [`/${NAME}`] },
        { Id: "other", Names: ["/agent-portal-portal-2"] },
      ],
    });
    await expect(findPortalContainer(fake.docker, SELF_ID)).rejects.toThrow("mehrere Portal-Container gefunden");
  });

  it("ignores a leftover -vorher container", async () => {
    const fake = fakeDocker({
      self: SELF,
      list: [
        { Id: "leftover", Names: [`/${NAME}-vorher`] },
        { Id: OLD_ID, Names: [`/${NAME}`] },
      ],
    });
    await expect(findPortalContainer(fake.docker, SELF_ID)).resolves.toBe(OLD_ID);
  });

  it("throws when the updater is not part of a compose project", async () => {
    const fake = fakeDocker({ self: self(null) });
    await expect(findPortalContainer(fake.docker, SELF_ID)).rejects.toThrow(
      "Updater läuft nicht unter Docker Compose",
    );
    expect(fake.calls.some(([m]) => m === "listContainers")).toBe(false);
  });
});

describe("recoverInterrupted", () => {
  const SELF = {
    ...oldContainer(),
    Id: SELF_ID,
    Name: "/agent-portal-updater-1",
    Config: {
      ...oldContainer().Config,
      Labels: { "com.docker.compose.project": "agent-portal", "com.docker.compose.service": "updater" },
    },
  };
  const PREVIOUS = { Id: OLD_ID, Names: [`/${NAME}-vorher`] };
  const NEW = { Id: NEW_ID, Names: [`/${NAME}`] };

  function status(state: UpdateStatus["state"]): UpdateStatus {
    return { id: "req-1", state, from: "0.1.0", to: "0.2.0", message: "", at: 1 };
  }

  function recover(
    fake: ReturnType<typeof fakeDocker>,
    current: UpdateStatus | null,
    health: (url: string) => string | null = (url) => (url.includes(NEW_IP) ? "0.2.0" : url.includes(OLD_IP) ? "0.1.0" : null),
  ) {
    const t = setup({ docker: fake, health, healthTimeoutMs: 6_000 });
    return { t, result: recoverInterrupted(t.deps, SELF_ID, current) };
  }

  it("finishes an update whose new version is healthy", async () => {
    const fake = fakeDocker({ self: SELF, list: [PREVIOUS, NEW], old: { ...oldContainer(), Name: `/${NAME}-vorher` } });
    const { t, result } = recover(fake, status("checking"));
    expect(await result).toMatchObject({
      id: "req-1",
      state: "done",
      from: "0.1.0",
      to: "0.2.0",
      message: "Update auf 0.2.0 abgeschlossen (nach Unterbrechung)",
    });
    expect(mutating(t.calls)).toEqual([`removeContainer(${OLD_ID})`, `tagImage(${REPO}:0.2.0, ${REPO}, latest)`]);
    expect(t.reports.at(-1)?.state).toBe("done");
  });

  it("restores the previous container when the new one does not answer", async () => {
    const fake = fakeDocker({ self: SELF, list: [PREVIOUS, NEW], old: { ...oldContainer(), Name: `/${NAME}-vorher` } });
    const { t, result } = recover(fake, status("checking"), () => null);
    expect(await result).toMatchObject({
      state: "rolledBack",
      message: "Update unterbrochen, vorherige Version wiederhergestellt",
    });
    expect(mutating(t.calls)).toEqual([
      `removeContainer(${NEW_ID})`,
      `renameContainer(${OLD_ID}, ${NAME})`,
      `startContainer(${OLD_ID})`,
    ]);
  });

  it("does not wait for a new container that is not running", async () => {
    const fake = fakeDocker({
      self: SELF,
      list: [PREVIOUS, NEW],
      old: { ...oldContainer(), Name: `/${NAME}-vorher` },
      newRunning: false,
    });
    const { t, result } = recover(fake, status("starting"));
    expect((await result)?.state).toBe("rolledBack");
    expect(t.healthUrls).toEqual([]);
    expect(t.elapsed()).toBe(0);
  });

  it("restores the previous container when there is no other portal container", async () => {
    const fake = fakeDocker({ self: SELF, list: [PREVIOUS], old: { ...oldContainer(), Name: `/${NAME}-vorher` } });
    const { t, result } = recover(fake, status("failed"));
    expect((await result)?.state).toBe("rolledBack");
    expect(mutating(t.calls)).toEqual([`renameContainer(${OLD_ID}, ${NAME})`, `startContainer(${OLD_ID})`]);
  });

  it("reports failed when the restore itself fails", async () => {
    const fake = fakeDocker({
      self: SELF,
      list: [PREVIOUS],
      old: { ...oldContainer(), Name: `/${NAME}-vorher` },
      fail: { renameContainer: "name in use" },
    });
    const { result } = recover(fake, status("starting"));
    expect(await result).toMatchObject({
      state: "failed",
      message:
        "Update unterbrochen, Wiederherstellung fehlgeschlagen: name in use — bitte `docker compose up -d` ausführen",
    });
  });

  it("marks an update failed that was interrupted before anything was replaced", async () => {
    const fake = fakeDocker({ self: SELF, list: [{ Id: OLD_ID, Names: [`/${NAME}`] }] });
    const { t, result } = recover(fake, status("pulling"));
    expect(await result).toMatchObject({ id: "req-1", state: "failed", message: "Update unterbrochen" });
    expect(mutating(t.calls)).toEqual([]);
  });

  it("starts a portal container that was stopped before the interruption", async () => {
    const fake = fakeDocker({ self: SELF, list: [{ Id: OLD_ID, Names: [`/${NAME}`] }], oldRunning: false });
    const { t, result } = recover(fake, status("starting"));
    expect((await result)?.state).toBe("failed");
    expect(mutating(t.calls)).toEqual([`startContainer(${OLD_ID})`]);
    expect(t.healthUrls).toEqual([]);
  });

  it("does nothing without a leftover container and without an open update", async () => {
    for (const current of [null, status("done"), status("failed"), status("rolledBack")]) {
      const fake = fakeDocker({ self: SELF, list: [{ Id: OLD_ID, Names: [`/${NAME}`] }] });
      const { t, result } = recover(fake, current);
      expect(await result).toBeNull();
      expect(mutating(t.calls)).toEqual([]);
      expect(t.reports).toEqual([]);
    }
  });
});
