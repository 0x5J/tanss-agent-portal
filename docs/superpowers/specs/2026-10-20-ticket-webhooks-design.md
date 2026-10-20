# Webhooks bei Statuswechsel pro Ticket – Design

Stand: 2026-10-20

## Worum es geht

Ein Techniker will informiert werden – oder eine Automation (z. B. n8n, Teams,
Slack) anstoßen –, wenn sich bei einem bestimmten Ticket der Status ändert. Er
legt dafür in den Einstellungen Webhooks an und hängt sie im Ticket an. Ändert
sich der Status dieses Tickets, schickt das Portal einen HTTP-Aufruf an die
hinterlegte URL, inklusive einer Einschätzung, wodurch der Wechsel kam.

Das ist eine reine Portal-Funktion. In TANSS wird nichts angelegt oder
geändert; die eingebauten TANSS-Webhooks (`/api/v1/tanssEvents/rules`) werden
bewusst nicht benutzt (nur für Board-Spalten, brauchen Adminrechte, würden
Konfiguration nach TANSS schreiben).

## Ziele

- Webhooks pro Techniker in den Einstellungen anlegen, bearbeiten, testen,
  löschen.
- Im Ticket einen oder mehrere eigene Webhooks anhängen und wieder lösen.
- Bei einem Statuswechsel eines solchen Tickets einen Aufruf senden, mit altem
  und neuem Status und dem abgeleiteten Anlass.
- Nachvollziehbar: Protokoll aller Versände mit Ergebnis und „Erneut senden“.

## Nicht-Ziele

- Andere Auslöser als den Statuswechsel (neuer Kommentar, Zuweisung,
  Fälligkeit). Das Datenmodell bekommt ein Feld `trigger`, damit sie später
  dazukommen können; gebaut wird nur `status`.
- Echtzeit. Bis zu 5 Minuten Verzögerung sind ausdrücklich in Ordnung.
- Sicher feststellen, *wer* den Status geändert hat. TANSS liefert das nicht;
  ein abgeleiteter Anlass reicht.
- Einschränkungen der Ziel-URL (keine Sperre interner Adressen, keine
  Allowlist). Ausdrücklich so gewünscht – n8n o. Ä. läuft oft im LAN.
- Webhooks in TANSS anlegen oder TANSS-Daten verändern.
- Anzeige in der Ticketliste (Symbol an Zeilen mit Webhook). Nicht verlangt.

## Anti-Ziele (wäre ein Fehlschlag, selbst wenn es technisch läuft)

- Ein Techniker sieht oder benutzt Webhooks eines anderen.
- Im Ticket taucht Webhook-Oberfläche auf, obwohl der Techniker keinen Webhook
  angelegt hat.
- Ein Webhook feuert beim Anhängen oder beim ersten Abruf, obwohl sich nichts
  geändert hat.
- Derselbe Wechsel wird durch die Portal-Logik mehrfach gesendet (z. B. nach
  Neustart des Servers). Einzige Ausnahme siehe „Zustellung“ unten.
- Der abgeleitete Anlass wird als sichere Tatsache dargestellt.

## Rahmenbedingungen aus dem Bestand

- Fastify-Server, React-Client, Tests mit vitest; Daten als JSON-Dateien unter
  `data/`, Zugriff über `server/store.ts`, alles pro `employeeId` getrennt (so
  wie gespeicherte Listen, Routinen, Import-Regeln).
- Es gibt genau eine TANSS-Sitzung für den ganzen Server
  (`server/shared-session.ts`); jeder TANSS-Aufruf im Hintergrund läuft über
  `shared.run(...)`. Ohne gültige Sitzung kann nichts geprüft werden – dann
  wird eben nicht gesendet, und der Zustand wird beim nächsten erfolgreichen
  Abruf nachgeholt.
- Der Hintergrund-Abruf (`server/poller.ts`) läuft alle 5 Minuten
  (`SAMPLE_INTERVAL_MINUTES`) und darf nie nach TANSS schreiben.
- `TanssClient.ticketById` liefert den aktuellen Status (`statusId`),
  `ticketHistory` liefert Kommentare, Zeitbuchungen (supports) und Mails.
- Oberfläche folgt dem Redesign (`src/ui/kit.tsx`, eigene CSS-Datei je Ansicht,
  Klassennamen dürfen nicht global kollidieren). Texte auf Deutsch, Du-Form.
- Der gespeicherte Schlüssel des LLM wird in der Oberfläche maskiert und nie
  zurückgegeben; dasselbe Muster gilt für das Webhook-Geheimnis.

## Was entschieden ist

### Webhooks in den Einstellungen (vom Nutzer entschieden)

