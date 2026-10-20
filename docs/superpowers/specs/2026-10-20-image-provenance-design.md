# Herkunft der Images prüfen — Design

## Ziel

Der Updater installiert nur Portal-Images, die nachweislich aus dem
Release-Workflow dieses Repos stammen. Ein Image, das an der Pipeline vorbei
nach ghcr.io gelangt (gestohlener Token, manipulierte Registry), wird
abgelehnt, bevor der laufende Container angefasst wird.

## Entscheidungen

- **Nachweis:** GitHub Artifact Attestations (SLSA-Build-Provenance, signiert
  über Sigstore public-good) für beide Images, erzeugt mit `actions/attest` im
  Release-Workflow, Subjekt ist der Digest des Multi-Arch-Index.
  `promote.yml` taggt nur um, der Nachweis gilt damit auch für `latest`/`X.Y`.
- **Prüfung im Updater** zwischen Pull und Stopp des alten Containers:
  1. Digest des gezogenen Index (Pull-Stream „Digest: sha256:…“, sonst
     `RepoDigests`).
  2. Nachweise ohne Anmeldung von
     `GET https://api.github.com/repos/<quelle>/attestations/<digest>` holen;
     Bundle inline oder über `bundle_url` (Snappy-komprimiert).
  3. Bundle mit `@sigstore/verify` gegen die Sigstore-Vertrauensbasis
     (`@sigstore/tuf`) prüfen: Issuer
     `https://token.actions.githubusercontent.com`, Identität genau
     `https://github.com/<quelle>/.github/workflows/release.yml@refs/tags/v<version>`.
  4. Statement: in-toto v1, Prädikat `https://slsa.dev/provenance/v1`, ein
     Subjekt mit genau diesem Digest.
  - Ein gültiger Nachweis reicht; GitHub liefert oft mehrere (z. B. einen
    Release-Nachweis von GitHub selbst), die nicht passen.
- **Fail-closed:** Kein gültiger Nachweis, GitHub oder Sigstore nicht
  erreichbar → kein Update, das gezogene Image wird wieder entfernt, Status
  `failed` mit Grund. Kein Schalter zum Abschalten: der Weg von Hand
  (`docker compose pull && docker compose up -d`) bleibt.
- **Quelle** `PORTAL_SOURCE` (Standard `0x5J/tanss-agent-portal`), für Forks
  mit eigenem `PORTAL_REPO`.
- **Abhängigkeiten:** eigenes `updater/package.json` (`"type": "module"`) mit
  exakt gepinnten `@sigstore/verify`, `@sigstore/bundle`, `@sigstore/tuf`,
  `@sigstore/protobuf-specs`. Snappy-Dekoder selbst geschrieben (kein Paket).
  Das Portal bekommt nichts davon.
- **Tag-Schutz:** Ruleset „Versions-Tags schützen“ (nur Admins legen
  `v*`-Tags an, ändern oder löschen sie) — bereits aktiv.
- **Version:** 0.5.0. Der Updater aktualisiert sich nicht selbst; bestehende
  Installationen brauchen einmal `docker compose pull && docker compose up -d`.
  Nachweise gibt es erst ab 0.5.0; der neue Updater kann also nur auf Versionen
  ab 0.5.0 aktualisieren, was durch „nur vorwärts“ ohnehin gilt.

## Nicht-Ziele

- Schutz vor bösem Code, der regulär über einen Tag gebaut wird (dagegen:
  Tag-Schutz, 2FA, gepinnte Actions).
- Prüfung des Updater-Images selbst durch den Updater (er tauscht sich nicht
  aus); Nutzer können es mit `gh attestation verify` prüfen.
