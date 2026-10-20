import { readFileSync } from "node:fs";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { describe, expect, it, vi } from "vitest";
import { type ProvenanceDeps, releaseIdentity, verifyBundle, verifyImage } from "./provenance.ts";

const CLI_IDENTITY = "https://github.com/cli/cli/.github/workflows/deployment.yml@refs/heads/trunk";
const CLI_DIGEST = "sha256:bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386";
const API_URL = `https://api.github.com/repos/cli/cli/attestations/${CLI_DIGEST}`;
const BUNDLE_URL = "https://blob.example/attestation.json.sn";

const ROOT = TrustedRoot.fromJSON(
  JSON.parse(readFileSync(new URL("./fixtures/sigstore-trusted-root.json", import.meta.url), "utf8")),
);
const SNAPPY = readFileSync(new URL("./fixtures/gh-cli-provenance.json.sn", import.meta.url));
const BUNDLE_TEXT = readFileSync(new URL("./fixtures/gh-cli-provenance.json", import.meta.url), "utf8");
const bundle = (): Record<string, unknown> => JSON.parse(BUNDLE_TEXT);

/** The fixture with the subject digest in the signed payload replaced. */
function tamperedBundle(): Record<string, unknown> {
  const b = bundle() as { dsseEnvelope: { payload: string } };
  const statement = JSON.parse(Buffer.from(b.dsseEnvelope.payload, "base64").toString());
  statement.subject[0].digest.sha256 = "0".repeat(64);
  b.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
  return b;
}

describe("releaseIdentity", () => {
  it("builds the release workflow identity of the tag", () => {
    expect(releaseIdentity("0x5J/tanss-agent-portal", "0.5.0")).toBe(
      "https://github.com/0x5J/tanss-agent-portal/.github/workflows/release.yml@refs/tags/v0.5.0",
    );
  });

  it("rejects a malformed source", () => {
    expect(() => releaseIdentity("evil/repo/x", "0.5.0")).toThrow(/PORTAL_SOURCE ungültig/);
  });
});

describe("verifyBundle", () => {
  const opts = { identity: CLI_IDENTITY, digest: CLI_DIGEST, trustedRoot: ROOT };

  it("accepts the real attestation", () => {
    expect(() => verifyBundle(bundle(), opts)).not.toThrow();
  });

  it("rejects another signer identity", () => {
    const identity = "https://github.com/cli/cli/.github/workflows/evil.yml@refs/heads/trunk";
    expect(() => verifyBundle(bundle(), { ...opts, identity })).toThrow(/Signatur nicht bestätigt/);
  });

  it("compares the identity exactly, not as a pattern", () => {
    const prefix = CLI_IDENTITY.slice(0, -"unk".length);
    expect(() => verifyBundle(bundle(), { ...opts, identity: prefix })).toThrow(/Signatur nicht bestätigt/);
    const pattern = CLI_IDENTITY.slice(0, -1) + ".";
    expect(() => verifyBundle(bundle(), { ...opts, identity: pattern })).toThrow(/Signatur nicht bestätigt/);
  });

  it("rejects an attestation for another image", () => {
    expect(() => verifyBundle(bundle(), { ...opts, digest: "sha256:" + "0".repeat(64) })).toThrow(/anderen Image/);
  });

  it("rejects a payload changed after signing", () => {
    expect(() => verifyBundle(tamperedBundle(), opts)).toThrow(/Signatur nicht bestätigt/);
  });

  it("rejects something that is no bundle", () => {
    expect(() => verifyBundle({ foo: 1 }, opts)).toThrow(/unerwartetes Format/);
  });
});

type Route = Response | (() => Response);

/** A fetch that serves the given routes and records every call. */
function fakeFetch(routes: Record<string, Route>) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const route = routes[String(input)];
    if (!route) return new Response("not found", { status: 404 });
    return typeof route === "function" ? route() : route;
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function list(...attestations: unknown[]): () => Response {
  return () => json({ attestations });
}

function deps(fetch: ProvenanceDeps["fetch"], trustedRoot = async () => ROOT): ProvenanceDeps {
  return { fetch, trustedRoot };
}

const imageOpts = { source: "cli/cli", version: "2.0.0", digest: CLI_DIGEST, identity: CLI_IDENTITY };

