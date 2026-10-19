# Changelog

Alle nennenswerten Änderungen an diesem Projekt. Aufbau nach
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionsnummern nach
[Semantic Versioning](https://semver.org/lang/de/).

## [Unveröffentlicht]

### Sicherheit

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

[Unveröffentlicht]: https://github.com/0x5J/tanss-agent-portal/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/0x5J/tanss-agent-portal/releases/tag/v0.1.0
