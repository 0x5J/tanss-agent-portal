# Image Provenance Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The updater only installs portal images whose GitHub build-provenance attestation proves they came from this repo's `release.yml` on the matching `v<version>` tag.

**Architecture:** The release workflow attests both image index digests with `actions/attest`. The updater gets an injected `verifyImage(digest, version)` step between pull and stopping the old container; `updater/provenance.ts` fetches the attestations from the GitHub API, decodes the Sigstore bundle (own Snappy decoder in `updater/snappy.ts`) and verifies it with `@sigstore/verify` against the TUF-distributed Sigstore trust root. Any failure is fail-closed: the pulled image is removed and the update ends `failed` before anything is touched.

**Tech Stack:** Node 22 (type stripping, no build step for the updater), TypeScript `nodenext`, vitest, `@sigstore/verify` 4.1.2, `@sigstore/bundle` 5.0.0, `@sigstore/tuf` 5.0.0, `@sigstore/protobuf-specs` 0.5.2, GitHub Actions `actions/attest` v4.2.2.

**Spec:** `docs/superpowers/specs/2026-10-20-image-provenance-design.md`

## Global Constraints

- Public repo: no internal company names/URLs, no mention of any specific webhook receiver. Copy shown to users is German; code comments English, matching the surrounding files.
- The portal (root `package.json`) gets no new dependency. Only `updater/package.json` has dependencies, all pinned exactly (`--save-exact`), installed with `--ignore-scripts`.
- `updater/package.json` must contain `"type": "module"` — without it `nodenext` and Node treat `updater/*.ts` as CommonJS.
- Default source repo: `0x5J/tanss-agent-portal` (exact case). Env override `PORTAL_SOURCE`, must match `/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/`.
- Identity: `https://github.com/<source>/.github/workflows/release.yml@refs/tags/v<version>`; issuer `https://token.actions.githubusercontent.com`; predicate type `https://slsa.dev/provenance/v1`; statement type `https://in-toto.io/Statement/v1`; payload type `application/vnd.in-toto+json`.
- GitHub request headers: `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: tanss-agent-portal-updater`. No token.
- Limits: 20 s timeout per HTTP request, 1 000 000 bytes max per response body and per decompressed bundle, at most the first 10 attestations tried.
- Fail-closed; no switch to disable the check.
- Action pin: `actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2`.
- `npm run check` must stay green; it needs `npm ci --prefix updater` first (CI, release, README dev setup).

## Review Focus

- **Several attestations for one digest, the first not ours** (GitHub adds its own release attestation with identity `https://dotcom.releases.github.com`): must still pass if any one is valid → test in Task 2 "passes when the first attestation is foreign and the second valid".
- **`bundle` null with only `bundle_url`, body Snappy-compressed** (the real API shape today) → Task 2 test "loads a snappy bundle from bundle_url".
- **Malformed/hostile compressed data** (offset 0, offset past output, declared length over the limit, truncated input) must throw, never loop or allocate unbounded → Task 1 tests.
- **Rejected image stays tagged locally as `<repo>:<version>`** and could be started later by a pinned `PORTAL_TAG` → Task 4 test "removes the pulled image when the provenance check fails".
- **Pull stream without a `Digest:` line and several `RepoDigests` for the repo** must not guess → Task 4 test "fails without a unique digest".

---

### Task 1: Snappy block decoder

**Files:**
- Create: `updater/snappy.ts`
- Create: `updater/fixtures/gh-cli-provenance.json.sn`, `updater/fixtures/gh-cli-provenance.json` (fetched in Step 1)
- Test: `updater/snappy.test.ts`

**Interfaces:**
- Produces: `export function snappyUncompress(input: Uint8Array, maxLength: number): Buffer` — raw Snappy block format (varint length, then literal/copy-1/copy-2/copy-4 elements). Throws `Error` with German message on malformed input, declared length > `maxLength`, or output length ≠ declared length.

- [ ] **Step 1: Fetch the real fixture** (public attestation of the `gh` CLI 2.102.0 linux_amd64 tarball; the second attestation is the build provenance)

