# Agent-Portal für TANSS

Web-Oberfläche für die eigenen Tickets und Leistungen in
[TANSS](https://www.tanss.de/), dem Ticket- und Abrechnungssystem für
IT-Dienstleister — mit einem optionalen KI-Agenten, der gegen ein lokales
Sprachmodell läuft. Ein Container, ein Prozess: Fastify hält die
TANSS-Session serverseitig, das HttpOnly-Cookie trägt nur die Identität, und
die gebaute React-Oberfläche kommt aus demselben Container. Der Browser
spricht nie selbst mit TANSS.

> Inoffizielles Projekt, nicht mit dem Hersteller von TANSS verbunden. Es
> spricht die öffentliche TANSS-REST-API an; die Dokumentation dazu gibt es
> unter [api-doc.tanss.de](https://api-doc.tanss.de/).

## Voraussetzungen

- eine TANSS-Instanz mit freigeschalteter REST-API und ein eigenes Konto
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows,
  macOS) oder Docker mit Compose-Plugin (Linux). Git und Node.js braucht der
  Betrieb nicht.
- optional: ein OpenAI-kompatibler LLM-Endpoint (oMLX, Ollama, LM Studio, vLLM)
  für die KI-Funktionen
- optional: ein persönlicher Linear-API-Key für den Tagesimport

## Installation

Das Portal besteht aus zwei fertigen Images auf `ghcr.io`, die Docker selbst
herunterlädt. Du brauchst nur einen Ordner mit **zwei Dateien**; das Repo
musst du nicht klonen.

| Datei | Woher | Was du damit tust |
| --- | --- | --- |
| `compose.yaml` | Release-Download `compose.yaml` | nichts — sie beschreibt Portal und Updater und wird nicht bearbeitet |
| `.env` | Release-Download `env.example`, gespeichert als `.env` | deine Einstellungen; Pflicht sind nur `TANSS_BASE_URL` und `SESSION_SECRET` |

Dazu kommt der Ordner `data/` für alles, was das Portal speichert (Sitzung,
KI-Einstellungen, Listen, Berichte). Fertig eingerichtet sieht der Ordner so
aus:

```
agent-portal/
├── compose.yaml
├── .env
└── data/
    └── update/      Austausch mit dem Updater, bleibt leer
```

### 1. Ordner anlegen und Dateien laden

macOS und Linux (Terminal):

```bash
mkdir -p agent-portal/data/update
cd agent-portal
curl -fLO https://github.com/0x5J/tanss-agent-portal/releases/latest/download/compose.yaml
curl -fL -o .env https://github.com/0x5J/tanss-agent-portal/releases/latest/download/env.example
chmod 600 .env
```

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force -Path agent-portal\data\update | Out-Null
Set-Location agent-portal
Invoke-WebRequest https://github.com/0x5J/tanss-agent-portal/releases/latest/download/compose.yaml -OutFile compose.yaml
Invoke-WebRequest https://github.com/0x5J/tanss-agent-portal/releases/latest/download/env.example -OutFile .env
```

`releases/latest` ist immer die zuletzt freigegebene Version. Die Vorlage
heißt im Release `env.example` statt `.env`, weil GitHub den Punkt am Anfang
von Dateinamen entfernt — der Befehl oben speichert sie gleich unter dem
richtigen Namen.

### 2. `.env` ausfüllen

Die Datei in einem Texteditor öffnen (Windows: `notepad .env`) und die beiden
Pflichtwerte ganz oben eintragen:

- **`TANSS_BASE_URL`** — die Adresse der TANSS-API, meist die TANSS-Adresse
  mit `/backend` am Ende, z. B. `https://tanss.firma.de/backend`.
- **`SESSION_SECRET`** — eine zufällige Zeichenfolge, mindestens 32 Zeichen.
  Erzeugen lässt sie sich so:

  ```bash
  openssl rand -hex 32
  ```

  ```powershell
  $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })
  ```

Alles andere in der Datei ist auskommentiert (`#`) und optional, siehe
[Einstellungen](#einstellungen-env).

**Nur Linux:** Das Portal läuft im Container als Benutzer mit der uid 1000.
Hat dein Benutzer eine andere (`id -u`), einmal `sudo chown -R 1000:1000 data`
ausführen — sonst kann das Portal nichts speichern, und der Updater lehnt
`data/update` ab.

### 3. Starten

Im Ordner `agent-portal`:

```bash
docker compose up -d
```

Docker lädt beim ersten Start die beiden Images und startet zwei Container:
das **Portal** und den **Updater** (spielt Updates ein, siehe
[Updates](#updates)). Danach ist das Portal unter
**<http://127.0.0.1:3848>** erreichbar, nur von diesem Rechner aus. Angemeldet
wird mit dem eigenen TANSS-Konto.

Nützliche Befehle, jeweils im Ordner `agent-portal`:

| Befehl | Wirkung |
| --- | --- |
| `docker compose ps` | läuft alles? |
| `docker compose logs -f portal` | Ausgaben des Portals (Abbruch mit Strg+C) |
| `docker compose down` | stoppen; `data/` bleibt erhalten |
| `docker compose up -d` | wieder starten |

Startet das Portal nicht, steht der Grund in `docker compose logs portal`,
meist ein fehlender oder zu kurzer Pflichtwert in der `.env`.

## Einstellungen (`.env`)

Alle Einstellungen stehen in der `.env`; nach einer Änderung
`docker compose up -d` ausführen. `compose.yaml` bleibt unverändert.

| Variable | Zweck |
| --- | --- |
| `TANSS_BASE_URL` | **Pflicht.** Basis-URL der TANSS-API (z. B. `https://tanss…/backend`) |
| `SESSION_SECRET` | **Pflicht.** Cookie-Schlüssel, ≥ 32 Zeichen |
| `TOTP_SECRET` | erzeugt den 2FA-Code serverseitig, siehe [Anmeldung](#anmeldung) |
| `TANSS_USERNAME`, `TANSS_PASSWORD` | nur zusammen, standardmäßig leer: Rückfall-Anmeldung ohne Menschen. Der Sammler braucht sie nicht |
| `LINEAR_API_KEY` | persönlicher Linear-Key für den Tagesimport |
| `TANSS_TICKET_URL` | Link „In TANSS öffnen"; ohne Eintrag abgeleitet |
| `HOST_PORT` | Port im Browser (Standard 3848) |
| `PORTAL_TAG` | Image-Tag: `latest` (Standard), `staging` oder feste Version — eine feste Version schaltet Ein-Klick-Updates ab |
| `UPDATE_CHANNEL` | `stable` (Standard) oder `staging` (auch Vorabversionen) |
| `UPDATE_CHECK` | `0` schaltet die Update-Abfrage bei GitHub ab |
| `COMPOSE_PROJECT_NAME` | Name des Compose-Projekts, bestimmt die Containernamen |
| `DEBUG_TANSS` | `1` gibt alle TANSS-Aufrufe auf der Konsole aus |
| `PORT`, `BIND`, `DATA_DIR` | nur ohne Docker; unter Docker setzt `compose.yaml` sie selbst |

> **Achtung bei Sonderzeichen.** Docker liest die `.env` selbst ein: `$` löst
> Variablen-Expansion aus, `#` gilt als Kommentarbeginn. Werte mit diesen
> Zeichen gehören in einfache Anführungszeichen, z. B. `TANSS_PASSWORD='...'`.

## Updates

Ist eine neuere Version freigegeben, zeigt das Portal ein Banner mit „Jetzt
aktualisieren". Der Klick beauftragt den **Updater**, einen zweiten Container
neben dem Portal: Er zieht das neue Image, ersetzt den Portal-Container, wartet
auf `/health` mit der neuen Version und stellt bei einem Fehler die alte Version
wieder her. Den Stand zeigt das Banner; danach lädt die Seite neu. Ein
ausstehendes Update steht außerdem unten in der Navigation unter „Version";
ein Klick darauf startet es mit derselben Rückfrage.

Der Updater ist der einzige Dienst mit Docker-Zugriff (Socket) und hat keine
Ports. Das Portal selbst bekommt keine Docker-Rechte und reicht nur eine
Versionsnummer weiter.

- **Ohne Updater** (oder von Hand): `docker compose pull && docker compose up -d`.
- Den Updater selbst aktualisiert nur dieser Handgriff; das
  [Changelog](CHANGELOG.md) nennt, wann das nötig ist.
- Eine feste `PORTAL_TAG` (z. B. `0.2.0`) schaltet Ein-Klick-Updates ab: Der
  Updater lehnt den Auftrag ab. Zum Aktualisieren `PORTAL_TAG` in der `.env`
  ändern und `docker compose pull && docker compose up -d` ausführen. Mit
  `latest` oder `staging` läuft der Container nach dem Update auf der neuen
  Version weiter.
- `UPDATE_CHECK=0` schaltet die Abfrage bei GitHub ab (kein Banner).
- `UPDATE_CHANNEL=staging` zeigt auch Pre-Releases an (siehe Staging).

### Wenn das Portal nach einem Update nicht zurückkommt

Der Updater stellt bei einem Fehler die alte Version wieder her, auch wenn er
selbst mitten im Update gestoppt wurde (dann beim nächsten Start). Hilft das
nicht, im Installationsordner nachsehen:

```bash
docker compose logs updater     # was der Updater getan hat
cat data/update/status.json     # letzter Stand des Updates
docker compose ps -a            # welche Container es gibt
```

Gibt es einen Container `<projekt>-portal-1-vorher`, ist das die alte Version.
Zurückholen von Hand (Projektname z. B. `agent-portal`):

```bash
docker rm -f agent-portal-portal-1      # nur falls vorhanden
docker rename agent-portal-portal-1-vorher agent-portal-portal-1
docker start agent-portal-portal-1
```

Oder einfach `docker compose up -d`: Compose erstellt das Portal dann aus der
`compose.yaml` neu; einen übrig gebliebenen `-vorher`-Container danach mit
`docker rm` entfernen.

## Staging

Neue Versionen erscheinen zuerst als Vorabversion (Pre-Release). Um sie vor
der Freigabe zu testen, richtest du eine zweite Instanz ein — genauso wie oben,
nur in einem eigenen Ordner, mit den Dateien des Pre-Release und vier
zusätzlichen Zeilen in der `.env`:

1. Ordner `agent-portal-staging` mit `data/update` anlegen und `compose.yaml`
   sowie `env.example` (als `.env`) laden — wie in Schritt 1 der
   Installation, aber statt `releases/latest/download/` die Adresse
   `releases/download/vX.Y.Z/` des Pre-Release verwenden.
2. In der `.env` die Pflichtwerte eintragen und am Ende der Datei bei diesen
   vier Zeilen das `#` entfernen:

   ```
   COMPOSE_PROJECT_NAME=agent-portal-staging
   HOST_PORT=3849
   PORTAL_TAG=staging
   UPDATE_CHANNEL=staging
   ```

3. `docker compose up -d` — die Staging-Instanz läuft dann unter
   <http://127.0.0.1:3849>, unabhängig von der normalen Instanz.

Die Staging-Instanz bekommt jede neue Vorabversion als Update angeboten.

> **Achtung:** Staging spricht das TANSS an, das in seiner `.env` steht. Ohne
> separates Testsystem sind das echte Daten.

## Umstieg von 0.1.0

Bis 0.1.0 baute `compose.yaml` das Image lokal aus dem Repo und vergab den
Containernamen `agent-portal`. Zum Wechsel auf die fertigen Images (möglich,
sobald 0.2.0 oder neuer freigegeben ist):

1. Im bisherigen Ordner `compose.yaml` durch die aktuelle ersetzen (Download
   wie in Schritt 1 der Installation). `.env` und `data/` bleiben.
2. Den Ordner `data/update` anlegen.
3. `docker compose pull`, dann `docker compose up -d` — ohne vorheriges
   `docker compose down`: Compose ersetzt den alten Container `agent-portal`
   selbst.

Die Container heißen danach nach dem Projekt, z. B. `agent-portal-portal-1`.

## Anmeldung

`POST /auth/login` → `POST /api/v1/login` mit Benutzername, Passwort und
2FA-Code. Ist `TOTP_SECRET` gesetzt (Base32 oder `otpauth://totp/...`-URI),
erzeugt der Server den Code selbst (RFC 6238) und die Maske fragt nur noch
Benutzername und Passwort ab. **Damit liegt der
zweite Faktor neben den Zugangsdaten**; `.env` gehört nicht ins Repo.

Läuft der apiToken ab (4 h) oder antwortet TANSS 401, holt der Server mit dem
Refresh-Token ein neues Paar und legt es in der geteilten Sitzung ab.

**Geteilte Sitzung & Dashboard-Messpunkte.** Das Token-Paar liegt nicht im
Browser-Cookie, sondern serverseitig in `DATA_DIR/session.json` (chmod 600);
das Cookie sagt nur, wer du bist. Browser und Dashboard-Sammler teilen sich
diese eine Sitzung und rollen den Refresh-Token gemeinsam weiter — die
Rotation ist serialisiert, denn TANSS gibt bei jeder Benutzung ein neues Paar
aus und entwertet das alte. Zwei Holder derselben Kette würden sich sonst
gegenseitig ausloggen (was mit dem alten Cookie-Modell bei zwei offenen
Browsern tatsächlich passierte).

Daraus folgt der Betrieb ohne Zugangsdaten auf der Platte: Deine Anmeldung an
der Maske sät die Sitzung, der Sammler zählt damit alle 5 Minuten die
Ticketlisten (nur Lesen) und hält sie dabei am Leben. **Es liegt kein Passwort
und kein 2FA-Seed für den Sammler auf dem Server**, also kann auch kein
automatischer Fehlversuch ein TANSS-Konto sperren. Grenze: Der Refresh-Token
gilt laut API-Spec 5 Tage; war der Container so lange aus, meldest du dich
einmal neu an. „Abmelden" macht alle Browser-Cookies dieses Kontos ungültig,
auch Kopien davon (der Server zählt dafür je Konto eine Generation in
`DATA_DIR/session-generations.json` hoch). Der Sammler läuft weiter;
`Einstellungen → Dashboard-Sammler` zeigt seinen Zustand und stoppt ihn.

> **Achtung bei Sonderzeichen.** Docker liest die `.env` selbst ein: `$` löst
> Variablen-Expansion aus, `#` gilt als Kommentarbeginn. Ein Passwort mit
> diesen Zeichen kommt ohne einfache Anführungszeichen verstümmelt im
> Container an — hier hat das eine automatische Anmeldung mit falschem
> Passwort erzeugt und damit ein TANSS-Konto gesperrt. Also
> `TANSS_PASSWORD='...'` schreiben und einmal nachsehen:
> `docker compose exec portal sh -c 'printf "%s" "$TANSS_PASSWORD" | wc -c'`
> muss dieselbe Länge liefern wie der Wert in der Datei.

**Optionaler Rückfall.** Sind `TANSS_USERNAME` und `TANSS_PASSWORD` gesetzt
(zusammen mit `TOTP_SECRET`), meldet sich der Server bei einer toten Sitzung
zusätzlich selbst an. Das ist bewusst **aus** by default, weil dabei Passwort
und zweiter Faktor auf der Maschine liegen. Ist es an, geht jede automatische
Anmeldung durch das Tor in `server/login.ts`:

| Fall | Verhalten |
| --- | --- |
| TANSS lehnt die Zugangsdaten ab (falsches Passwort, 2FA abgelehnt) | **genau ein Versuch**, danach aus. Erst Zugangsdaten prüfen und neu starten |
| TANSS antwortet nicht / Proxy-Fehler | Pause 5, dann 15, dann 45 Minuten — nach dem 4. Versuch aus |
| Anmeldung hängt | Abbruch nach 30 s (statt im Proxy-Timeout zu verschwinden) |

Höchstens vier automatische Anmeldeversuche, dann wartet der Server auf einen
Menschen. Der Zustand steht oben im Dashboard (grün „letzte Messung um …",
gelb bei Pause, rot bei Stopp) — eine stille Fehlmessung gibt es nicht. Was
im Login-Formular getippt wird, geht nie durch dieses Tor: eine Anmeldung von
Hand ist immer erlaubt.

### KI-Agent (lokales Modell)

Alles läuft gegen einen OpenAI-kompatiblen Endpoint auf dem eigenen Rechner
oder im eigenen Netz (oMLX, Ollama, LM Studio, vLLM). Der Agent schreibt nie
selbst nach TANSS: Entwürfe landen im Textfeld, Buchungen machst du selbst.

| Funktion | Wo | Was das Modell bekommt |
| --- | --- | --- |
| Mein Briefing | Tickets, Agent-Panel | deterministische Fakten (neu seit gestern, überfällig, ≥7 d inaktiv, wartend) über alle mir zugewiesenen Tickets; einmal pro Tag gecacht |
| Briefing „Liste" | Tickets, Agent-Panel | dasselbe über die gerade offene Liste (Tab oder gespeicherte Liste, mit Filtern); eigener Tages-Cache je Liste |
| Muster analysieren | Tickets, Agent-Panel | die sichtbaren Zeilen (max. 80); Gruppen mutmaßlich zusammengehöriger Fälle mit Begründung |
| Zusammenfassen | Ticket-Drawer | Ticket + Thread (neueste Einträge zuerst; Budget aus dem Kontextfenster, s. u.) |
| Entwurf ▾ | Drawer und Sammelkommentar | Statusanfrage, Zusammenfassung, Abschlussnotiz oder eigene Anweisung; bei mehreren Tickets nur die Titel |
| Antwort entwerfen | Drawer, an jeder eingehenden Mail | Antwort auf genau diese Mail (Zitate/Signatur vorher deterministisch entfernt); landet im Notizfeld mit Titel „Mail-Entwurf: Antwort auf „…" an …" und wird als interne Notiz ins Ticket gespeichert — zum Kopieren in die TANSS-Mail. Versand gibt es in der API nicht; ob Kommentare eine Kundenmail auslösen, hängt von der TANSS-Konfiguration ab |
| Kürzen | Drawer, an langen Mails | Kurzfassung der Mail ohne Zitate, Signatur, Disclaimer; „Original" schaltet zurück |
| Nächster Schritt | Drawer, Eigenschaften | ein Satz + wer am Zug ist; schlägt ggf. einen Status aus der TANSS-Statusliste vor — der Wechsel ist ein Klick |
| Ähnliche Tickets | Drawer, Eigenschaften | Kandidaten aus `PUT search` (Titelbegriffe) und dem Board (max. 60); das Modell wählt mit Begründung |
| Kunde prüfen | Drawer, Eigenschaften | Titel, Beschreibung und die erste eingehende Mail (mit Absenderadresse). Nennt der Text eine andere Firma als die zugewiesene, sucht der Server sie in TANSS (`PUT search`) und das Modell wählt den Kunden aus den Treffern. Der Wechsel ist ein Klick; der Ansprechpartner bleibt stehen und ist in TANSS nachzuziehen |
| Aus dem Verlauf entwerfen | Buchen (Drawer-Zeiten und Zeiten-Ansicht, wenn ein Ticket gewählt ist) | Tätigkeitstext aus den letzten Kommentaren, Mails und Leistungen; folgt den eigenen Stilregeln |
| Aus Issue formulieren | Tagesimport, je Zeile | die eigenen Linear-Notizen des Tages, in einen Leistungstext im eigenen Stil gebracht |
| Tagesassistent | Zeiten, „Was fehlt noch?" | ein Aufruf über Buchungen, offene Termine und Anrufe, Linear-Aktivität, Lücken, Bausteine und Wiederkehrendes; trennt Belegtes von Vermutetem |
| Chat-Sidebar (g a) | rechts, über „Agent“ in der Kopfzeile ein- und ausblendbar | Frage frei formulieren; der Agent sucht und liest selbst nach: `tickets_suchen`, `ticket_lesen`, `leistungen_ticket` (nur lesend, max. 4 Runden, 6 Aufrufe, 3 Verläufe; nach 120 s werden keine weiteren Werkzeuge mehr gestartet). Fest dabei sind die offenen Tickets (meine zuerst, max. 80), die heutigen Buchungen und das geöffnete Ticket. Unter der Antwort steht, was gesucht und gelesen wurde; ein Knopf kopiert sie. Antwortet nur, führt nichts aus. Verlauf bleibt im Browser (letzte 40 Nachrichten). Kann das Modell keine Werkzeuge, gilt der alte Weg mit `#`-Nennung |

**Kontextbudget.** In den Einstellungen steht das Kontextfenster des Modells (Standard 32.768 Tokens). Daraus leitet `shared/agent.ts::threadBudget()` ab, wie viele Zeichen eines Ticketverlaufs ein Prompt bekommt: 70 % des Fensters abzüglich 2.500 Token Reserve, bei 3,2 Zeichen/Token, begrenzt auf 8.000–120.000 Zeichen (32k → ~68.000 Zeichen, 128k → 120.000). Der Verlauf wird von neu nach alt gefüllt, einzelne Einträge auf ein Viertel des Budgets gekappt, Mails ohne Zitate und Signaturen. Im Chat zieht jeder gelesene Verlauf ein Drittel des Budgets; ist es aufgebraucht, sagt das Werkzeug das, statt still zu kürzen. Listen bekommen nur Zeilen (Briefing 25 je Kategorie, Muster 80, Ähnliche 60).

Im Container ist das Host-LLM als `http://host.docker.internal:<port>` erreichbar.

Tasten: `g h/d/t/z/w/i/l/s` Ansicht, `g a` Agent-Sidebar, `/` Suche, `⌘K` Befehle, `j/k` Fokus, `x` wählen (`X` bis zur
zuletzt gewählten Zeile, wie ⇧-Klick in der Liste), `⏎` öffnen, `a` mir zuweisen, `s` Status,
`f` Fälligkeit, `c` Kommentar in Auswahl, `Esc` schließen.

**Auswertung.** Eigene Ansicht über die gebuchten Zeiten eines frei wählbaren
Zeitraums: Soll und Ist, abrechenbar gegen intern, Verlauf je Tag/Woche/Monat,
Top-Tickets, Top-Kunden, Leistungsarten und alle Buchungen als Tabelle. Ein
Klick auf einen Balken filtert alles auf diese Facette. Die Ansicht liest nur —
sie holt die Buchungen mit einem Aufruf über `GET /me/supports/range` und
schreibt weder nach TANSS noch in den Store.

## Webhooks

Ein Webhook meldet einen Statuswechsel an ein anderes System, zum Beispiel an
einen n8n-Workflow. Du legst ihn für dich an und hängst ihn an einzelne
Tickets. Ändert sich der Status eines Tickets, schickt das Portal einen
HTTP-POST an die Ziel-URL. Das gibt es nur im Portal: In TANSS wird nichts
angelegt oder geändert, das Portal liest nur.

**So benutzt du es.**

1. **Einstellungen → Webhooks:** Webhook anlegen mit Name, Ziel-URL
   (`http` oder `https`), optionalem Zielstatus-Filter (leer heißt: jeder
   Wechsel), Vorlage und Anmeldung beim Empfänger (siehe unten). „Testen"
   schickt ein Beispiel mit erfundenen Daten und zeigt dir den Statuscode samt
   dem Anfang der Antwort des Empfängers, etwa `HTTP 401: {"error":"invalid token"}`.
2. **Im Ticket** rechts unter „Webhooks" hängst du ihn an. „einmalig" löst die
   Verknüpfung, sobald der erste Aufruf angestoßen ist; schlägt er fehl, steht er
   im Protokoll und lässt sich von dort noch einmal senden. Der Abschnitt
   erscheint erst, wenn du mindestens einen Webhook angelegt hast.
3. **Protokoll** unter der Liste in den Einstellungen: Jede Zustellung mit
   Ergebnis. Fehlgeschlagene schickst du mit „Erneut senden" noch einmal.

Jeder Techniker sieht und benutzt nur seine eigenen Webhooks.

**Grenzen.**

- Das Portal prüft die Tickets alle 5 Minuten. Die Meldung kommt also bis zu
  5 Minuten nach der Änderung.
- Ändert sich der Status zweimal innerhalb eines Intervalls, kommt nur ein
  Wechsel an, vom alten zum letzten Stand (A→C statt A→B und B→C).
- Der Anlass („Mail von …", „Kommentar von …", „Zeitbuchung von …") wird aus
  dem Ticketverlauf abgeleitet und ist eine Vermutung. Nur wenn du den Status
  im Portal geändert hast, steht „Im Portal von … geändert" fest. Mail- und
  Kommentartexte gehen nie mit, nur Art, Name und Zeit.
- Geprüft wird nur, solange das Portal läuft und eine gültige TANSS-Sitzung
  des Technikers besteht.
- Weiterleitungen (Redirects) folgt das Portal nicht; sie zählen als Fehler.
  Trage die endgültige URL ein.

**Inhalt.** Die Vorlage ist standardmäßig `{{json}}`, das ganze Objekt:

```json
{
  "ticket": { "id": 12345, "title": "Drucker offline", "url": "https://tanss.example.com/index.php?section=bug&sub=view&bugID=12345", "customer": "Beispiel GmbH" },
  "status": { "old": { "id": 1, "name": "Neu" }, "new": { "id": 2, "name": "Erledigt" } },
  "cause": { "derived": true, "kind": "mail", "by": "Max Mustermann", "at": "2026-10-20T08:12:00.000Z", "summary": "Mail von Max Mustermann um 10:12" },
  "changedAt": "2026-10-20T08:15:00.000Z",
  "technician": "Erika Beispiel",
  "webhook": { "id": "…", "name": "n8n Status" },
  "test": false
}
```

Eigene Vorlagen müssen gültiges JSON ergeben. Platzhalter, die Text liefern,
setzt das Portal JSON-sicher maskiert ein, aber ohne Anführungszeichen. Die
setzt du selbst um den Platzhalter:
`{"text": "{{ticket.title}} ist jetzt {{status.new}}"}`. Zahlen (`ticket.id`)
setzt das Portal ohne Anführungszeichen ein. Beim Speichern lehnt das Portal
unbekannte Platzhalter ab, ebenso eine Vorlage, die kein gültiges JSON ergibt.

| Platzhalter | Inhalt |
| --- | --- |
| `{{ticket.id}}` | Ticketnummer |
| `{{ticket.title}}` | Titel |
| `{{ticket.url}}` | Link in TANSS wie „In TANSS öffnen" (aus `TANSS_TICKET_URL`, sonst aus `TANSS_BASE_URL` abgeleitet) |
| `{{customer}}` | Kunde |
| `{{status.old}}`, `{{status.new}}` | Name des alten und des neuen Status |
| `{{cause.summary}}` | Anlass als Satz |
| `{{cause.kind}}` | `mail`, `comment`, `support`, `portal` oder `unknown` |
| `{{cause.by}}`, `{{cause.at}}` | Wer, und wann (ISO-Zeit) |
| `{{changedAt}}` | Zeitpunkt der Erkennung (ISO-Zeit) |
| `{{technician}}` | Techniker, dem der Webhook gehört |
| `{{webhook.name}}` | Name des Webhooks |
| `{{json}}` | das ganze Objekt oben |

**Anmeldung beim Empfänger.** Pro Webhook wählst du, wie sich das Portal
ausweist; der eingetragene Wert ist danach nicht mehr zu sehen, nur Anfang,
Ende und Länge (etwa `tok_…yz (40 Zeichen)`), damit du prüfen kannst, ob er
vollständig angekommen ist. Leerzeichen und Zeilenumbrüche am Anfang und Ende
werden beim Speichern entfernt.

- **Signatur:** `X-Portal-Signature` mit einem Geheimnis, das der Empfänger
  nachrechnet (siehe unten). Ohne Geheimnis geht der Aufruf ohne Anmeldung raus.
- **Bearer-Token:** `Authorization: Bearer <Token>` — für Empfänger, die einen
  API-Schlüssel oder Token erwarten.
- **Eigener Header:** Der Wert geht in einem Header, dessen Namen du festlegst,
  zum Beispiel `X-Api-Key: <Wert>`.

**Header.** Jeder Aufruf ist ein `POST` mit `Content-Type: application/json`
und diesen Headern:

- `X-Portal-Delivery`: ID der Zustellung. Bei Wiederholungen bleibt sie gleich;
  damit kann der Empfänger Doppelte verwerfen. Zugestellt wird mindestens
  einmal, nicht genau einmal.
- `X-Portal-Timestamp`: Unix-Sekunden zum Zeitpunkt des Sendens.
- `X-Portal-Signature: sha256=<hex>`: nur bei der Anmeldung „Signatur“ mit
  Geheimnis. Es ist der
  HMAC-SHA256 über `"<timestamp>.<body>"` (Zeitstempel, Punkt, Rumpf genau so
  wie gesendet) mit dem Geheimnis als Schlüssel.

Prüfen in Node.js. `rawBody` ist der
unveränderte Rumpf als Text, nicht das geparste und neu serialisierte JSON:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, headers, rawBody) {
  const timestamp = headers["x-portal-timestamp"];
  const given = headers["x-portal-signature"] ?? "";
  // Alte Aufrufe abweisen, damit niemand einen mitgeschnittenen wiederholt.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!(age <= 300)) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Ein Zeitfenster von 5 Minuten reicht. Wiederholungen tragen bei jedem Versuch
einen neuen Zeitstempel und eine neue Signatur, aber dieselbe
`X-Portal-Delivery`. Als Ziel eignet sich zum Beispiel
`https://n8n.example.com/webhook/ticket-status`.

**Wiederholungen.** Ein Aufruf hat 10 Sekunden Zeit; als Erfolg zählt jeder
2xx-Code. Sonst versucht das Portal es frühestens nach 30 Sekunden bzw.
2 Minuten noch einmal. Schlägt auch das fehl, steht die Zustellung im Protokoll als
fehlgeschlagen, und du kannst sie mit „Erneut senden" anstoßen. Dieser neue
Versuch trägt eine neue `X-Portal-Delivery`. Das Protokoll hält alle offenen
Zustellungen und die letzten 200 abgeschlossenen.

**Fehlersuche.** Jeder Webhook-Aufruf steht auch im **Log** (Quelle „Webhook“):
Ziel-URL, die gesendeten Header, der Inhalt, Statuscode, Dauer und die Antwort
des Empfängers im Wortlaut. Token und Header-Werte erscheinen dort nur gekürzt.
Antwortet der Empfänger mit 401 oder 403, liegt es meist an der Anmeldung: Prüfe,
ob die gewählte Art zu dem passt, was der Empfänger erwartet, und ob der
gespeicherte Wert nach Anfang, Ende und Länge stimmt.

## Was bewusst fehlt

Risiko-Score und Linear/Git als Quellen des Agenten (Ausbaustufe 2).
Mailversand kennt die TANSS-API nicht.

## Entwicklung

Für Änderungen am Code braucht es einen Klon des Repos und Node.js ≥ 22:

```bash
cp .env.example .env    # Pflichtwerte eintragen
npm install
npm run dev             # API auf :3848, Oberfläche auf :5173
npm run check           # Typen + Tests
```

Beide Images lokal bauen und wie im Betrieb starten:

```bash
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

Ein Ein-Klick-Update ersetzt auch hier das lokal gebaute Portal durch das
Release-Image.

## Aufbau

```
server/   Fastify-Routen (app.ts, agent.ts), TANSS-Client, geteilte Sitzung, Anmelde-Tor,
          Dashboard-Sammler, LLM-Client, Store, TOTP, Protokoll
shared/   reine Logik: Ticketzeilen, Thread, Tageszeitleiste, Berlin-Zeit, Agent-Prompts/-Fakten
src/      React-Oberfläche; Tokens aus dem Artboard in styles/app.css
updater/  eigener Container für Ein-Klick-Updates (nur Node-Bordmittel, Docker-Socket)
docs/     Design-Artboard
```

## Versionen und Releases

Versionsnummern folgen [Semantic Versioning](https://semver.org/lang/de/). Die
laufende Version steht in den Einstellungen und in der Antwort von `/health`,
die Änderungen je Version in [CHANGELOG.md](CHANGELOG.md). Zu jeder Version
gibt es fertige Images für amd64 und arm64, für das Portal
(`ghcr.io/0x5j/tanss-agent-portal`) und den Updater
(`ghcr.io/0x5j/tanss-agent-portal-updater`). `latest` zeigt auf die höchste
freigegebene Version, `<major>.<minor>` auf die höchste dieser Reihe.

Eine neue Version veröffentlichen:

1. In `CHANGELOG.md` die Einträge unter „Unveröffentlicht" in einen neuen
   Abschnitt `## [X.Y.Z] – JJJJ-MM-TT` verschieben und die Vergleichslinks am
   Ende nachziehen.
2. `npm version X.Y.Z --no-git-tag-version` setzt die Version in
   `package.json` und `package-lock.json`.
3. Committen, `git tag vX.Y.Z`, Branch und Tag pushen.
4. `release.yml` prüft, dass Tag, `package.json` und Changelog zusammenpassen,
   führt Typen und Tests aus, baut beide Images mit dem Tag `<version>` und
   legt ein **Pre-Release** mit dem Changelog-Abschnitt und den Dateien
   `compose.yaml` und `env.example` an. `staging` rückt nur nach, wenn der Tag
   die höchste Version ist (ein Patch für eine ältere Reihe verschiebt es
   nicht). `latest` bleibt unverändert; Instanzen auf `stable` sehen die
   Version noch nicht.
5. Auf der Staging-Instanz testen (Update per Banner oder
   `docker compose pull && docker compose up -d`).
6. Freigeben: in GitHub am Release den Haken „Pre-release" entfernen oder
   `gh release edit vX.Y.Z --prerelease=false --latest` (bei einem Patch einer
   älteren Reihe `--latest=false`). `promote.yml` setzt `latest` und `X.Y` auf
   denselben Image-Digest wie `X.Y.Z` (nichts wird neu gebaut), aber nur
   vorwärts: Ist schon eine höhere Version freigegeben, bleiben die Tags
   stehen. Danach sehen Live-Instanzen das Update. Notfalls lässt sich der
   Workflow mit der Version von Hand starten.

Ein Fehler in einer getesteten Version wird nicht nachträglich überschrieben:
beheben und die nächste Patch-Version veröffentlichen.

## Lizenz

[MIT](LICENSE)
