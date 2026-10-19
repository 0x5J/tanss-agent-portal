import { describe, expect, it } from "vitest";
import type { ContainerInfo, ImageInfo } from "./docker.ts";
import { createSpec } from "./recreate.ts";

const FULL_ID = "3f4c9a1b2d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718";
const SHORT_ID = FULL_ID.slice(0, 12);
const HEALTHCHECK = { Test: ["CMD", "node", "healthcheck.js"], Interval: 30_000_000_000 };

function oldImage(): ImageInfo {
  return {
    Id: "sha256:aaaa",
    Config: {
      Env: ["NODE_ENV=production", "PATH=/usr/local/bin:/usr/bin", "DATA_DIR=/data"],
      Labels: {
        "org.opencontainers.image.version": "0.1.0",
        "org.opencontainers.image.source": "https://github.com/0x5J/tanss-agent-portal",
      },
      Cmd: ["node", "server/index.ts"],
      Entrypoint: ["docker-entrypoint.sh"],
      WorkingDir: "/app",
      User: "node",
      Healthcheck: HEALTHCHECK,
      ExposedPorts: { "3848/tcp": {} },
      Volumes: null,
      StopSignal: "SIGTERM",
    },
  };
}

function oldContainer(): ContainerInfo {
  return {
    Id: FULL_ID,
    Name: "/tanss-portal-portal-1",
    Image: "sha256:aaaa",
    Config: {
      Image: "ghcr.io/0x5j/tanss-agent-portal:latest",
      Hostname: SHORT_ID,
      Domainname: "",
      Env: [
        "PORT=3848",
        "TZ=Europe/Berlin",
        "NODE_ENV=production",
        "PATH=/usr/local/bin:/usr/bin",
        "DATA_DIR=/data",
      ],
      Labels: {
        "com.docker.compose.project": "tanss-portal",
        "com.docker.compose.service": "portal",
        "com.docker.compose.version": "2.29.0",
        "org.opencontainers.image.version": "0.1.0",
        "org.opencontainers.image.source": "https://github.com/0x5J/tanss-agent-portal",
      },
      Cmd: ["node", "server/index.ts"],
      Entrypoint: ["docker-entrypoint.sh"],
      WorkingDir: "/app",
      User: "node",
      Healthcheck: HEALTHCHECK,
      ExposedPorts: { "3848/tcp": {} },
      Volumes: null,
      StopSignal: "SIGTERM",
    },
    HostConfig: {
      Binds: ["/srv/portal/data:/data", "/srv/portal/update:/update"],
      PortBindings: { "3848/tcp": [{ HostIp: "127.0.0.1", HostPort: "3848" }] },
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      NetworkMode: "tanss-portal_default",
    },
    NetworkSettings: {
      Networks: {
        "tanss-portal_default": {
          IPAddress: "172.18.0.3",
          Aliases: ["tanss-portal-portal-1", "portal", SHORT_ID],
          IPAMConfig: null,
          Links: null,
          NetworkID: "net1",
          EndpointID: "ep1",
          MacAddress: "02:42:ac:12:00:03",
        },
        proxy: {
          IPAddress: "172.19.0.5",
          Aliases: ["portal", FULL_ID],
          IPAMConfig: { IPv4Address: "172.19.0.5" },
          Links: ["db:database"],
          NetworkID: "net2",
          EndpointID: "ep2",
          MacAddress: "02:42:ac:13:00:05",
        },
      },
    },
  };
}

const NEW_REF = "ghcr.io/0x5j/tanss-agent-portal:0.2.0";

function bodyOf(spec: ReturnType<typeof createSpec>): Record<string, unknown> {
  return spec.body as Record<string, unknown>;
}