```bash
D=sha256:bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
mkdir -p updater/fixtures
url=$(curl -s https://api.github.com/repos/cli/cli/attestations/$D | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).attestations[1].bundle_url))')
curl -s -o updater/fixtures/gh-cli-provenance.json.sn "$url"
```
Then write the decompressed JSON once (any snappy tool, or after Step 3 with the new decoder) to `updater/fixtures/gh-cli-provenance.json`, pretty-printed is fine. Check that its certificate SAN is `https://github.com/cli/cli/.github/workflows/deployment.yml@refs/heads/trunk`.

- [ ] **Step 2: Write the failing tests** in `updater/snappy.test.ts`

```ts
it("decodes literals", () => expect(snappyUncompress(Uint8Array.from([0x05, 0x10, ...Buffer.from("hello")]), 100).toString()).toBe("hello"));
it("decodes an overlapping copy", () => expect(snappyUncompress(Uint8Array.from([0x08, 0x04, 0x61, 0x62, 0x09, 0x02]), 100).toString()).toBe("abababab"));
it("decodes the real attestation bundle", () => {
  const out = snappyUncompress(readFileSync(sn), 1_000_000);
  expect(JSON.parse(out.toString())).toEqual(JSON.parse(readFileSync(json, "utf8")));
});
it("rejects a declared length over the limit", () => expect(() => snappyUncompress(Uint8Array.from([0x05, 0x10, ...Buffer.from("hello")]), 4)).toThrow(/zu groß/));
it("rejects offset 0", () => expect(() => snappyUncompress(Uint8Array.from([0x08, 0x04, 0x61, 0x62, 0x09, 0x00]), 100)).toThrow());
it("rejects an offset before the start", () => expect(() => snappyUncompress(Uint8Array.from([0x08, 0x04, 0x61, 0x62, 0x09, 0x05]), 100)).toThrow());
it("rejects truncated input", () => expect(() => snappyUncompress(Uint8Array.from([0x05, 0x10, 0x68, 0x65]), 100)).toThrow());
it("rejects output shorter than declared", () => expect(() => snappyUncompress(Uint8Array.from([0x06, 0x10, ...Buffer.from("hello")]), 100)).toThrow());
it("rejects an empty input", () => expect(() => snappyUncompress(new Uint8Array(), 100)).toThrow());
```

- [ ] **Step 3: Run `npx vitest run updater/snappy.test.ts`** — FAIL (module missing).
- [ ] **Step 4: Implement `snappyUncompress`** — preallocate `Buffer.alloc(declared)` only after the limit check; copies byte-by-byte so overlapping copies work; messages e.g. „Snappy-Daten zu groß“, „Snappy-Daten beschädigt“.
- [ ] **Step 5: Run the tests** — PASS.
- [ ] **Step 6: Commit** `git add updater/snappy.ts updater/snappy.test.ts updater/fixtures && git commit -m "Updater: Snappy-Dekoder für Sigstore-Bundles"`

---

### Task 2: Provenance verification module + updater dependencies

**Files:**
- Create: `updater/package.json`, `updater/package-lock.json`
- Create: `updater/provenance.ts`
- Create: `updater/fixtures/sigstore-trusted-root.json`
- Test: `updater/provenance.test.ts`
- Modify: `updater/Dockerfile`, `.dockerignore`, `.github/workflows/ci.yml`, `.github/workflows/release.yml` (only the `npm ci --prefix updater` step before `npm run check`), `.github/dependabot.yml`, `README.md:493` (dev setup)

