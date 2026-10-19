import { describe, expect, it } from "vitest";
import { createReleaseSource } from "./releases.ts";

const REPO = "0x5J/tanss-agent-portal";

type Call = { url: string; headers: Record<string, string> };

function fakeFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  body: `Notes ${tag}`,
  html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
  prerelease: false,
  draft: false,
  published_at: "2026-10-01T10:00:00Z",
  ...extra,
});

describe("release source", () => {
  it("stable asks for the latest release and maps it", async () => {
    const fake = fakeFetch(200, release("v0.2.0", { body: "Notes" }));
    const source = createReleaseSource({ repo: REPO, fetch: fake.fetch });
    const info = await source.latest("stable");
    expect(info).toEqual({
      version: "0.2.0",
      notes: "Notes",
      url: `https://github.com/${REPO}/releases/tag/v0.2.0`,
      prerelease: false,
      publishedAt: "2026-10-01T10:00:00Z",
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toBe("https://api.github.com/repos/0x5J/tanss-agent-portal/releases/latest");
    expect(fake.calls[0].headers.Accept).toBe("application/vnd.github+json");
    expect(fake.calls[0].headers["User-Agent"]).toBe("tanss-agent-portal");
  });

  it("turns a null body into empty notes", async () => {
    const fake = fakeFetch(200, release("v0.2.0", { body: null }));
    const info = await createReleaseSource({ repo: REPO, fetch: fake.fetch }).latest("stable");
    expect(info?.notes).toBe("");
  });

  it("stable without any release is null", async () => {
    const fake = fakeFetch(404, { message: "Not Found" });
    expect(await createReleaseSource({ repo: REPO, fetch: fake.fetch }).latest("stable")).toBeNull();
  });

  it("stable with an unusable tag is an error", async () => {
    const fake = fakeFetch(200, release("nightly"));
    await expect(createReleaseSource({ repo: REPO, fetch: fake.fetch }).latest("stable")).rejects.toThrow(
      /Release-Tag/,
    );
  });

  it("staging takes the highest valid non-draft release, prereleases included", async () => {
    const fake = fakeFetch(200, [
      release("v0.2.0"),
      release("v0.3.0", { prerelease: true }),
      release("v0.4.0", { draft: true }),
      release("v1.0.0-rc.1", { prerelease: true }),
      "foo",
    ]);
    const info = await createReleaseSource({ repo: REPO, fetch: fake.fetch }).latest("staging");
    expect(info?.version).toBe("0.3.0");
    expect(info?.prerelease).toBe(true);
    expect(fake.calls[0].url).toBe("https://api.github.com/repos/0x5J/tanss-agent-portal/releases?per_page=30");
    expect(fake.calls[0].headers.Accept).toBe("application/vnd.github+json");
    expect(fake.calls[0].headers["User-Agent"]).toBe("tanss-agent-portal");
  });

  it("staging without usable releases is null", async () => {
    const fake = fakeFetch(200, [release("v0.4.0", { draft: true })]);
    expect(await createReleaseSource({ repo: REPO, fetch: fake.fetch }).latest("staging")).toBeNull();
  });

  it("throws on rate limit", async () => {
    const fake = fakeFetch(403, { message: "rate limit exceeded" });
    const source = createReleaseSource({ repo: REPO, fetch: fake.fetch });
    await expect(source.latest("stable")).rejects.toThrow("GitHub antwortet 403");
    await expect(source.latest("staging")).rejects.toThrow("GitHub antwortet 403");
  });

  it("throws a readable error when GitHub is unreachable", async () => {
    const source = createReleaseSource({
      repo: REPO,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(source.latest("stable")).rejects.toThrow("GitHub nicht erreichbar");
  });

  it("throws when the staging answer is not a list", async () => {
    const fake = fakeFetch(200, { message: "huh" });
    await expect(createReleaseSource({ repo: REPO, fetch: fake.fetch }).latest("staging")).rejects.toThrow(
      "Unerwartete Antwort von GitHub",
    );
  });
});
