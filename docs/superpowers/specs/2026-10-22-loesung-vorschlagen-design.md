# Lösung vorschlagen — Design

## Ziel

Im geöffneten Ticket beantwortet der Agent die Frage „Wie haben wir das
letztes Mal gelöst?“. Er sucht unter den **erledigten Tickets desselben
Kunden** die, die dasselbe Problem beschreiben, liest deren Verlauf und
schreibt daraus einen Lösungsvorschlag mit Links zu den Quell-Tickets. Wissen
aus alten Fällen wird nutzbar, ohne dass jemand in TANSS danach graben muss.

## Was TANSS kann (am 21./22.10.2026 gegen eine echte Instanz geprüft, nur lesend)

- `PUT /api/v1/search` findet **nur offene Tickets** und nur über den
  **Titelanfang** (oder die Ticketnummer). Ein Wort aus der Titelmitte, ein
  Wortanfang, `*`-Platzhalter, der Beschreibungsanfang und der Titelanfang
  erledigter Tickets lieferten jeweils 0 Treffer. Für diese Funktion ist die
  Suche unbrauchbar.
- `PUT /api/v1/tickets` (eigene Ticketliste) liefert mit
  `includeDoneTickets: true` auch erledigte Tickets, filterbar u. a. nach
  `companies`, `modifiedWithinTimeframe {from,to}` (Unix-Sekunden), mit
  `itemsPerPage`/`page`. `content` der Antwort ist ein Array von
  Ticket-Objekten (Felder u. a. `id`, `companyId`, `title`, `content`,
  `internalContent`, `statusId`, `typeId`, `modifiedTime`,
  `lastStateChangeDate`). Einen Textfilter gibt es nicht.
- Ein Ticket trägt kein Feld „erledigt“, die Status (`admin/ticketStates`)
  auch nicht. Im Test lieferte dieselbe Liste ohne `includeDoneTickets` nur
  die offenen; die Differenz sind die erledigten.
- Für einen Kunden kamen in 12 Monaten über 100 Tickets (erste Seite voll).

## Entscheidungen von Sören

- **Nur derselbe Kunde** (Weg 1). Kundenübergreifend erst, wenn Treffer
  fehlen — das würde Listen aller Kunden holen, was er nicht will.
- **Kein Dauerspeicher** für Tickets oder Inhalte: nichts davon landet in
  `data/` oder sonst auf der Platte.
- **Zwischenspeicher im Arbeitsspeicher ist in Ordnung.**
- **Gezielt statt alles:** Nur die Kandidaten, die wirklich zum Problem
  passen, werden vollständig gelesen.
- Wie überall im Portal schreibt der Agent **nichts nach TANSS**.

## Ablauf

1. Knopf **„Lösung vorschlagen“** in der Karte „Einschätzung des Agenten“
   (`src/views/TicketAgentActions.tsx`), neben „Ähnliche Tickets“. Nur aktiv,
   wenn die KI eingerichtet ist (wie die anderen Knöpfe).
2. Neue Route `POST /me/agent/solution` mit `{ ticketId }`:
   1. Ticket laden (`loadTicket`). Ohne Kunde (`companyId` 0) → Antwort
      „Ticket hat keinen Kunden“, kein weiterer Aufruf.
   2. **Liste des Kunden holen:** `PUT /api/v1/tickets` mit
      `companies: [companyId]`, `includeDoneTickets: true`,
      `modifiedWithinTimeframe` = letzte 12 Monate, Seiten à 100, höchstens
      5 Seiten (500 Tickets). Dazu dieselbe Liste ohne `includeDoneTickets`;
      erledigt = in der ersten, nicht in der zweiten. Das aktuelle Ticket
      fällt raus.
   3. **Vorauswahl im Portal**, ohne KI: Wörter aus Titel und Beschreibung des
      aktuellen Tickets (ohne HTML, Stoppwörter, kurze Tokens) gegen Titel,
      Beschreibung und interne Notiz der erledigten Tickets. Die besten 30
      nach Übereinstimmung gehen weiter; Tickets ohne jede Übereinstimmung
      nicht. Bleibt nichts übrig → Antwort „nichts Vergleichbares“, kein
      KI-Aufruf.
   4. **Auswahl durch die KI:** ein Aufruf mit dem aktuellen Ticket und den
      bis zu 30 Kandidaten (Nummer, Titel, Anfang der Beschreibung). Die KI
      nennt bis zu 5, die dasselbe Problem beschreiben, mit kurzer
      Begründung — oder eine leere Liste. Nur Nummern aus der Kandidatenliste
      zählen (wie `parseSimilar`).
   5. **Verläufe lesen:** die gewählten Tickets mit `loadTicket` laden
      (Verlauf inkl. Kommentare, Mails, Leistungen); das Budget aus
      `threadBudget` teilen sie sich, das Ende des Verlaufs (Abschluss,
      letzte Leistungen) hat Vorrang.
   6. **Vorschlag durch die KI:** ein Aufruf mit aktuellem Ticket und den
      gelesenen Verläufen. Ergebnis: was damals die Ursache war und was
      gemacht wurde (je Quell-Ticket), ein Vorschlag für den ersten Schritt
      jetzt. Der Prompt verlangt, nur zu sagen, was in den Verläufen steht,
      und offen zu sagen, wenn dort keine Lösung erkennbar ist.
3. Antwort an die Oberfläche: Vorschlagstext, Quell-Tickets (Nummer, Titel,
   Datum, Begründung der Auswahl), Zahlen „N erledigte Tickets geprüft,
   M gelesen“.

