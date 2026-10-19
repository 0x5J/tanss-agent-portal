# Agent-Portal (tanss_v2)

Web-Oberfläche für die eigenen Tickets und Leistungen in
[TANSS](https://www.tanss.de/), dem Ticket- und Abrechnungssystem für
IT-Dienstleister — mit einem optionalen KI-Agenten, der gegen ein lokales
Sprachmodell läuft. Umgesetzt nach dem Design-Artboard
`docs/design/Agent-Portal.dc.html`. Ein Container, ein
Prozess: Fastify hält die TANSS-Session serverseitig, das HttpOnly-Cookie trägt
nur die Identität, und die gebaute React-Oberfläche kommt aus demselben
Container. Der Browser spricht nie selbst mit TANSS.

> Inoffizielles Projekt, nicht mit dem Hersteller von TANSS verbunden. Es
> spricht die öffentliche TANSS-REST-API an; die Dokumentation dazu gibt es
> unter [api-doc.tanss.de](https://api-doc.tanss.de/).

## Voraussetzungen

- eine TANSS-Instanz mit freigeschalteter REST-API und ein eigenes Konto
- Docker (mit Compose) oder Node.js ≥ 22
- optional: ein OpenAI-kompatibler LLM-Endpoint (oMLX, Ollama, LM Studio, vLLM)
  für die KI-Funktionen
- optional: ein persönlicher Linear-API-Key für den Tagesimport

## Start

```bash
cp .env.example .env          # TANSS_BASE_URL, SESSION_SECRET (≥ 32 Zeichen), optional TOTP_SECRET
chmod 600 .env
docker compose up -d --build  # http://127.0.0.1:3848
```

Entwicklung ohne Container:

```bash
npm install
npm run dev      # API auf :3848, Oberfläche auf :5173
npm run check    # Typen + Tests
```

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
> `docker exec agent-portal sh -c 'printf "%s" "$TANSS_PASSWORD" | wc -c'`
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
selbst nach TANSS: Entwürfe landen im Textfeld, Buchungen in den Freigaben.

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
| Chat-Sidebar (g a) | rechts, einklappbar | Frage frei formulieren; der Agent sucht und liest selbst nach: `tickets_suchen`, `ticket_lesen`, `leistungen_ticket` (nur lesend, max. 4 Runden, 6 Aufrufe, 3 Verläufe; nach 120 s werden keine weiteren Werkzeuge mehr gestartet). Fest dabei sind die offenen Tickets (meine zuerst, max. 80), die heutigen Buchungen und das geöffnete Ticket. Unter der Antwort steht, was gesucht und gelesen wurde; ein Knopf kopiert sie. Antwortet nur, führt nichts aus. Verlauf bleibt im Browser (letzte 40 Nachrichten). Kann das Modell keine Werkzeuge, gilt der alte Weg mit `#`-Nennung |
| Agent fragen | Zeiten, Lückenkarte | eigene Tickets mit Spuren an dem Tag (eigene Kommentare, Änderungen; max. 12 Verläufe) und die Buchungen des Tages → ein Buchungsvorschlag in den Freigaben oder „kein Anhaltspunkt" |

**Kontextbudget.** In den Einstellungen steht das Kontextfenster des Modells (Standard 32.768 Tokens). Daraus leitet `shared/agent.ts::threadBudget()` ab, wie viele Zeichen eines Ticketverlaufs ein Prompt bekommt: 70 % des Fensters abzüglich 2.500 Token Reserve, bei 3,2 Zeichen/Token, begrenzt auf 8.000–120.000 Zeichen (32k → ~68.000 Zeichen, 128k → 120.000). Der Verlauf wird von neu nach alt gefüllt, einzelne Einträge auf ein Viertel des Budgets gekappt, Mails ohne Zitate und Signaturen. Im Chat zieht jeder gelesene Verlauf ein Drittel des Budgets; ist es aufgebraucht, sagt das Werkzeug das, statt still zu kürzen. Listen bekommen nur Zeilen (Briefing 25 je Kategorie, Muster 80, Ähnliche 60).

Im Container ist das Host-LLM als `http://host.docker.internal:<port>` erreichbar.

Tasten: `g d/t/f/z/w/l/s` Ansicht, `g a` Agent-Sidebar, `/` Suche, `⌘K` Befehle, `j/k` Fokus, `x` wählen (`X` bis zur
zuletzt gewählten Zeile, wie ⇧-Klick in der Liste), `⏎` öffnen, `a` mir zuweisen, `s` Status,
`f` Fälligkeit, `c` Kommentar in Auswahl, `Esc` schließen.

**Auswertung.** Eigene Ansicht über die gebuchten Zeiten eines frei wählbaren
Zeitraums: Soll und Ist, abrechenbar gegen intern, Verlauf je Tag/Woche/Monat,
Top-Tickets, Top-Kunden, Leistungsarten und alle Buchungen als Tabelle. Ein
Klick auf einen Balken filtert alles auf diese Facette. Die Ansicht liest nur —
sie holt die Buchungen mit einem Aufruf über `GET /me/supports/range` und
schreibt weder nach TANSS noch in den Store.

## Was bewusst fehlt

Risiko-Score und Linear/Git als Quellen des Agenten (Ausbaustufe 2).
Mailversand kennt die TANSS-API nicht.

## Aufbau

```
server/   Fastify-Routen (app.ts, agent.ts), TANSS-Client, geteilte Sitzung, Anmelde-Tor,
          Dashboard-Sammler, LLM-Client, Store, TOTP, Protokoll
shared/   reine Logik: Ticketzeilen, Thread, Tageszeitleiste, Berlin-Zeit, Agent-Prompts/-Fakten
src/      React-Oberfläche; Tokens aus dem Artboard in styles/app.css
docs/     Design-Artboard
```

| Variable | Zweck |
| --- | --- |
| `TANSS_BASE_URL` | Basis-URL der TANSS-API (z. B. `https://tanss…/backend`) |
| `DATA_DIR` | Ablage für TANSS-Sitzung, Tagesberichte (`reports/<mitarbeiter>/`), Übernahme-Protokoll, KI-Einstellungen, gespeicherte Listen, Messpunkte und Freigabe-Queue (Standard `data`, im Container `/app/data` als Volume `./data`) |
| `SESSION_SECRET` | Cookie-Schlüssel, ≥ 32 Zeichen |
| `TOTP_SECRET` | optional, erzeugt den 2FA-Code serverseitig |
| `TANSS_USERNAME`, `TANSS_PASSWORD` | optional (nur zusammen), standardmäßig leer: Rückfall-Anmeldung ohne Menschen. Der Sammler braucht sie nicht |
| `TANSS_TICKET_URL` | optional, Link „In TANSS öffnen" |
| `PORT`, `BIND` | Standard 3848 / 127.0.0.1 (Container: 0.0.0.0 + `ALLOW_ALL_INTERFACES=1`) |
| `DEBUG_TANSS=1` | alle TANSS-Aufrufe auf die Konsole |

## Versionen und Releases

Versionsnummern folgen [Semantic Versioning](https://semver.org/lang/de/). Die
laufende Version steht in den Einstellungen und in der Antwort von `/health`,
die Änderungen je Version in [CHANGELOG.md](CHANGELOG.md). Zu jedem Release
gibt es ein fertiges Image für amd64 und arm64:
`ghcr.io/0x5j/tanss-agent-portal:<version>` (dazu `latest` und `<major>.<minor>`).

Eine neue Version veröffentlichen:

1. In `CHANGELOG.md` die Einträge unter „Unveröffentlicht" in einen neuen
   Abschnitt `## [X.Y.Z] – JJJJ-MM-TT` verschieben und die Vergleichslinks am
   Ende nachziehen.
2. `npm version X.Y.Z --no-git-tag-version` setzt die Version in
   `package.json` und `package-lock.json`.
3. Committen, `git tag vX.Y.Z`, Branch und Tag pushen.

Der Workflow `release.yml` bricht ab, wenn Tag, `package.json` und Changelog
nicht zusammenpassen. Sonst prüft er Typen und Tests, baut und veröffentlicht
das Image und legt das GitHub-Release mit dem Changelog-Abschnitt als Text an.

## Lizenz

[MIT](LICENSE)