describe("verifyImage", () => {
  it("asks the GitHub attestation API with the expected headers", async () => {
    const fetch = fakeFetch({ [API_URL]: list({ bundle: bundle() }) });
    await verifyImage(deps(fetch), imageOpts);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(API_URL);
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(headers.get("user-agent")).toBe("tanss-agent-portal-updater");
    expect(headers.get("authorization")).toBeNull();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes with an inline bundle", async () => {
    const fetch = fakeFetch({ [API_URL]: list({ bundle: bundle() }) });
    await expect(verifyImage(deps(fetch), imageOpts)).resolves.toBeUndefined();
  });

  it("loads a snappy bundle from bundle_url", async () => {
    const fetch = fakeFetch({
      [API_URL]: list({ bundle: null, bundle_url: BUNDLE_URL }),
      [BUNDLE_URL]: () => new Response(SNAPPY, { headers: { "content-type": "application/x-snappy" } }),
    });
    await expect(verifyImage(deps(fetch), imageOpts)).resolves.toBeUndefined();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([API_URL, BUNDLE_URL]);
  });

  it("loads an uncompressed bundle from bundle_url", async () => {
    const fetch = fakeFetch({
      [API_URL]: list({ bundle: null, bundle_url: BUNDLE_URL }),
      [BUNDLE_URL]: () => new Response("\n  " + BUNDLE_TEXT),
    });
    await expect(verifyImage(deps(fetch), imageOpts)).resolves.toBeUndefined();
  });

  it("passes when the first attestation is foreign and the second valid", async () => {
    const fetch = fakeFetch({ [API_URL]: list({ bundle: { foo: 1 } }, { bundle: bundle() }) });
    await expect(verifyImage(deps(fetch), imageOpts)).resolves.toBeUndefined();
  });

  it("fails without attestation (404)", async () => {
    const trustedRoot = vi.fn(async () => ROOT);
    const fetch = fakeFetch({ [API_URL]: () => json({ message: "Not Found" }, 404) });
    await expect(verifyImage(deps(fetch, trustedRoot), imageOpts)).rejects.toThrow(
      /kein Herkunftsnachweis bei GitHub gefunden/,
    );
    expect(trustedRoot).not.toHaveBeenCalled();
  });

  it("fails with an empty attestation list", async () => {
    const trustedRoot = vi.fn(async () => ROOT);
    const fetch = fakeFetch({ [API_URL]: list() });
    await expect(verifyImage(deps(fetch, trustedRoot), imageOpts)).rejects.toThrow(
      /kein Herkunftsnachweis bei GitHub gefunden/,
    );
    expect(trustedRoot).not.toHaveBeenCalled();
  });

  it("reports another HTTP status", async () => {
    const fetch = fakeFetch({ [API_URL]: () => new Response("oops", { status: 500 }) });
    await expect(verifyImage(deps(fetch), imageOpts)).rejects.toThrow(/GitHub antwortet mit HTTP 500/);
  });

  it("reports an unreachable GitHub", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(verifyImage(deps(fetch), imageOpts)).rejects.toThrow(/GitHub nicht erreichbar/);
  });

  it("reports an unreachable Sigstore", async () => {
    const fetch = fakeFetch({ [API_URL]: list({ bundle: bundle() }) });
    const trustedRoot = async () => {
      throw new Error("timeout");
    };
    await expect(verifyImage(deps(fetch, trustedRoot), imageOpts)).rejects.toThrow(/Sigstore nicht erreichbar/);
  });

  it("fails when no attestation is valid and names the last reason", async () => {
    const fetch = fakeFetch({ [API_URL]: list({ bundle: tamperedBundle() }, { bundle: { foo: 1 } }) });
    const err = await verifyImage(deps(fetch), imageOpts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/kein gültiger Nachweis/);
    expect((err as Error).message).toMatch(/unerwartetes Format/);
  });

  it("rejects a malformed digest without asking GitHub", async () => {
    const fetch = fakeFetch({});
    await expect(verifyImage(deps(fetch), { ...imageOpts, digest: "sha256:xyz" })).rejects.toThrow(
      /Image ohne gültigen Digest/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an API answer over the size limit without parsing it", async () => {
    const trustedRoot = vi.fn(async () => ROOT);
    const huge = JSON.stringify({ attestations: [{ bundle: bundle() }] }) + " ".repeat(1_000_000);
    const fetch = fakeFetch({ [API_URL]: () => new Response(huge) });
    await expect(verifyImage(deps(fetch, trustedRoot), imageOpts)).rejects.toThrow(/zu groß/);
    expect(trustedRoot).not.toHaveBeenCalled();
  });

  it("tries only the first 10 attestations", async () => {
    const attestations = Array.from({ length: 12 }, (_, i) => ({ bundle: null, bundle_url: `${BUNDLE_URL}?n=${i}` }));
    const routes: Record<string, Route> = { [API_URL]: list(...attestations) };
    for (const a of attestations) routes[a.bundle_url] = () => json({ foo: 1 });
    const fetch = fakeFetch(routes);
    await expect(verifyImage(deps(fetch), imageOpts)).rejects.toThrow(/kein gültiger Nachweis/);
    expect(fetch.mock.calls.filter(([url]) => String(url).startsWith(BUNDLE_URL))).toHaveLength(10);
  });
});