**Interfaces:**
- Consumes: `snappyUncompress` (Task 1).
- Produces (all in `updater/provenance.ts`):
  - `export class ProvenanceError extends Error {}`
  - `export function releaseIdentity(source: string, version: string): string` — throws `ProvenanceError("PORTAL_SOURCE ungültig: <source>")` on a bad source.
  - `export function verifyBundle(json: unknown, opts: { identity: string; digest: string; trustedRoot: TrustedRoot }): void` — throws `ProvenanceError`. `TrustedRoot` from `@sigstore/protobuf-specs`.
  - `export interface ProvenanceDeps { fetch: typeof fetch; trustedRoot(): Promise<TrustedRoot> }`
  - `export async function verifyImage(deps: ProvenanceDeps, opts: { source: string; version: string; digest: string; identity?: string }): Promise<void>` — throws `ProvenanceError` with the German reason; `identity` is a test seam only.
  - `export function createImageVerifier(opts: { source: string }): (digest: string, version: string) => Promise<void>` — production wiring: global `fetch`, `getTrustedRoot({ cachePath: join(tmpdir(), "sigstore-tuf") })` from `@sigstore/tuf`.

- [ ] **Step 1: Set up the package**

```bash
cd updater && npm init -y >/dev/null
npm install --save-exact --ignore-scripts @sigstore/verify@4.1.2 @sigstore/bundle@5.0.0 @sigstore/tuf@5.0.0 @sigstore/protobuf-specs@0.5.2
```
Edit `updater/package.json` to: `"name": "tanss-agent-portal-updater"`, `"private": true`, `"type": "module"`, the four `dependencies`; drop `main`, `scripts`, `keywords`, `author`, `license`, `description`, `version`.

- [ ] **Step 2: Fetch the trust root fixture**

```bash
cd updater && node --input-type=module -e 'import {getTrustedRoot} from "@sigstore/tuf"; import {TrustedRoot} from "@sigstore/protobuf-specs"; import {writeFileSync} from "node:fs"; const r = await getTrustedRoot({cachePath: "/tmp/sigstore-tuf-fixture"}); writeFileSync("fixtures/sigstore-trusted-root.json", JSON.stringify(TrustedRoot.toJSON(r), null, 2) + "\n");'
```
The goal is the JSON form of the current public-good trust root; `TrustedRoot.fromJSON` of this file must give back a root that verifies the Task 1 fixture.

- [ ] **Step 3: Write the failing tests** in `updater/provenance.test.ts`. Constants:
`CLI_IDENTITY = "https://github.com/cli/cli/.github/workflows/deployment.yml@refs/heads/trunk"`, `CLI_DIGEST = "sha256:bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386"`, `ROOT = TrustedRoot.fromJSON(fixture)`.

`releaseIdentity`:
- `releaseIdentity("0x5J/tanss-agent-portal", "0.5.0")` → `"https://github.com/0x5J/tanss-agent-portal/.github/workflows/release.yml@refs/tags/v0.5.0"`
- `releaseIdentity("evil/repo/x", "0.5.0")` throws `/PORTAL_SOURCE ungültig/`

`verifyBundle` (offline, real fixture):
- accepts the fixture with `CLI_IDENTITY`, `CLI_DIGEST`
- other identity (`…/evil.yml@refs/heads/trunk`) → throws `/Signatur nicht bestätigt/`
- other digest (`"sha256:" + "0".repeat(64)`) → throws `/anderen Image/`
- payload with a changed subject digest (re-encode `dsseEnvelope.payload`) → throws `/Signatur nicht bestätigt/`
- `{ foo: 1 }` → throws `/unerwartetes Format/`
- statement with `predicateType` changed is covered by the signature, so no separate test.

