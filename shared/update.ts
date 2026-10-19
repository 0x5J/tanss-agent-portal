// Shared by the portal server, the UI and the updater container. The updater
// image copies only this file, so it must not import anything.

/** Releases are plain X.Y.Z — no "v" prefix, no pre-release suffix. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export type UpdateChannel = "stable" | "staging";

export type ReleaseInfo = {
  version: string;
  notes: string;
  url: string;
  prerelease: boolean;
  publishedAt: string;
};

/** Written by the portal into request.json. */
export type UpdateRequest = { id: string; version: string; requestedAt: number };

export type UpdateState =
  | "pulling"
  | "starting"
  | "checking"
  | "done"
  | "failed"
  | "rolledBack";

/** Written by the updater into status.json. */
export type UpdateStatus = {
  id: string;
  state: UpdateState;
  from: string;
  to: string;
  message: string;
  at: number;
};

/** Written by the updater into heartbeat.json every few seconds. */
export type UpdaterHeartbeat = { at: number; version: string };

export type UpdateOverview = {
  current: string;
  channel: UpdateChannel;
  enabled: boolean;
  latest: ReleaseInfo | null;
  checkedAt: number | null;
  checkError: string | null;
  updater: "ready" | "missing";
  requested: UpdateRequest | null;
  status: UpdateStatus | null;
};

export type UpdateBanner = {
  tone: "info" | "progress" | "error";
  text: string;
  action: "update" | null;
};

/** The updater counts as gone when its heartbeat is older than this. */
export const HEARTBEAT_STALE_MS = 60_000;
/** An update that has not moved for this long is treated as stuck. */
export const UPDATE_STALE_MS = 600_000;

export const REQUEST_FILE = "request.json";
export const STATUS_FILE = "status.json";
export const HEARTBEAT_FILE = "heartbeat.json";

const MANUAL_UPDATE_COMMAND = "docker compose pull && docker compose up -d";

export function isVersion(v: string): boolean {
  return VERSION_PATTERN.test(v);
}

/** Negative, zero or positive like a sort comparator; throws on a bad version. */
export function compareVersions(a: string, b: string): number {
  if (!isVersion(a)) throw new Error(`Ungültige Version: ${a}`);
  if (!isVersion(b)) throw new Error(`Ungültige Version: ${b}`);
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = pa[i]! - pb[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Like compareVersions > 0, but a version that cannot be compared is not newer. */
function isNewer(candidate: string, than: string): boolean {
  return isVersion(candidate) && isVersion(than) && compareVersions(candidate, than) > 0;
}

function inProgress(status: UpdateStatus | null, now: number): boolean {
  return (
    status !== null &&
    (status.state === "pulling" || status.state === "starting" || status.state === "checking") &&
    now - status.at < UPDATE_STALE_MS
  );
}

/** An update is under way: a request is open, or the updater is still working. */
export function isBusy(o: Pick<UpdateOverview, "requested" | "status">, now: number): boolean {
  return o.requested !== null || inProgress(o.status, now);
}

function progressText(status: UpdateStatus): string {
  const head = `Update auf ${status.to}`;
  if (status.state === "pulling") return `${head}: Image wird geladen …`;
  if (status.state === "starting") return `${head}: Portal startet neu …`;
  return `${head}: neue Version wird geprüft …`;
}

/** What the banner above all views says right now, or null for nothing. */
export function updateBanner(o: UpdateOverview, now: number): UpdateBanner | null {
  if (isBusy(o, now)) {
    // A request the updater has not picked up yet has no progress to show.
    const text =
      o.status && inProgress(o.status, now)
        ? progressText(o.status)
        : `Update auf ${o.requested?.version ?? ""}: wird gestartet …`;
    return { tone: "progress", text, action: null };
  }

  const offer = o.enabled && o.latest && isNewer(o.latest.version, o.current) ? o.latest : null;

  // A fresh failure stays visible — unless a different, newer release has
  // arrived since, which supersedes the failed attempt.
  const s = o.status;
  if (
    s &&
    (s.state === "failed" || s.state === "rolledBack") &&
    now - s.at < UPDATE_STALE_MS &&
    (!offer || offer.version === s.to)
  ) {
    const text =
      s.state === "failed"
        ? `Update auf ${s.to} fehlgeschlagen: ${s.message}`
        : `Update auf ${s.to} fehlgeschlagen und zurückgerollt, ${s.from} läuft weiter: ${s.message}`;
    return { tone: "error", text, action: null };
  }

  if (!offer) return null;

  const kind = o.channel === "staging" && offer.prerelease ? "Staging-Vorabversion, " : "";
  const head = `Version ${offer.version} verfügbar (${kind}installiert: ${o.current}).`;
  if (o.updater === "missing") {
    return {
      tone: "info",
      text: `${head} Der Updater läuft nicht. Zum Aktualisieren im Installationsordner „${MANUAL_UPDATE_COMMAND}“ ausführen.`,
      action: null,
    };
  }
  return { tone: "info", text: head, action: "update" };
}
