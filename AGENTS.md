# Anweisungen für KI-Agenten

Diese Datei richtet sich an Coding-Agenten wie Claude Code, Cursor oder Codex.

## „Installier mir das“ heißt: Docker

Wenn jemand das Portal **installieren, einrichten oder nutzen** möchte, läuft
das **immer über Docker und die fertigen Images** auf `ghcr.io`. Das gilt auch
dann, wenn Node.js vorhanden ist und das Repo schon geklont wurde.

**Nicht tun:**

- kein `npm install`, `npm run dev`, `npm run build` oder `npm start`
- kein `compose.build.yaml` und kein `docker build`
- kein Dienst über systemd, launchd, pm2 oder Ähnliches
- die Installation nicht im geklonten Repo anlegen und `compose.yaml` nicht ändern

**Warum:** Nur diese Installation hat den Updater mit Ein-Klick-Updates und
Herkunftsprüfung und ist bewusst nur vom eigenen Rechner aus erreichbar.

**Docker fehlt oder läuft nicht:** Nicht auf Node.js ausweichen. Sag der Person,
was fehlt, und warte, bis sie Docker installiert oder gestartet hat:
[Docker Desktop](https://www.docker.com/products/docker-desktop/) für Windows
und macOS, Docker mit Compose-Plugin für Linux.

Der Weg über Node.js ist nur für Änderungen am Code gedacht und nur, wenn die
Person das ausdrücklich will (README, Abschnitt „Entwicklung“).

## Ablauf

Die Befehle unten sind für macOS und Linux. Für Windows stehen die
PowerShell-Befehle im [README](README.md#installation).

### 1. Voraussetzungen und Bestand prüfen

```bash
docker compose version
docker info
```

Gibt es schon einen Ordner `agent-portal` oder eine `.env`, nichts überschreiben,
sondern erst nachfragen. Eine `.env` und ein `data/`-Ordner enthalten
Einstellungen und Anmeldedaten. Eine bestehende Installation wird nicht neu
angelegt, sondern über das Update-Banner im Portal aktualisiert.

### 2. Ordner außerhalb des Repos anlegen und Dateien laden

Frag, wo der Ordner liegen soll, wenn das nicht klar ist. Die Dateien kommen aus
dem Release, nicht aus dem Repo, denn der Stand im Repo kann neuer sein als die
freigegebene Version.

```bash
mkdir -p agent-portal/data/update
cd agent-portal
curl -fLO https://github.com/0x5J/tanss-agent-portal/releases/latest/download/compose.yaml
curl -fL -o .env https://github.com/0x5J/tanss-agent-portal/releases/latest/download/env.example
chmod 600 .env
```

### 3. `.env` ausfüllen

Nur die zwei Pflichtwerte setzen, alles andere bleibt auskommentiert:

- **`TANSS_BASE_URL`:** Bei der Person erfragen. Meist ist es die TANSS-Adresse
  mit `/backend` am Ende, z. B. `https://tanss.firma.de/backend`.
- **`SESSION_SECRET`:** Selbst mit `openssl rand -hex 32` erzeugen und direkt in
  die `.env` schreiben, ohne den Wert auszugeben.

**Zugangsdaten:** Frag nie nach TANSS-Passwort, 2FA-Code oder Token. Die Anmeldung
macht die Person selbst im Browser. `TOTP_SECRET`, `TANSS_USERNAME` und
`TANSS_PASSWORD` nur setzen, wenn sie das ausdrücklich will. Den Inhalt der
`.env` nicht ausgeben.

**Nur Linux:** Das Portal läuft als uid 1000. Liefert `id -u` etwas anderes, einmal
`sudo chown -R 1000:1000 data` ausführen. Die Person fragen, bevor du `sudo` nutzt.

**Port belegt:** Ist 3848 schon vergeben, in der `.env` `HOST_PORT` setzen. Die
Adresse in den nächsten Schritten ändert sich dann entsprechend.

### 4. Starten und prüfen

```bash
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:3848/health
```

Es müssen zwei Container laufen, `portal` und `updater`. Startet das Portal
nicht, steht der Grund in `docker compose logs portal`, meist ein fehlender oder
zu kurzer Pflichtwert in der `.env`. Den Fehler dort beheben und nicht auf einen
anderen Installationsweg wechseln.

### 5. Übergeben

Sag der Person:

- Das Portal läuft unter <http://127.0.0.1:3848> und ist nur von diesem Rechner
  aus erreichbar.
- Anmelden kann sie sich dort mit ihrem eigenen TANSS-Konto.
- Die KI-Funktionen sind optional und werden im Portal unter „Einstellungen“
  eingerichtet. Ein Sprachmodell auf demselben Rechner ist dort als
  `http://host.docker.internal:<port>` erreichbar.

Das Portal nicht über Netz oder Internet erreichbar machen, außer die Person
verlangt das ausdrücklich. Dann vorher auf das Risiko hinweisen: Hinter der
Anmeldung liegen ihre TANSS-Daten.
