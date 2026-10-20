// Checks the GitHub build-provenance attestation (Sigstore) of a pulled image
// before the updater replaces anything: the image digest must be signed by
// the release workflow of the source repository for exactly that tag.
// Fail-closed: every doubt is a ProvenanceError with a German reason.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleFromJSON, type Bundle } from "@sigstore/bundle";
import type { TrustedRoot } from "@sigstore/protobuf-specs";
import { getTrustedRoot } from "@sigstore/tuf";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";
import { snappyUncompress } from "./snappy.ts";

const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
const PAYLOAD_TYPE = "application/vnd.in-toto+json";
const SOURCE_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "tanss-agent-portal-updater",
};
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 1_000_000;
const MAX_ATTESTATIONS = 10;

export class ProvenanceError extends Error {}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text || "unbekannter Fehler";
}

/** The certificate identity of the release workflow run for tag v<version>. */
export function releaseIdentity(source: string, version: string): string {
  if (!SOURCE_PATTERN.test(source)) throw new ProvenanceError(`PORTAL_SOURCE ungültig: ${source}`);
  return `https://github.com/${source}/.github/workflows/release.yml@refs/tags/v${version}`;
}

/** Verifies one Sigstore bundle (JSON form) against identity and image digest. */
export function verifyBundle(
  json: unknown,
  opts: { identity: string; digest: string; trustedRoot: TrustedRoot },
): void {
  let bundle: Bundle;
  try {
    bundle = bundleFromJSON(json);
  } catch {
    throw new ProvenanceError("Nachweis hat unerwartetes Format");
  }
  if (bundle.content.$case !== "dsseEnvelope" || bundle.content.dsseEnvelope.payloadType !== PAYLOAD_TYPE) {
    throw new ProvenanceError("Nachweis hat unerwartetes Format");
  }

  let signer: string | undefined;
  try {
    const verifier = new Verifier(toTrustMaterial(opts.trustedRoot), { tlogThreshold: 1, ctlogThreshold: 1 });
    // The identity is compared here, not via the policy: the verifier treats a
    // string subjectAlternativeName as an unanchored regular expression.
    signer = verifier.verify(toSignedEntity(bundle), { extensions: { issuer: OIDC_ISSUER } }).identity
      ?.subjectAlternativeName;
  } catch (err) {
    throw new ProvenanceError(`Signatur nicht bestätigt: ${errorText(err)}`);
  }
  if (signer !== opts.identity) {
    throw new ProvenanceError(`Signatur nicht bestätigt: signiert von ${signer ?? "unbekannt"} statt ${opts.identity}`);
  }

  let statement: unknown;
  try {
    statement = JSON.parse(bundle.content.dsseEnvelope.payload.toString("utf8"));
  } catch {
    throw new ProvenanceError("Nachweis hat unerwartetes Format");
  }
  const s = statement !== null && typeof statement === "object" ? (statement as Record<string, unknown>) : {};
  if (s._type !== STATEMENT_TYPE || s.predicateType !== PREDICATE_TYPE) {
    throw new ProvenanceError("Nachweis ist keine Build-Provenance");
  }
  const hex = opts.digest.slice("sha256:".length);
  const subjects = Array.isArray(s.subject) ? (s.subject as unknown[]) : [];
  const matches = subjects.some((subject) => {
    const digest = subject !== null && typeof subject === "object" ? (subject as { digest?: unknown }).digest : null;
    return digest !== null && typeof digest === "object" && (digest as { sha256?: unknown }).sha256 === hex;
  });
  if (!matches) throw new ProvenanceError("Nachweis gehört zu einem anderen Image");
}

export interface ProvenanceDeps {
  fetch: typeof fetch;
  trustedRoot(): Promise<TrustedRoot>;
}