`verifyImage` (fake `fetch` returning `Response`s, fake `trustedRoot` returning `ROOT`, `source: "cli/cli"`, `digest: CLI_DIGEST`; the fixture is not from a `release.yml` tag build, so the tests pass `identity: CLI_IDENTITY` — `verifyImage`'s opts get an optional `identity?: string` that replaces `releaseIdentity(source, version)`; production never sets it):
- requests exactly `https://api.github.com/repos/cli/cli/attestations/sha256:bb76…` with the three headers from Global Constraints
- inline `bundle` object → passes
- `bundle: null` + `bundle_url` serving the `.sn` fixture → passes ("loads a snappy bundle from bundle_url")
- `bundle_url` serving uncompressed JSON (first non-whitespace byte `{`) → passes
- first attestation foreign (inline bundle with identity mismatch — reuse fixture with `identity` that only the second matches is not possible, so: first entry `{ bundle: { foo: 1 } }`, second the fixture) → passes ("passes when the first attestation is foreign and the second valid")
- API 404 → `/kein Herkunftsnachweis bei GitHub gefunden/`
- API 200 with `{ attestations: [] }` → same message
- API 500 → `/GitHub antwortet mit HTTP 500/`
- `fetch` rejects → `/GitHub nicht erreichbar/`
- `trustedRoot` rejects → `/Sigstore nicht erreichbar/`
- all attestations invalid → `/kein gültiger Nachweis/` and the message contains the last reason
- digest `"sha256:xyz"` → `/Image ohne gültigen Digest/`, `fetch` never called
- API body over 1 000 000 bytes → throws, does not parse
- only the first 10 of 12 invalid attestations are tried (count bundle_url fetches)

- [ ] **Step 4: Run `npx vitest run updater/provenance.test.ts`** — FAIL.
- [ ] **Step 5: Implement `updater/provenance.ts`**

`verifyBundle`: `bundleFromJSON(json)` (any throw → „Nachweis hat unerwartetes Format“); require `bundle.content.$case === "dsseEnvelope"` and `payloadType` from Global Constraints; `new Verifier(toTrustMaterial(trustedRoot), { tlogThreshold: 1, ctlogThreshold: 1 }).verify(toSignedEntity(bundle), { subjectAlternativeName: identity, extensions: { issuer: OIDC_ISSUER } })` (throw → `Signatur nicht bestätigt: <message>`); then parse the payload as JSON and check `_type`, `predicateType` (→ „Nachweis ist keine Build-Provenance“) and that some `subject[].digest.sha256` equals the hex part of `digest` (→ „Nachweis gehört zu einem anderen Image“).

`verifyImage`: digest must match `/^sha256:[0-9a-f]{64}$/`; fetch the list; read bodies with a streaming reader capped at 1 000 000 bytes (`AbortSignal.timeout(20_000)` on each fetch); get the trust root only after a non-empty list; try up to 10 entries, each: inline `bundle` if it is an object, else fetch `bundle_url` → JSON or `snappyUncompress(bytes, 1_000_000)`; return on the first `verifyBundle` success; otherwise throw `kein gültiger Nachweis: <last reason>`.

- [ ] **Step 6: Run the tests** — PASS. Run `npm run check` — PASS (tsc sees the types from `updater/node_modules`).
- [ ] **Step 7: Wire install and build**
  - `.github/workflows/ci.yml` and `release.yml`: step `- run: npm ci --prefix updater` right after `- run: npm ci`.
  - `updater/Dockerfile`: a `deps` stage `FROM node:22-alpine AS deps`, `WORKDIR /app/updater`, copy `updater/package.json updater/package-lock.json`, `RUN npm ci --omit=dev --ignore-scripts`; the final stage additionally copies `updater/package.json` and `--from=deps /app/updater/node_modules` to `updater/node_modules`. Update the header comment ("No npm dependencies" no longer true: only the Sigstore verification packages).
  - `.dockerignore`: add `**/node_modules`.
  - `.github/dependabot.yml`: add `package-ecosystem: npm`, `directory: /updater`, monthly, grouped `sigstore` (`@sigstore/*`). Update its header comment.
  - `README.md` dev setup (line ~493): `npm install` → also `npm install --prefix updater`.
- [ ] **Step 8: Smoke-test the image**

```bash
docker build -f updater/Dockerfile -t updater-smoke . && \
docker run --rm --entrypoint node updater-smoke -e 'import("/app/updater/provenance.ts").then(m => console.log(Object.keys(m).sort().join(",")))'
```
Expected: `ProvenanceError,createImageVerifier,releaseIdentity,verifyBundle,verifyImage`. Then `docker image rm updater-smoke`.
- [ ] **Step 9: Commit** `git add updater .dockerignore .github README.md && git commit -m "Updater: Herkunftsnachweis per Sigstore prüfen"`

---

### Task 3: Docker API — pull digest, RepoDigests, removeImage

**Files:**
- Modify: `updater/docker.ts`
- Test: `updater/docker.test.ts`

**Interfaces:**
- Produces:
  - `pullImage(repo: string, tag: string): Promise<string | null>` — the `sha256:<64 hex>` from a stream line `{"status":"Digest: sha256:…"}`, else `null`. Stream errors still throw as before.
  - `ImageInfo.RepoDigests?: string[]`
  - `removeImage(ref: string): Promise<void>` — `DELETE /images/{ref}` (no force).
  - Update the file's header comment (the updater image now has npm dependencies, this client still uses only built-ins).

- [ ] **Step 1: Failing tests** in the existing style of `docker.test.ts` (fake socket server):
  - "returns the digest from the pull stream": stream `{"status":"Pulling from x"}\n{"status":"Digest: sha256:<64×a>"}\n{"status":"Status: Downloaded newer image"}` → resolves `"sha256:" + "a".repeat(64)`
  - "returns null when the pull stream names no digest"
  - "removes an image": `DELETE /v1.48/images/ghcr.io%2Fx%3A1.0.0`, resolves
  - "throws when removing an image fails" (409) → `DockerError` with status 409
- [ ] **Step 2: Run `npx vitest run updater/docker.test.ts`** — FAIL.
- [ ] **Step 3: Implement.** Update the `DockerApi` interface and the fake in `updater/update.test.ts` (`pullImage` returns `NEW_DIGEST`, new `removeImage` records the call) so `npm run check` compiles.
- [ ] **Step 4: Run `npm run check`** — PASS.
- [ ] **Step 5: Commit** `git commit -am "Updater: Digest beim Pull, Image entfernen"`

---

### Task 4: Check provenance in `runUpdate` and wire it in `main.ts`

**Files:**
- Modify: `updater/update.ts` (`UpdateDeps`, `runUpdate` between pull and `createSpec`)
- Modify: `updater/main.ts` (`PORTAL_SOURCE`, `createImageVerifier`, ready log line)
- Test: `updater/update.test.ts`

**Interfaces:**
- Consumes: `createImageVerifier` (Task 2), `pullImage` digest / `RepoDigests` / `removeImage` (Task 3).
- Produces: `UpdateDeps.verifyImage(digest: string, version: string): Promise<void>` (required).

- [ ] **Step 1: Failing tests** in `describe("runUpdate")` (default test deps get `verifyImage: async () => {}`; `NEW_DIGEST = "sha256:" + "b".repeat(64)`):
  - "checks the provenance of the pulled digest before stopping anything": `verifyImage` called with `(NEW_DIGEST, "0.2.0")`; it is called after `pullImage` and before `stopContainer`; a status `{ state: "pulling", message: "Herkunft wird geprüft" }` was reported.
  - "falls back to RepoDigests without a digest in the pull stream": `pullImage` → `null`, image `RepoDigests: ["other/repo@sha256:…", "${REPO}@${NEW_DIGEST}"]` → verified with `NEW_DIGEST`.
  - "fails without a unique digest": `pullImage` → `null`, two different `RepoDigests` for `REPO` → status `failed`, message contains `Image ohne eindeutigen Digest`, `verifyImage` and `stopContainer` not called.
  - "aborts the update when the provenance check fails": `verifyImage` throws `new Error("kein Herkunftsnachweis bei GitHub gefunden")` → final status `failed` with message exactly `Herkunft von ${REPO}:0.2.0 nicht bestätigt: kein Herkunftsnachweis bei GitHub gefunden — Update abgebrochen`; no `stopContainer`, `renameContainer`, `createContainer`.
  - "removes the pulled image when the provenance check fails": `removeImage` called with `${REPO}:0.2.0`.
  - "stays failed when removing the rejected image fails": `removeImage` throws → status still the message above (unchanged).
- [ ] **Step 2: Run `npx vitest run updater/update.test.ts`** — FAIL.
- [ ] **Step 3: Implement** in `runUpdate` right after `newImage` is inspected: `report("pulling", "Herkunft wird geprüft")`; digest = pull digest, else the single distinct `RepoDigests` entry starting with `${repo}@` (strip the prefix), else return `failed` „Image ohne eindeutigen Digest“; `await deps.verifyImage(digest, version)`, on throw `await docker.removeImage(imageRef).catch(() => {})` and return the failed message above. `main.ts`: `const source = process.env.PORTAL_SOURCE || "0x5J/tanss-agent-portal";`, pass `verifyImage: createImageVerifier({ source })`, ready line `Updater ${version} bereit, Portal-Image ${repo}, Herkunft ${source}`. Update the file header comment of `update.ts` (pull, check provenance, replace, verify).
- [ ] **Step 4: Run `npm run check`** — PASS.
- [ ] **Step 5: Commit** `git commit -am "Updater: Update nur mit bestätigter Herkunft"`

---

### Task 5: Attest in the release workflow, docs, changelog

**Files:**
- Modify: `.github/workflows/release.yml`, `README.md` (Updates section ~150–175, Aufbau ~514, Versionen ~520), `CHANGELOG.md` (Unveröffentlicht)

- [ ] **Step 1: Workflow.** Permissions add `id-token: write`, `attestations: write`, `artifact-metadata: write`. Give the two `build-push-action` steps `id: build` and `id: build-updater`. After each:

```yaml
      - uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2
        with:
          subject-name: ${{ env.IMAGE }}            # env.IMAGE_UPDATER for the second
          subject-digest: ${{ steps.build.outputs.digest }}
          push-to-registry: true
```
Extend the header comment: both images get a signed build-provenance attestation the updater checks.
- [ ] **Step 2: Validate** `npx --yes @action-validator/cli .github/workflows/release.yml` (or `actionlint` if installed) — no errors.
- [ ] **Step 3: README**
  - Updates section, new paragraph after the Updater description: before replacing anything the updater checks that the image was built by this repo's release workflow for exactly this version (GitHub Artifact Attestation, signed via Sigstore). Without a valid proof — or when GitHub/Sigstore cannot be reached — it does not update, removes the image again and shows the reason in the banner. Needs outbound access to `api.github.com`, `tmaproduction.blob.core.windows.net`, `tuf-repo-cdn.sigstore.dev`.
  - New subsection „Herkunft selbst prüfen“: `gh attestation verify oci://ghcr.io/0x5j/tanss-agent-portal:<version> --owner 0x5J` and the same for `-updater`, valid from 0.5.0.
  - Bullet: `PORTAL_SOURCE` (GitHub-Repo `owner/name`, Standard `0x5J/tanss-agent-portal`) only for forks that publish their own images.
  - Aufbau line for `updater/`: „eigener Container für Ein-Klick-Updates (Node-Bordmittel plus Sigstore-Prüfung, Docker-Socket)“.
- [ ] **Step 4: CHANGELOG** under `## [Unveröffentlicht]`:

```markdown
### Hinzugefügt

- Updates prüfen die Herkunft: Jede Version ab 0.5.0 trägt einen signierten
  Nachweis, dass Portal- und Updater-Image aus dem Release-Workflow dieses
  Repos stammen. Der Updater installiert nur Images mit gültigem Nachweis und
  bricht sonst ab, ohne das laufende Portal anzufassen.

### Wichtig beim Update

- Der Updater aktualisiert sich nicht selbst: Für die Prüfung einmal im
  Installationsordner `docker compose pull && docker compose up -d` ausführen.
```
- [ ] **Step 5: `npm run check`** — PASS.
- [ ] **Step 6: Commit** `git add .github README.md CHANGELOG.md && git commit -m "Release: Herkunftsnachweise für beide Images"`

---

## After merge (not part of the subagent tasks)

Release 0.5.0 as pre-release as usual; then `gh attestation verify oci://ghcr.io/0x5j/tanss-agent-portal:0.5.0 --owner 0x5J` and the same for the updater; check that the certificate SAN uses `0x5J` exactly as `releaseIdentity` builds it. Sören updates his container once by hand, then a 0.5.1 pre-release proves a real verified one-click update. Only then `latest`.
