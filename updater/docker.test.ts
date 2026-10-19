import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDockerApi, DockerError } from "./docker.ts";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;

let dir: string;
let socketPath: string;
let server: Server;
let seen: Seen[];
let handler: Handler;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "docker-test-"));
  socketPath = join(dir, "docker.sock");
  seen = [];
  handler = (_req, res) => json(res, 200, {});
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(entry);
      handler(req, res, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function api() {
  return createDockerApi(socketPath, { apiVersion: "1.43" });
}

describe("createDockerApi", () => {
  it("inspectContainer: GET /v1.43/containers/<id>/json", async () => {
    handler = (_req, res) =>
      json(res, 200, { Id: "abc", Name: "/portal", Config: { Image: "x:latest" } });
    const info = await api().inspectContainer("abc");
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("/v1.43/containers/abc/json");
    expect(info.Id).toBe("abc");
    expect(info.Config.Image).toBe("x:latest");
  });

  it("inspectImage: GET /images/<ref urlencoded>/json", async () => {
    handler = (_req, res) => json(res, 200, { Id: "sha256:1", Config: { Labels: null } });
    await api().inspectImage("ghcr.io/a/b:1.2.3");
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("/v1.43/images/ghcr.io%2Fa%2Fb%3A1.2.3/json");
  });

  it("listContainers: filters as urlencoded JSON with label list", async () => {
    handler = (_req, res) => json(res, 200, [{ Id: "abc", Names: ["/portal"] }]);
    const list = await api().listContainers({
      "com.docker.compose.project": "tanss",
      "com.docker.compose.service": "portal",
    });
    expect(list).toEqual([{ Id: "abc", Names: ["/portal"] }]);
    expect(seen[0].method).toBe("GET");
    const url = new URL(seen[0].url, "http://localhost");
    expect(url.pathname).toBe("/v1.43/containers/json");
    expect(url.searchParams.get("all")).toBe("1");
    expect(JSON.parse(url.searchParams.get("filters") ?? "")).toEqual({
      label: ["com.docker.compose.project=tanss", "com.docker.compose.service=portal"],
    });
    expect(seen[0].url).toContain("filters=%7B%22label%22");
  });

  it("pullImage: POST /images/create?fromImage&tag and reads the whole stream", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"status":"Pulling from x"}\r\n');
      res.end('{"status":"Download complete"}\r\n');
    };
    await api().pullImage("ghcr.io/0x5j/tanss-agent-portal", "0.2.0");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe(
      "/v1.43/images/create?fromImage=ghcr.io%2F0x5j%2Ftanss-agent-portal&tag=0.2.0",
    );
  });

  it("pullImage: error line in a 200 stream throws DockerError with that message", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.write('{"status":"Pulling from x"}\n');
      res.end('{"error":"manifest unknown"}\n');
    };
    const err = await api()
      .pullImage("x", "9.9.9")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(DockerError);
    expect((err as DockerError).message).toContain("manifest unknown");
  });

  it("pullImage: errorDetail.message is used as well", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end('{"errorDetail":{"message":"denied: nope"}}\n');
    };
    await expect(api().pullImage("x", "1.0.0")).rejects.toThrow("denied: nope");
  });

  it("tagImage: POST /images/<ref>/tag?repo&tag", async () => {
    handler = (_req, res) => {
      res.writeHead(201);
      res.end();
    };
    await api().tagImage("ghcr.io/a/b:1.2.3", "ghcr.io/a/b", "latest");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/v1.43/images/ghcr.io%2Fa%2Fb%3A1.2.3/tag?repo=ghcr.io%2Fa%2Fb&tag=latest");
  });

  it("createContainer: POST with JSON body, returns Id", async () => {
    handler = (_req, res) => json(res, 201, { Id: "new123", Warnings: [] });
    const id = await api().createContainer("portal", { Image: "x:1", Env: ["A=1"] });
    expect(id).toBe("new123");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/v1.43/containers/create?name=portal");
    expect(seen[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(seen[0].body)).toEqual({ Image: "x:1", Env: ["A=1"] });
  });

  it("startContainer: POST /start, 304 is success", async () => {
    handler = (_req, res) => {
      res.writeHead(304);
      res.end();
    };
    await api().startContainer("abc");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/v1.43/containers/abc/start");
  });

  it("stopContainer: POST /stop?t=, 304 is success", async () => {
    handler = (_req, res) => {
      res.writeHead(304);
      res.end();
    };
    await api().stopContainer("abc", 30);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/v1.43/containers/abc/stop?t=30");
  });

  it("removeContainer: DELETE with force=1", async () => {
    handler = (_req, res) => {
      res.writeHead(204);
      res.end();
    };
    await api().removeContainer("abc");
    expect(seen[0].method).toBe("DELETE");
    expect(seen[0].url).toBe("/v1.43/containers/abc?force=1");
  });

  it("renameContainer: POST /rename?name=", async () => {
    handler = (_req, res) => {
      res.writeHead(204);
      res.end();
    };
    await api().renameContainer("abc", "portal-vorher");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/v1.43/containers/abc/rename?name=portal-vorher");
  });

  it("connectNetwork: POST /networks/<n>/connect with Container and EndpointConfig", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end();
    };
    await api().connectNetwork("tanss_default", "abc", { Aliases: ["portal"] });
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/v1.43/networks/tanss_default/connect");
    expect(JSON.parse(seen[0].body)).toEqual({
      Container: "abc",
      EndpointConfig: { Aliases: ["portal"] },
    });
  });

  it("404 becomes DockerError with status and the daemon message", async () => {
    handler = (_req, res) => json(res, 404, { message: "No such container: nope" });
    const err = await api()
      .inspectContainer("nope")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(DockerError);
    expect((err as DockerError).status).toBe(404);
    expect((err as DockerError).message).toContain("No such container: nope");
    expect((err as DockerError).message).toContain("GET /containers/nope/json");
  });

  it("non-JSON error body falls back to body text", async () => {
    handler = (_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("boom");
    };
    const err = await api()
      .removeContainer("abc")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((err as DockerError).status).toBe(500);
    expect((err as DockerError).message).toContain("boom");
  });

  it("unreachable socket rejects with DockerError", async () => {
    const dead = createDockerApi(join(dir, "missing.sock"), { apiVersion: "1.43" });
    await expect(dead.inspectContainer("abc")).rejects.toBeInstanceOf(DockerError);
  });
});

describe("API version negotiation", () => {
  function versionServer(apiVersion: string) {
    handler = (req, res) => {
      if (req.url === "/version") json(res, 200, { ApiVersion: apiVersion });
      else json(res, 200, { Id: "abc" });
    };
  }

  it("server newer than 1.47: uses /v1.47 and asks /version once", async () => {
    versionServer("1.56");
    const docker = createDockerApi(socketPath);
    await docker.inspectContainer("abc");
    await docker.inspectContainer("abc");
    expect(seen.map((s) => s.url)).toEqual([
      "/version",
      "/v1.47/containers/abc/json",
      "/v1.47/containers/abc/json",
    ]);
  });

  it("server older than 1.47: uses the server's version", async () => {
    versionServer("1.43");
    await createDockerApi(socketPath).inspectContainer("abc");
    expect(seen.map((s) => s.url)).toEqual(["/version", "/v1.43/containers/abc/json"]);
  });

  it("compares numerically (1.9 < 1.47)", async () => {
    versionServer("1.9");
    await createDockerApi(socketPath).inspectContainer("abc");
    expect(seen[1].url).toBe("/v1.9/containers/abc/json");
  });
});
