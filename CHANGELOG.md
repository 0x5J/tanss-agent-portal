# Changelog

Alle nennenswerten Änderungen an diesem Projekt. Aufbau nach
[Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionsnummern nach
[Semantic Versioning](https://semver.org/lang/de/).

## [Unveröffentlicht]

## [0.4.4] – 2026-10-20

### Behoben

- Lange Texte, vor allem vom Agenten, bleiben lesbar:
  - Textfelder wachsen mit ihrem Inhalt bis zur halben Fensterhöhe und
    scrollen dann, mit einem sichtbaren Scrollbalken auch auf dem Mac.
  - Lange Wörter und URLs brechen in Chat, Zusammenfassungen, Briefings und
    Vorschlägen um, statt aus ihrem Kasten zu laufen.
  - Hinweise am unteren Rand scrollen bei langen Fehlermeldungen und bleiben
    länger stehen.
  - Der Dialog für einen gemeinsamen Kommentar scrollt, statt seine Buttons
    unter den Bildschirmrand zu schieben.
  - „Nächster Schritt“ und die Vorschläge in „Zeiten“ behalten die
    Zeilenumbrüche des Agenten; ein gekürzter Firmenname zeigt den vollen Namen
    beim Darüberfahren.

## [0.4.3] – 2026-10-20

### Hinzugefügt

- Webhooks: Anmeldung beim Empfänger wählbar — Signatur (wie bisher),
  Bearer-Token (`Authorization: Bearer …`) oder ein eigener Header wie
  `X-Api-Key`. Vom gespeicherten Wert zeigt das Portal Anfang, Ende und Länge.
- Jeder Webhook-Aufruf steht im Log: Ziel, gesendete Header (Token gekürzt),
  Inhalt, Statuscode, Dauer und die Antwort des Empfängers. Jeder Techniker
  sieht dort nur die Aufrufe seiner eigenen Webhooks.

### Geändert

- Fehlermeldungen von Webhooks nennen den Anfang der Antwort, etwa
  `HTTP 401: {"error":"invalid token"}` statt nur `HTTP 401`.
- Token und Geheimnisse dürfen bis zu 2000 Zeichen lang sein; Leerzeichen und
  Zeilenumbrüche am Anfang und Ende werden beim Speichern entfernt. Ein Wert
  aus nichts als Leerzeichen wird abgelehnt, statt das gespeicherte zu löschen.

### Behoben

- Ein Klick auf eine Auswahl-Leiste in einem Formular hat das Formular
  abgeschickt.

## [0.4.2] – 2026-10-20

### Hinzugefügt

- Webhooks bei Statuswechsel: In den Einstellungen („Webhooks") legst du Ziel,
  Vorlage und optional ein Geheimnis an, im Ticket hängst du sie an (auf Wunsch
  „einmalig"). Ändert sich der Status, ruft das Portal die URL auf – mit Anlass,
  signiert, mit Wiederholungen und einem Protokoll samt „Erneut senden".

## [0.4.1] – 2026-10-20

### Hinzugefügt

- Startseite „Heute“ (`G H`): Begrüßung, Agent-Briefing über die eigenen
  Tickets, die eigenen offenen Tickets nach Dringlichkeit, „Fällig heute“ und
  die gebuchten Stunden der Woche.
- Zeiten: Ziehen im Zeitstrahl wählt eine Spanne und öffnet das
  Buchungsformular als Karte daneben. Daneben „Vom Agenten vorgeschlagen“ mit
  den Vorschlägen des Tagesassistenten als Karten.
- Tickets: Spaltenauswahl „Spalten“; die Auswahl bleibt im Browser.
- Auswertung: „CSV exportieren“ für die angezeigten Buchungen.

### Geändert

- Alle Ansichten folgen jetzt dem Aufbau des Redesign-Entwurfs, nicht nur
  seinen Farben: große Seitenüberschrift mit Aktionen, Listen und Modi als
  Pillen-Leisten, Agent-Hinweise mit schwarzem Funken, Tabellen mit kräftiger
  Kopflinie, Kacheln, Ring- und Balkendiagramme in Graustufen.
- Ticketansicht: Kopf mit Status- und Fälligkeits-Pillen, Reiter mit
  Unterstrich, Karte „Einschätzung des Agenten“, Eigenschaften rechts.
- Einstellungen in Reitern: Allgemein, Verbindungen, Lokale KI, Agent,
  Texte & Bausteine. Verbindungen lassen sich testen.
- Tagesimport als Ablauf in drei Schritten.

## [0.4.0] – 2026-10-20

### Entfernt

- Die Seite „Freigaben“ samt Menüpunkt, Kürzel `G F` und Zähler, dazu der
  Button „Spuren“ an den Lücken in „Zeiten“, der seine Buchungsvorschläge nur
  dorthin legte. Eine vorhandene `data/proposals.json` wird nicht mehr gelesen
  und kann gelöscht werden.

### Geändert

- Neues Erscheinungsbild nach dem Redesign-Entwurf
  (`docs/design/Agent-Portal-Redesign.dc.html`): Schwarz-Weiß mit Schwarz als
  einziger Aktionsfarbe, Pillen-Buttons, weiche Karten, Inter als einzige
  Schrift. Hell ist jetzt der Standard; wer bisher dunkel hatte, behält das,
  bis er umschaltet.
- Navigation in Gruppen (Arbeit, Analyse, System). Unten stehen TANSS-, KI- und
  Versionsstatus, der angemeldete Techniker sowie die Buttons für
  Erscheinungsbild und Abmelden. Die Kürzel stehen jetzt im Tooltip.
- Kopfzeile mit Pfad, Suche und einem Button „Agent“, der die Agent-Leiste ein-
  und ausblendet. Die schmale Leiste am rechten Rand fällt dafür weg.
- Agent-Leiste als Chat mit Sprechblasen, Vorschlägen als Pillen und einem
  Eingabefeld mit Senden-Button.
- Anmeldeseite zweigeteilt: links eine schwarze Fläche, rechts das Formular.
- Installationsanleitung neu geschrieben: welche zwei Dateien es braucht, wie
  die `.env` ausgefüllt wird, wie man startet und prüft.
- Die `.env`-Vorlage (`env.example`) beginnt mit den beiden Pflichtwerten;
  `PORT` und `BIND` sind auskommentiert, weil sie unter Docker nicht wirken.

## [0.3.0] – 2026-10-19

### Hinzugefügt

- Versionszeile unten in der Navigation: zeigt die laufende Version oder ein
  ausstehendes, laufendes oder fehlgeschlagenes Update. Steht ein Update
  aus, startet ein Klick es nach derselben Rückfrage wie im Banner; sonst
  öffnet er die Einstellungen.

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

[Unveröffentlicht]: https://github.com/0x5J/tanss-agent-portal/compare/v0.4.4...HEAD
[0.4.4]: https://github.com/0x5J/tanss-agent-portal/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/0x5J/tanss-agent-portal/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/0x5J/tanss-agent-portal/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/0x5J/tanss-agent-portal/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/0x5J/tanss-agent-portal/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/0x5J/tanss-agent-portal/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/0x5J/tanss-agent-portal/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/0x5J/tanss-agent-portal/releases/tag/v0.1.0