describe("createSpec", () => {
  it("uses the new image and takes the name without the leading slash", () => {
    const spec = createSpec(oldContainer(), oldImage(), NEW_REF);
    expect(spec.name).toBe("tanss-portal-portal-1");
    expect(bodyOf(spec).Image).toBe(NEW_REF);
  });

  it("keeps HostConfig as it is", () => {
    const old = oldContainer();
    const spec = createSpec(old, oldImage(), NEW_REF);
    expect(bodyOf(spec).HostConfig).toEqual(old.HostConfig);
  });

  it("drops labels that the old image provides and keeps compose labels", () => {
    const labels = bodyOf(createSpec(oldContainer(), oldImage(), NEW_REF)).Labels as Record<string, string>;
    expect(labels).toEqual({
      "com.docker.compose.project": "tanss-portal",
      "com.docker.compose.service": "portal",
      "com.docker.compose.version": "2.29.0",
    });
  });

  it("keeps a label whose value differs from the old image", () => {
    const old = oldContainer();
    old.Config.Labels = { ...old.Config.Labels, "org.opencontainers.image.version": "custom" };
    const labels = bodyOf(createSpec(old, oldImage(), NEW_REF)).Labels as Record<string, string>;
    expect(labels["org.opencontainers.image.version"]).toBe("custom");
  });

  it("drops env entries identical to the old image and keeps its own", () => {
    const env = bodyOf(createSpec(oldContainer(), oldImage(), NEW_REF)).Env;
    expect(env).toEqual(["PORT=3848", "TZ=Europe/Berlin"]);
  });

  it("keeps an env entry that overrides an image value", () => {
    const old = oldContainer();
    old.Config.Env = ["NODE_ENV=development", "PORT=3848"];
    expect(bodyOf(createSpec(old, oldImage(), NEW_REF)).Env).toEqual(["NODE_ENV=development", "PORT=3848"]);
  });

  it("handles null Env and Labels on both sides", () => {
    const old = oldContainer();
    old.Config.Env = null;
    old.Config.Labels = null;
    const image = oldImage();
    image.Config.Env = null;
    image.Config.Labels = null;
    const body = bodyOf(createSpec(old, image, NEW_REF));
    expect(body.Env).toEqual([]);
    expect(body.Labels).toEqual({});

    const withOwn = oldContainer();
    expect(bodyOf(createSpec(withOwn, image, NEW_REF)).Env).toEqual(withOwn.Config.Env);
  });

  it("drops the hostname when it is the short container id", () => {
    expect(bodyOf(createSpec(oldContainer(), oldImage(), NEW_REF))).not.toHaveProperty("Hostname");
  });

  it("keeps a custom hostname", () => {
    const old = oldContainer();
    old.Config.Hostname = "portal-host";
    expect(bodyOf(createSpec(old, oldImage(), NEW_REF)).Hostname).toBe("portal-host");
  });

  it("drops image-default fields so the new image's defaults apply", () => {
    const body = bodyOf(createSpec(oldContainer(), oldImage(), NEW_REF));
    for (const key of [
      "Cmd",
      "Entrypoint",
      "WorkingDir",
      "User",
      "Healthcheck",
      "ExposedPorts",
      "Volumes",
      "StopSignal",
    ]) {
      expect(body, key).not.toHaveProperty(key);
    }
    expect(body.Domainname).toBe("");
  });

  it("keeps deliberately overridden fields", () => {
    const old = oldContainer();
    old.Config.Cmd = ["node", "server/index.ts", "--verbose"];
    old.Config.User = "1001";
    old.Config.Healthcheck = { Test: ["NONE"] };
    const body = bodyOf(createSpec(old, oldImage(), NEW_REF));
    expect(body.Cmd).toEqual(["node", "server/index.ts", "--verbose"]);
    expect(body.User).toBe("1001");
    expect(body.Healthcheck).toEqual({ Test: ["NONE"] });
    expect(body).not.toHaveProperty("Entrypoint");
  });

  it("puts the NetworkMode network first and the other into extraNetworks", () => {
    const spec = createSpec(oldContainer(), oldImage(), NEW_REF);
    expect(bodyOf(spec).NetworkingConfig).toEqual({
      EndpointsConfig: {
        "tanss-portal_default": {
          Aliases: ["tanss-portal-portal-1", "portal"],
        },
      },
    });
    expect(spec.extraNetworks).toEqual([
      { name: "proxy", endpoint: { Aliases: ["portal"], IPAMConfig: { IPv4Address: "172.19.0.5" }, Links: ["db:database"] } },
    ]);
  });

  it("keeps endpoints free of runtime fields", () => {
    const spec = createSpec(oldContainer(), oldImage(), NEW_REF);
    const endpoints = (bodyOf(spec).NetworkingConfig as { EndpointsConfig: Record<string, object> }).EndpointsConfig;
    for (const endpoint of [...Object.values(endpoints), ...spec.extraNetworks.map((n) => n.endpoint)]) {
      for (const key of ["IPAddress", "MacAddress", "EndpointID", "NetworkID", "Gateway"]) {
        expect(endpoint, key).not.toHaveProperty(key);
      }
    }
  });

  it("omits null Aliases, IPAMConfig and Links from endpoints", () => {
    const old = oldContainer();
    old.NetworkSettings.Networks = {
      "tanss-portal_default": { IPAddress: "172.18.0.3", Aliases: null, IPAMConfig: null, Links: null },
    };
    const spec = createSpec(old, oldImage(), NEW_REF);
    expect(bodyOf(spec).NetworkingConfig).toEqual({ EndpointsConfig: { "tanss-portal_default": {} } });
    expect(spec.extraNetworks).toEqual([]);
  });

  it("falls back to the first network when NetworkMode names none of them", () => {
    const old = oldContainer();
    old.HostConfig = { ...old.HostConfig, NetworkMode: "default" };
    const spec = createSpec(old, oldImage(), NEW_REF);
    const endpoints = (bodyOf(spec).NetworkingConfig as { EndpointsConfig: Record<string, object> }).EndpointsConfig;
    expect(Object.keys(endpoints)).toEqual(["tanss-portal_default"]);
    expect(spec.extraNetworks.map((n) => n.name)).toEqual(["proxy"]);
  });

  it("keeps the primary network primary when it is not the first key", () => {
    const old = oldContainer();
    old.HostConfig = { ...old.HostConfig, NetworkMode: "proxy" };
    const spec = createSpec(old, oldImage(), NEW_REF);
    const endpoints = (bodyOf(spec).NetworkingConfig as { EndpointsConfig: Record<string, object> }).EndpointsConfig;
    expect(Object.keys(endpoints)).toEqual(["proxy"]);
    expect(spec.extraNetworks.map((n) => n.name)).toEqual(["tanss-portal_default"]);
  });

  it("handles a container without networks", () => {
    const old = oldContainer();
    old.NetworkSettings.Networks = {};
    const spec = createSpec(old, oldImage(), NEW_REF);
    expect(bodyOf(spec).NetworkingConfig).toEqual({ EndpointsConfig: {} });
    expect(spec.extraNetworks).toEqual([]);
  });

  it("does not mutate its inputs and shares no references with them", () => {
    const old = oldContainer();
    const image = oldImage();
    const oldCopy = structuredClone(old);
    const imageCopy = structuredClone(image);
    const spec = createSpec(old, image, NEW_REF);
    expect(old).toEqual(oldCopy);
    expect(image).toEqual(imageCopy);
    expect(bodyOf(spec).HostConfig).not.toBe(old.HostConfig);
  });
});
