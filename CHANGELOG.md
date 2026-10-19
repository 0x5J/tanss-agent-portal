# Changelog

Alle nennenswerten Änderungen an diesem Projekt. Aufbau nach
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionsnummern nach
[Semantic Versioning](https://semver.org/lang/de/).

## [Unveröffentlicht]

## [0.2.0] – 2026-10-19

### Hinzugefügt

- Update-Prüfung mit Banner: Das Portal fragt GitHub nach neuen Releases
  (`UPDATE_CHECK=0` schaltet das ab) und zeigt in den Einstellungen den Stand.
- Ein-Klick-Update über einen eigenen Updater-Container, der das neue Image
  zieht, den Portal-Container ersetzt und bei einem Fehler zurückrollt.
- Staging-Kanal (`UPDATE_CHANNEL=staging`, `PORTAL_TAG=staging`) für Tests vor
  der Freigabe.
- Fertige Images für beide Dienste (Portal und Updater) auf `ghcr.io`;
  `compose.build.yaml` baut sie für die Entwicklung lokal.
- Installation ohne Git und Node.js: ein Ordner mit `compose.yaml` und `.env`.

### Geändert

- `compose.yaml` nutzt die fertigen Images statt lokal zu bauen und vergibt
  keinen festen Containernamen mehr; Port und Tag sind über `HOST_PORT` und
  `PORTAL_TAG` einstellbar. Umstieg siehe README.
- Neue Versionen erscheinen zuerst als Pre-Release; `latest` wird erst bei der
  Freigabe gesetzt.

### Sicherheit

- Der Updater ist der einzige Dienst mit Docker-Zugriff; das Portal reicht nur
  eine Versionsnummer weiter.
- Der Dateiaustausch zwischen Portal und Updater ist gegen Symlinks gehärtet.
- Die Workflows binden alle GitHub Actions per Commit-Hash ein; Dependabot
  hält sie aktuell.
- Abhängigkeiten aktualisiert, die bekannte Lücken hatten: `fastify` 5.12.7
  (u. a. Umgehung der Authentifizierung und der Validierung), `fast-uri`,
  `ip-address` und `brace-expansion` im Server sowie `shell-quote`,
  `source-map-js` in den Entwicklungswerkzeugen. `npm audit` meldet keine
  Lücken mehr.

## [0.1.0] – 2026-10-19

Erste öffentliche Version.

### Hinzugefügt

- Tickets: eigene und gespeicherte Listen, Spaltenfilter, Alter und
  Inaktivität, Sammelaktionen, Ticket-Drawer mit Verlauf und Eigenschaften.
- Zeiten: Tagesleiste mit Lücken, Buchen, Bausteine, wiederkehrende Arbeit,
  Tagesimport aus Linear, Auswertung über frei wählbare Zeiträume.
- Dashboard mit serverseitigem Sammler auf der geteilten TANSS-Sitzung,
  Tagesberichte als Archiv.
- KI-Agent gegen einen lokalen, OpenAI-kompatiblen Endpoint: Briefing, Muster,
  Zusammenfassung, Entwürfe, nächster Schritt, ähnliche Tickets, Kunde prüfen,
  Tagesassistent und Chat mit lesenden Werkzeugen. Schreibt nie selbst nach
  TANSS.
- Versionsanzeige in den Einstellungen; `/health` meldet die laufende Version.
- Release-Prozess: Tags `vX.Y.Z` erzeugen ein GitHub-Release und ein
  Container-Image auf `ghcr.io/0x5j/tanss-agent-portal` (amd64 und arm64).

### Sicherheit

- Der gespeicherte LLM-API-Key geht nur noch an den gespeicherten Endpoint.
- Abmelden macht alle Cookies des Kontos serverseitig ungültig, auch Kopien.

[Unveröffentlicht]: https://github.com/0x5J/tanss-agent-portal/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/0x5J/tanss-agent-portal/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/0x5J/tanss-agent-portal/releases/tag/v0.1.0
