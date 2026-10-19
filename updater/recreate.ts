// Derives the create request for the new portal container from the old one.
// Pure function, no Docker calls: the caller creates the container and
// connects the extra networks.
import type { ContainerInfo, ImageInfo, Platform } from "./docker.ts";

export interface ContainerSpec {
  name: string;
  body: object;
  extraNetworks: { name: string; endpoint: object }[];
}

// Config fields that are dropped when they still equal the old image's value,
// so the new image's defaults apply instead of pinning the old ones.
const COMPOSE_IMAGE = "com.docker.compose.image";

const IMAGE_DEFAULT_FIELDS = [
  "Cmd",
  "Entrypoint",
  "WorkingDir",
  "User",
  "Healthcheck",
  "ExposedPorts",
  "Volumes",
  "StopSignal",
];

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

function filterEnv(env: string[] | null, imageEnv: string[] | null): string[] {
  const inherited = new Set(imageEnv ?? []);
  return (env ?? []).filter((entry) => !inherited.has(entry));
}

function filterLabels(
  labels: Record<string, string> | null,
  imageLabels: Record<string, string> | null,
): Record<string, string> {
  const inherited = imageLabels ?? {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (!Object.hasOwn(inherited, key) || inherited[key] !== value) result[key] = value;
  }
  return result;
}

// Only configuration is carried over, never runtime state (IP, MAC, endpoint id).
function toEndpoint(
  network: ContainerInfo["NetworkSettings"]["Networks"][string],
  dropAliases: Set<string>,
): object {
  const endpoint: Record<string, unknown> = {};
  if (network.Aliases != null) endpoint.Aliases = network.Aliases.filter((alias) => !dropAliases.has(alias));
  if (network.IPAMConfig != null) endpoint.IPAMConfig = structuredClone(network.IPAMConfig);
  if (network.Links != null) endpoint.Links = structuredClone(network.Links);
  return endpoint;
}

export function createSpec(old: ContainerInfo, oldImage: ImageInfo, imageRef: string): ContainerSpec {
  const body: Record<string, unknown> = structuredClone(old.Config);

  for (const field of IMAGE_DEFAULT_FIELDS) {
    if (deepEqual(old.Config[field], oldImage.Config[field])) delete body[field];
  }
  body.Image = imageRef;
  body.Env = filterEnv(old.Config.Env, oldImage.Config.Env);
  body.Labels = filterLabels(old.Config.Labels, oldImage.Config.Labels);
  // Docker sets the hostname to the short id by default; the new container has another id.
  if (old.Config.Hostname === old.Id.slice(0, 12)) delete body.Hostname;
  body.HostConfig = structuredClone(old.HostConfig);

  // At create time only one network is accepted (older API versions); the
  // container's primary network (HostConfig.NetworkMode) must stay primary.
  const networks = old.NetworkSettings.Networks;
  const names = Object.keys(networks);
  const mode = old.HostConfig.NetworkMode;
  const first = typeof mode === "string" && names.includes(mode) ? mode : names[0];
  const dropAliases = new Set([old.Id.slice(0, 12), old.Id]);

  const endpoints: Record<string, object> = {};
  if (first !== undefined) endpoints[first] = toEndpoint(networks[first], dropAliases);
  body.NetworkingConfig = { EndpointsConfig: endpoints };

  const extraNetworks = names
    .filter((name) => name !== first)
    .map((name) => ({ name, endpoint: toEndpoint(networks[name], dropAliases) }));

  return { name: old.Name.replace(/^\//, ""), body, extraNetworks };
}

function samePlatform(a: Platform | undefined, b: Platform | undefined): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.os === b.os &&
    a.architecture === b.architecture &&
    (a.variant ?? "") === (b.variant ?? "")
  );
}

/**
 * The value for compose's `com.docker.compose.image` label on the new
 * container, so the next `docker compose up -d` sees no drift. Compose writes
 * the platform manifest digest on the containerd image store (visible from
 * API 1.48 on) and the image id on the classic store; whichever the old label
 * matches is carried forward. `newImage` needs its Manifests (?manifests=1)
 * for the containerd case. An unrecognised label stays as it is.
 */
export function composeImageLabel(old: ContainerInfo, oldImage: ImageInfo, newImage: ImageInfo): string | undefined {
  const label = old.Config.Labels?.[COMPOSE_IMAGE];
  if (label === undefined) return undefined;
  const descriptor = old.ImageManifestDescriptor;
  if (descriptor && label === descriptor.digest) {
    const match = (newImage.Manifests ?? []).find(
      (m) => m.Kind === "image" && m.Available === true && samePlatform(m.Descriptor.platform, descriptor.platform),
    );
    return match ? match.Descriptor.digest : label;
  }
  if (label === oldImage.Id) return newImage.Id;
  return label;
}
