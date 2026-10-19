import { compareVersions, isVersion, type ReleaseInfo, type UpdateChannel } from "../shared/update.ts";

const API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 10_000;
/** How many recent releases the staging channel looks at. */
const LIST_LIMIT = 30;

export type ReleaseSource = {
  /** Newest release of the channel, or null when there is none (yet). Throws when GitHub cannot be asked. */
  latest(channel: UpdateChannel): Promise<ReleaseInfo | null>;
};

type GithubRelease = {
  tag_name?: unknown;
  body?: unknown;
  html_url?: unknown;
  prerelease?: unknown;
  draft?: unknown;
  published_at?: unknown;
};

/** Tags are "vX.Y.Z"; anything else (rc suffixes, junk) is not a release for us. */
function versionFromTag(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  return isVersion(version) ? version : null;
}

function toInfo(release: GithubRelease, version: string): ReleaseInfo {
  return {
    version,
    notes: typeof release.body === "string" ? release.body : "",
    url: typeof release.html_url === "string" ? release.html_url : "",
    prerelease: release.prerelease === true,
    publishedAt: typeof release.published_at === "string" ? release.published_at : "",
  };
}

export function createReleaseSource(opts: { repo: string; fetch?: typeof fetch }): ReleaseSource {
  const doFetch = opts.fetch ?? fetch;

  async function get(path: string): Promise<Response> {
    try {
      return await doFetch(`${API}/repos/${opts.repo}${path}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "tanss-agent-portal" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error("GitHub nicht erreichbar");
    }
  }

  async function json(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw new Error("Unerwartete Antwort von GitHub");
    }
  }

  async function stable(): Promise<ReleaseInfo | null> {
    const res = await get("/releases/latest");
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub antwortet ${res.status}`);
    const release = (await json(res)) as GithubRelease | null;
    if (!release || typeof release !== "object") throw new Error("Unerwartete Antwort von GitHub");
    const version = versionFromTag(release.tag_name);
    if (!version) throw new Error(`Release-Tag "${String(release.tag_name)}" ist keine Version`);
    return toInfo(release, version);
  }

  async function staging(): Promise<ReleaseInfo | null> {
    const res = await get(`/releases?per_page=${LIST_LIMIT}`);
    if (!res.ok) throw new Error(`GitHub antwortet ${res.status}`);
    const list = await json(res);
    if (!Array.isArray(list)) throw new Error("Unerwartete Antwort von GitHub");
    let best: ReleaseInfo | null = null;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const release = item as GithubRelease;
      if (release.draft === true) continue;
      const version = versionFromTag(release.tag_name);
      if (!version) continue;
      if (!best || compareVersions(version, best.version) > 0) best = toInfo(release, version);
    }
    return best;
  }

  return { latest: (channel) => (channel === "stable" ? stable() : staging()) };
}