/** Reads a response body, but never more than MAX_BYTES. */
async function readCapped(res: Response, tooLarge: string): Promise<Buffer> {
  if (Number(res.headers.get("content-length")) > MAX_BYTES) {
    await res.body?.cancel();
    throw new ProvenanceError(tooLarge);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new ProvenanceError(tooLarge);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function get(deps: ProvenanceDeps, url: string): Promise<Response> {
  return deps.fetch(url, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/** The attestation list of the digest; empty if GitHub has none. */
async function fetchAttestations(deps: ProvenanceDeps, source: string, digest: string): Promise<unknown[]> {
  let body: Buffer;
  try {
    const res = await get(deps, `https://api.github.com/repos/${source}/attestations/${digest}`);
    if (res.status === 404) {
      await res.body?.cancel();
      return [];
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new ProvenanceError(`GitHub antwortet mit HTTP ${res.status}`);
    }
    body = await readCapped(res, "Antwort von GitHub zu groß");
  } catch (err) {
    if (err instanceof ProvenanceError) throw err;
    throw new ProvenanceError(`GitHub nicht erreichbar: ${errorText(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ProvenanceError("Antwort von GitHub hat unerwartetes Format");
  }
  const list =
    parsed !== null && typeof parsed === "object" ? (parsed as { attestations?: unknown }).attestations : null;
  return Array.isArray(list) ? list : [];
}

/** The bundle of one attestation: inline, or downloaded (JSON or Snappy) from bundle_url. */
async function loadBundle(deps: ProvenanceDeps, attestation: unknown): Promise<unknown> {
  const a = attestation !== null && typeof attestation === "object" ? (attestation as Record<string, unknown>) : {};
  if (a.bundle !== null && typeof a.bundle === "object") return a.bundle;
  if (typeof a.bundle_url !== "string") throw new ProvenanceError("Nachweis hat unerwartetes Format");

  let bytes: Buffer;
  try {
    const res = await get(deps, a.bundle_url);
    if (!res.ok) {
      await res.body?.cancel();
      throw new ProvenanceError(`Nachweis nicht ladbar: HTTP ${res.status}`);
    }
    bytes = await readCapped(res, "Nachweis zu groß");
  } catch (err) {
    if (err instanceof ProvenanceError) throw err;
    throw new ProvenanceError(`Nachweis nicht ladbar: ${errorText(err)}`);
  }
  try {
    const text = bytes.toString("utf8");
    if (text.trimStart().startsWith("{")) return JSON.parse(text);
    return JSON.parse(snappyUncompress(bytes, MAX_BYTES).toString("utf8"));
  } catch (err) {
    throw new ProvenanceError(`Nachweis hat unerwartetes Format: ${errorText(err)}`);
  }
}

/**
 * Throws a ProvenanceError unless GitHub holds a valid build-provenance
 * attestation for the digest, signed by the release workflow of the version.
 * `identity` replaces the release identity in tests only.
 */
export async function verifyImage(
  deps: ProvenanceDeps,
  opts: { source: string; version: string; digest: string; identity?: string },
): Promise<void> {
  if (!DIGEST_PATTERN.test(opts.digest)) throw new ProvenanceError(`Image ohne gültigen Digest: ${opts.digest}`);
  // Also checks the source, which goes into the API URL.
  const release = releaseIdentity(opts.source, opts.version);
  const identity = opts.identity ?? release;

  const attestations = await fetchAttestations(deps, opts.source, opts.digest);
  if (attestations.length === 0) throw new ProvenanceError("kein Herkunftsnachweis bei GitHub gefunden");

  let trustedRoot: TrustedRoot;
  try {
    trustedRoot = await deps.trustedRoot();
  } catch (err) {
    throw new ProvenanceError(`Sigstore nicht erreichbar: ${errorText(err)}`);
  }

  let reason = "";
  for (const attestation of attestations.slice(0, MAX_ATTESTATIONS)) {
    try {
      verifyBundle(await loadBundle(deps, attestation), { identity, digest: opts.digest, trustedRoot });
      return;
    } catch (err) {
      reason = errorText(err);
    }
  }
  throw new ProvenanceError(`kein gültiger Nachweis: ${reason}`);
}

/** Production wiring: the real GitHub API and the Sigstore public-good trust root via TUF. */
export function createImageVerifier(opts: { source: string }): (digest: string, version: string) => Promise<void> {
  const deps: ProvenanceDeps = {
    fetch: (input, init) => fetch(input, init),
    trustedRoot: () => getTrustedRoot({ cachePath: join(tmpdir(), "sigstore-tuf") }),
  };
  return (digest, version) => verifyImage(deps, { source: opts.source, version, digest });
}
