// Minimal Docker Engine API client over the Unix socket. Node built-ins only:
// the updater image has no npm dependencies.
import { request } from "node:http";

const MAX_API_VERSION = "1.47";
const REQUEST_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 10 * 60_000;

export class DockerError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DockerError";
    this.status = status;
  }
}

export interface ContainerInfo {
  Id: string;
  Name: string;
  Image: string;
  Config: {
    Image: string;
    Env: string[] | null;
    Labels: Record<string, string> | null;
    Hostname: string;
    [key: string]: unknown;
  };
  HostConfig: Record<string, unknown>;
  NetworkSettings: {
    Networks: Record<string, { IPAddress: string; Aliases: string[] | null; [key: string]: unknown }>;
  };
}

export interface ImageInfo {
  Id: string;
  Config: {
    Env: string[] | null;
    Labels: Record<string, string> | null;
    [key: string]: unknown;
  };
}

export interface DockerApi {
  inspectContainer(id: string): Promise<ContainerInfo>;
  listContainers(labels: Record<string, string>): Promise<{ Id: string; Names: string[] }[]>;
  inspectImage(ref: string): Promise<ImageInfo>;
  pullImage(repo: string, tag: string): Promise<void>;
  tagImage(ref: string, repo: string, tag: string): Promise<void>;
  createContainer(name: string, body: object): Promise<string>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string, timeoutSeconds: number): Promise<void>;
  removeContainer(id: string): Promise<void>;
  renameContainer(id: string, name: string): Promise<void>;
  connectNetwork(network: string, id: string, endpoint: object): Promise<void>;
}

// Numeric "major.minor" comparison (1.9 < 1.47), not string comparison.
function compareVersions(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

function errorMessage(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // not JSON, use the raw text
  }
  return text.trim();
}

// Pull progress is a stream of JSON lines; failures show up as a line with an
// error even though the HTTP status is 200.
function pullStreamError(text: string): string | null {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as { error?: unknown; errorDetail?: { message?: unknown } };
    if (typeof obj.error === "string" && obj.error) return obj.error;
    if (typeof obj.errorDetail?.message === "string" && obj.errorDetail.message) {
      return obj.errorDetail.message;
    }
  }
  return null;
}

export function createDockerApi(
  socketPath = "/var/run/docker.sock",
  opts: { apiVersion?: string } = {},
): DockerApi {
  let versionPromise: Promise<string> | null = opts.apiVersion ? Promise.resolve(opts.apiVersion) : null;

  function send(
    method: string,
    path: string,
    body?: object,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<{ status: number; text: string }> {
    const label = `${method} ${path.split("?")[0]}`;
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string | number> = {};
      if (payload !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }
      const req = request({ socketPath, path, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", (err) => reject(new DockerError(`${label}: ${err.message}`, 0)));
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`timeout after ${Math.round(timeoutMs / 1000)}s`));
      });
      req.on("error", (err) => reject(new DockerError(`${label}: ${err.message}`, 0)));
      req.end(payload);
    });
  }

  function apiVersion(): Promise<string> {
    if (!versionPromise) {
      versionPromise = send("GET", "/version").then(({ status, text }) => {
        if (status < 200 || status >= 300) {
          throw new DockerError(`GET /version: ${errorMessage(text) || `HTTP ${status}`}`, status);
        }
        const reported = (JSON.parse(text) as { ApiVersion?: unknown }).ApiVersion;
        return typeof reported === "string" && compareVersions(reported, MAX_API_VERSION) < 0
          ? reported
          : MAX_API_VERSION;
      });
      // Do not cache a failure: the next call asks the daemon again.
      versionPromise.catch(() => {
        versionPromise = null;
      });
    }
    return versionPromise;
  }

  async function call(
    method: string,
    path: string,
    o: { body?: object; okStatuses?: number[]; timeoutMs?: number } = {},
  ): Promise<string> {
    const version = await apiVersion();
    const { status, text } = await send(method, `/v${version}${path}`, o.body, o.timeoutMs);
    if ((status >= 200 && status < 300) || o.okStatuses?.includes(status)) return text;
    throw new DockerError(
      `${method} ${path.split("?")[0]}: ${errorMessage(text) || `HTTP ${status}`}`,
      status,
    );
  }

  const enc = encodeURIComponent;

  return {
    async inspectContainer(id) {
      return JSON.parse(await call("GET", `/containers/${enc(id)}/json`)) as ContainerInfo;
    },
    async listContainers(labels) {
      const filters = { label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) };
      const text = await call("GET", `/containers/json?all=1&filters=${enc(JSON.stringify(filters))}`);
      return JSON.parse(text) as { Id: string; Names: string[] }[];
    },
    async inspectImage(ref) {
      return JSON.parse(await call("GET", `/images/${enc(ref)}/json`)) as ImageInfo;
    },
    async pullImage(repo, tag) {
      const text = await call("POST", `/images/create?fromImage=${enc(repo)}&tag=${enc(tag)}`, {
        timeoutMs: PULL_TIMEOUT_MS,
      });
      const failure = pullStreamError(text);
      if (failure) throw new DockerError(`POST /images/create: ${failure}`, 200);
    },
    async tagImage(ref, repo, tag) {
      await call("POST", `/images/${enc(ref)}/tag?repo=${enc(repo)}&tag=${enc(tag)}`);
    },
    async createContainer(name, body) {
      const text = await call("POST", `/containers/create?name=${enc(name)}`, { body });
      return (JSON.parse(text) as { Id: string }).Id;
    },
    async startContainer(id) {
      await call("POST", `/containers/${enc(id)}/start`, { okStatuses: [304] });
    },
    async stopContainer(id, timeoutSeconds) {
      await call("POST", `/containers/${enc(id)}/stop?t=${timeoutSeconds}`, {
        okStatuses: [304],
        // The daemon waits up to the stop timeout before killing.
        timeoutMs: REQUEST_TIMEOUT_MS + timeoutSeconds * 1000,
      });
    },
    async removeContainer(id) {
      await call("DELETE", `/containers/${enc(id)}?force=1`);
    },
    async renameContainer(id, name) {
      await call("POST", `/containers/${enc(id)}/rename?name=${enc(name)}`);
    },
    async connectNetwork(network, id, endpoint) {
      await call("POST", `/networks/${enc(network)}/connect`, {
        body: { Container: id, EndpointConfig: endpoint },
      });
    },
  };
}