- Neuer Reiter **„Webhooks“** in den Einstellungen.
- Jeder Techniker sieht und verwaltet nur seine eigenen Webhooks.
- Ein Webhook hat:
  - **Name** (Pflicht)
  - **Ziel-URL** (Pflicht, `http` oder `https`, sonst keine Einschränkung)
  - **Auslöser**: vorerst fest „Statuswechsel“
  - **Zielstatus-Filter** (optional, Mehrfachauswahl aus den TANSS-Status):
    leer = jeder Wechsel löst aus; sonst nur Wechsel *auf* einen dieser Status
  - **Inhaltsvorlage** mit Platzhaltern (siehe unten), mit sinnvoller
    Standardvorlage vorbelegt
  - **Geheimnis** für die Signatur (optional; leer = keine Signatur)
  - **aktiv/inaktiv**-Schalter
- **Test-Button**: sendet einen Beispielaufruf mit erfundenen Ticketdaten
  (als Test gekennzeichnet) und zeigt Antwortcode bzw. Fehler direkt an.
- **Protokoll** unter der Liste: Zeit, Webhook, Ticket, alter → neuer Status,
  Ergebnis (HTTP-Code oder Fehler), Button „Erneut senden“.

### Im Ticket (vom Nutzer entschieden)

- In der Eigenschaften-Spalte des Ticket-Drawers (`td-side`) ein Abschnitt
  **„Webhooks“** – **nur sichtbar, wenn der Techniker mindestens einen Webhook
  angelegt hat.** Sonst nichts, auch kein Platzhalter.
- Dort: angehängte Webhooks mit Lösen-Button, eine Auswahl zum Anhängen, ein
  Häkchen **„einmalig“** (löst den Webhook vom Ticket, sobald der erste
  Aufruf angestoßen ist).
- Beim Anhängen merkt sich der Server den aktuellen Status des Tickets als
  Ausgangsstand, damit nichts sofort feuert.

### Erkennen des Wechsels (vom Nutzer entschieden)

- Das Portal läuft lokal auf dem Rechner des Technikers; angemeldet ist immer
  genau einer. Webhooks gehören diesem Techniker (`employeeId`), werden mit
  seiner Sitzung geprüft und ausgeführt und nie geteilt. Geprüft werden nur
  die Webhooks des Technikers, dem die aktuelle Sitzung gehört; passt das
  nicht (Sitzung fehlt oder gehört jemand anderem), ruht die Prüfung und holt
  beim nächsten passenden Abruf nach.
- Alle 5 Minuten lädt der Server jedes Ticket, an dem ein aktiver Webhook
  hängt, einmal und vergleicht `statusId` mit dem gespeicherten letzten Stand.
- Bei Abweichung: Anlass ableiten, für jeden passenden Webhook (Filter!)
  senden, neuen Stand speichern.
- Zwei Wechsel innerhalb eines Intervalls erscheinen als einer (A → C). Das
  ist akzeptiert.

### Abgeleiteter Anlass („wodurch kam der Wechsel“, vom Nutzer entschieden)

Aus `ticketHistory` die Einträge (Mail, Kommentar, Zeitbuchung) zwischen der
vorigen Prüfung und jetzt; der jüngste davon ist der vermutete Anlass. Im
Aufruf steht er ausdrücklich als abgeleitet:

```json
"cause": {
  "derived": true,
  "kind": "mail" | "comment" | "support" | "unknown",
  "by": "Name des Absenders/Technikers",
  "at": "2026-10-20T10:42:00+02:00",
  "summary": "Mail von Max Mustermann um 10:42"
}
```

Gibt es keinen Eintrag im Fenster: `kind: "unknown"`, Zusammenfassung „Kein
Anlass im Verlauf gefunden“.

### Versand (Verbesserungen, vom Nutzer übernommen)

- `POST`, `Content-Type: application/json`, Rumpf = gefüllte Vorlage.
- Jeder Aufruf trägt `X-Portal-Delivery: <eindeutige ID>` (bleibt bei
  Wiederholungen gleich) und `X-Portal-Timestamp: <Unix-Sekunden>`.
- Mit Geheimnis zusätzlich `X-Portal-Signature: sha256=<hex HMAC-SHA256 über
  "<timestamp>.<rumpf>">`. Der Zeitstempel ist mitsigniert, damit Empfänger
  Wiederholungsangriffe abweisen können. Das Format wird im README für
  Empfänger (n8n) beschrieben und danach nicht mehr geändert.