## Anzeige

Ein Insight „Lösungsvorschlag“ in der Agenten-Karte, wie die bestehenden:
Text, darunter die Quell-Tickets als anklickbare Nummern (öffnen das Ticket
im Portal, wie bei „Ähnliche Tickets“). Ein Knopf **„Ins Notizfeld“** legt
den Text in das Kommentarfeld des Drawers, wie die Entwürfe von
`DraftButton`; gespeichert wird erst, wenn die Person speichert. Ein Knopf
**„Kopieren“**. Während der Arbeit „sucht …“ wie bei den anderen Knöpfen.

## Zwischenspeicher (nur Arbeitsspeicher)

Die geholte Kundenliste (Schritt 2.2) bleibt **10 Minuten** im Speicher,
Schlüssel Mitarbeiter + Kunde, damit ein zweiter Klick (oder ein anderes
Ticket desselben Kunden) nicht neu lädt. Höchstens 20 Einträge, ältester
fliegt raus. Kein Schreiben auf die Platte, weg beim Neustart. Gelesene
Verläufe und KI-Antworten werden nicht zwischengespeichert.

## Grenzen und Fehler

- Höchstens 5 Seiten Liste, 30 Kandidaten an die KI, 5 gelesene Tickets,
  2 KI-Aufrufe pro Klick.
- TANSS-Fehler beim Holen der Liste → klare Meldung („Erledigte Tickets
  konnten nicht geladen werden“), kein halber Vorschlag. Darf das Konto
  `includeDoneTickets` nicht, steht das so da.
- Ein einzelnes Quell-Ticket, das sich nicht laden lässt, wird ausgelassen;
  bleibt keins übrig → „nichts lesbar“.
- Mehr als 500 Tickets in 12 Monaten → es zählen die zuletzt geänderten;
  die Anzeige sagt, dass nicht alle geprüft wurden.

## Nicht-Ziele

- Kundenübergreifende Suche (später, falls Treffer fehlen).
- Dauerhafte Ablage von Tickets, Index oder Vorschlägen.
- Automatisches Schreiben nach TANSS.
- ⌘K und „Ähnliche Tickets“ an die echte TANSS-Suche anpassen (siehe unten).

## Nebenbefund für später

`⌘K` und „Ähnliche Tickets“ schicken einzelne Titelwörter an die TANSS-Suche
(`searchTerms` in `shared/agent.ts`). Da TANSS nur Titelanfänge offener
Tickets findet, liefert das praktisch nie etwas; „Ähnliche Tickets“ prüft
faktisch nur die geladenen Board-Zeilen, und `targets.ts` behauptet im
Kommentar das Gegenteil („TANSS searches ticket titles“). Eigenes Thema, nicht
Teil dieser Arbeit.

## Eigene Festlegungen (nicht von Sören, von ihm prüfbar)

- 12 Monate Zeitraum, höchstens 5 Seiten, 30 Kandidaten, 5 gelesene Tickets,
  10 Minuten Zwischenspeicher.
- Knopf in der Agenten-Karte, „Ins Notizfeld“ und „Kopieren“.
- **Sortierung:** Das Portal sortiert die geholte Liste selbst nach
  `modifiedTime` (neueste zuerst) und verlässt sich nicht auf die
  Reihenfolge von TANSS. Ist die 5. Seite voll, sagt die Anzeige „nicht alle
  geprüft“.
- **Offen gegen erledigt:** Die Liste ohne `includeDoneTickets` wird mit
  derselben Zeitspanne und bis zu 10 Seiten geholt (offene sind deutlich
  weniger). Rutscht dabei doch ein offenes Ticket als „erledigt“ durch, ist
  das harmlos: Der Verlauf zeigt der KI, dass es noch läuft, und der Prompt
  sagt, dass dann keine Lösung daraus abzuleiten ist.
- **Keine erledigten gefunden:** Sind beide Listen gleich, heißt die Meldung
  „Keine erledigten Tickets dieses Kunden in den letzten 12 Monaten — oder
  dein TANSS-Konto darf sie nicht sehen.“ Eine eigene Fehlermeldung nur, wenn
  TANSS mit einem Fehlerstatus antwortet.
- **Interne Notiz der Quell-Tickets:** `internalContent` geht beim Lesen mit
  in den Verlauf (dort steht oft die Lösung); `buildThread` lässt sie heute
  aus.

## Seitenzählung (am 22.10.2026 geprüft, nur lesend)

`page` beginnt bei **1**; `page: 0` liefert dasselbe wie `page: 1`.
`itemsPerPage` wird eingehalten, die Liste kommt nach `modifiedTime`
absteigend, Seiten überlappen nicht. `meta.properties.extras.count` ist nur
die Größe der Seite, keine Gesamtzahl. Das eigene Sortieren bleibt trotzdem
drin (kostet nichts, hängt nicht an TANSS-Verhalten).

## Dem Builder überlassen

- Stoppwörter und Bewertung der Vorauswahl (z. B. Titeltreffer höher als
  Beschreibungstreffer), solange Tickets ohne Übereinstimmung rausfallen.
- Prompt-Wortlaut im Stil der bestehenden Prompts in `shared/agent.ts`.
- Aufteilung des Verlaufsbudgets auf die gelesenen Tickets.
- Tests nur mit gemocktem TANSS und gemocktem Modell — kein echtes
  TANSS-Konto.