- Platzhalter in der Vorlage (Werte JSON-sicher eingesetzt):
  `{{ticket.id}}`, `{{ticket.title}}`, `{{ticket.url}}` (Link in TANSS über
  das vorhandene `TANSS_TICKET_URL`/`config.tanssTicketUrl`; leer, wenn nicht
  gesetzt – das Portal hat keine Deep-Links und keine öffentliche Adresse),
  `{{customer}}`, `{{status.old}}`, `{{status.new}}`, `{{cause.summary}}`,
  `{{cause.kind}}`, `{{cause.by}}`, `{{cause.at}}`, `{{changedAt}}`,
  `{{technician}}`, `{{webhook.name}}`. Zusätzlich `{{json}}` für das
  vollständige Standardobjekt.
- Standardvorlage = das vollständige Objekt (`ticket`, `status`, `cause`,
  `changedAt`, `technician`, `webhook`, `test`).

## Meine Entscheidungen (zur Prüfung durch Sören)

- **Mehrere Webhooks pro Ticket** sind erlaubt; derselbe Webhook kann an
  beliebig vielen Tickets hängen.
- **Wiederholung:** Zeitlimit 10 s pro Aufruf; als Erfolg zählt jeder 2xx-Code.
  Bei Fehler zwei automatische Wiederholungen (nach etwa 30 s und 2 min), danach
  bleibt der Eintrag als fehlgeschlagen im Protokoll. „Einmalig“ löst die
  Verknüpfung, sobald der erste Aufruf in die Warteschlange kommt (so entsteht
  kein zweiter); ein fehlgeschlagener bleibt im Protokoll und lässt sich erneut
  senden.
- **Protokoll** hält die letzten 200 Einträge pro Techniker.
- **Inaktiver Webhook** bleibt an seinen Tickets hängen, wird aber nicht geprüft
  und sendet nicht; beim Reaktivieren gilt der Punkt „Reaktivieren“ unten.
- **Webhook gelöscht** → wird von allen Tickets gelöst.
- **Ticket nicht mehr abrufbar** (404) → Verknüpfung wird entfernt, Eintrag im
  Protokoll.
- **Anlass ohne Inhalte:** Es gehen Art, Name und Zeit mit, keine Mail- oder
  Kommentartexte. Hält sensible Inhalte aus Fremdsystemen heraus.
- **Zustellung „mindestens einmal“:** Erkannter Wechsel → Eintrag in eine
  Warteschlange in der Datei → erst dann neuer Stand gespeichert. Ein Neustart
  verliert also nichts. Ist der Ausgang eines Aufrufs unklar (Absturz während
  des Sendens, Zeitlimit obwohl der Empfänger verarbeitet hat), wird erneut
  gesendet – mit derselben `X-Portal-Delivery`-ID, an der der Empfänger
  Doppelte erkennen kann. Lieber ein Duplikat mit ID als eine verlorene
  Meldung.
- **Platzhalter-Werte** werden JSON-escaped eingesetzt, `{{json}}` roh; die
  gefüllte Vorlage muss gültiges JSON sein, sonst wird beim Speichern bzw.
  Test ein Fehler gezeigt.
- **Reaktivieren** eines Webhooks liest den aktuellen Status seiner Tickets
  neu als Ausgangsstand ein, damit nichts Altes nachfeuert. Lässt sich ein
  Ticket dabei nicht lesen, wird die Verknüpfung markiert; die nächste Prüfung,
  die das Ticket lesen kann, übernimmt dann still den aktuellen Status.

## Dem Bauenden überlassen

- Ob die Prüfung im bestehenden `poller.tick` mitläuft oder eine eigene
  Schleife mit gleichem Takt bekommt (Hauptsache über `shared.run`, Login-Sperre
  respektieren).
- Dateiaufteilung im Store (`webhooks.json`, `webhook-links.json`,
  `webhook-log.json` o. Ä.), Form der API-Routen, Aufbau der Komponenten.
- Ob TANSS beim Statuswechsel selbst einen Systemkommentar schreibt und dieser
  für den Anlass genutzt werden kann – prüfen und ggf. nutzen.
- Gestaltung des Reiters und des Drawer-Abschnitts im Rahmen des Redesigns.
- README/CHANGELOG-Einträge.

## Fertig ist es, wenn

- Webhook anlegen → im Ticket anhängen → Status in TANSS (bzw. im Mock) ändern
  → innerhalb eines Intervalls kommt genau ein Aufruf mit richtigem altem/neuem
  Status und abgeleitetem Anlass an; Signatur prüfbar.
- Ohne angelegten Webhook ist im Ticket nichts davon zu sehen.
- Ein zweiter Techniker sieht die Webhooks des ersten nicht und kann sie
  weder über Oberfläche noch API benutzen.
- Neustart des Servers zwischen Wechsel und Versand führt zu genau einem
  Aufruf.
- Tests für Vergleich, Filter, Anlass-Ableitung, Vorlagen-Füllung, Signatur,
  Wiederholung, „einmalig“ und Rechte; UI mit Mock geprüft (nie mit echtem
  TANSS-Konto).
