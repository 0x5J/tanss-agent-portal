# Lösung vorschlagen + Sammel-Zuweisung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Im Ticket schlägt der Agent aus erledigten Tickets desselben Kunden eine Lösung vor; in der Ticketliste lassen sich mehrere Tickets einem anderen Techniker zuweisen.

**Architecture:** Neuer TANSS-Aufruf `PUT /api/v1/tickets` (eigene Liste mit `includeDoneTickets`). Ein Modul im Server holt und unterscheidet die erledigten Tickets eines Kunden und hält sie 10 Minuten im Arbeitsspeicher. Reine Logik (Vorauswahl, Prompts) liegt in `shared/solution.ts`. Die Route `POST /me/agent/solution` sitzt bei den anderen Agenten-Routen. Die Oberfläche bekommt einen Knopf in der Agenten-Karte und einen „Zuweisen an …“-Picker in der Auswahlleiste.

**Tech Stack:** TypeScript, Fastify 5, React 19, Vitest, zod.

**Spec:** `docs/superpowers/specs/2026-10-22-loesung-vorschlagen-design.md` (Sammel-Zuweisung: im Chat abgestimmt, Task 5 enthält alles dazu).

## Global Constraints

- Der Agent schreibt nichts nach TANSS; „Ins Notizfeld“ füllt nur das Textfeld.
- Nichts aus Tickets landet auf der Platte (kein Store, kein `data/`); nur Arbeitsspeicher.
- Tests nur mit gemocktem TANSS und gemocktem Modell — nie ein echtes TANSS-Konto.
- Oberflächen-Texte Deutsch, Code-Kommentare Englisch, Stil wie im umgebenden Code.
- Keine internen Firmennamen/URLs in Code, Tests, Doku (öffentliches Repo).
- TANSS-Liste (am 22.10.2026 gegen echte Instanz geprüft): `page` beginnt bei **1** (0 liefert dasselbe wie 1), `itemsPerPage` wird eingehalten, Sortierung `modifiedTime` absteigend, `meta.properties.extras.count` ist nur die Seitengröße (keine Gesamtzahl).
- Grenzen: 365 Tage, Seiten à 100, höchstens 5 Seiten mit erledigten, 10 Seiten ohne; 30 Kandidaten an die KI; 5 gelesene Tickets; Cache 10 Minuten, höchstens 20 Einträge.

## Review Focus

- Ticket ohne Kunde (`companyId` 0) → Hinweis „Ticket hat keinen Kunden“, kein TANSS-Listenaufruf, kein KI-Aufruf.
- Beide Listen gleich (keine erledigten oder kein Recht) → Hinweis aus der Spec, kein KI-Aufruf.
- KI nennt Ticketnummern, die nicht Kandidaten waren, oder das aktuelle Ticket → werden ignoriert.
- Ein gewähltes Quell-Ticket lässt sich nicht laden → wird ausgelassen; alle scheitern → „nichts lesbar“, kein zweiter KI-Aufruf.
- Shift+A darf nicht zusätzlich „Mir zuweisen“ auslösen (der Key-Handler senkt `event.key` heute auf Kleinbuchstaben).

---

### Task 1: TANSS-Aufruf für die eigene Ticketliste

**Files:**
- Modify: `server/tanss.ts` (Typ `TanssClient`, Implementierung in `createTanssClient`)
- Modify: `server/agent.test.ts`, `server/app.test.ts` (die beiden vollständigen Fakes um die neue Methode ergänzen)
- Test: `server/tanss-list.test.ts` (neu)

**Interfaces:**
- Produces:
  ```ts
  export type CustomTicketFilter = {
    companies?: number[];
    includeDoneTickets?: boolean;
    /** Unix seconds. */
    modifiedWithinTimeframe?: { from: number; to: number };
    itemsPerPage: number;
    /** TANSS counts from 1. */
    page: number;
  };
  customTicketList(session: TanssSession, filter: CustomTicketFilter): Promise<{ items: Obj[]; linked: LinkedEntities }>;
  ```

- [ ] **Step 1: Failing test** in `server/tanss-list.test.ts`, Muster wie `server/login.test.ts` (`createTanssClient` mit eigenem `fetch`): `"sends the filter as PUT /api/v1/tickets and returns items and linked entities"` — der Fake-`fetch` merkt sich URL, Methode, Header `apiToken` und Body; antwortet `{ meta: { linkedEntities: { companies: { "5": { name: "Kunde" } } } }, content: [{ id: 1, title: "A" }] }`. Erwartet: URL `http://tanss.test/api/v1/tickets`, Methode `PUT`, Body exakt der übergebene Filter, Ergebnis `{ items: [{ id: 1, title: "A" }], linked: { companies: { "5": { name: "Kunde" } } } }`. Zweiter Test `"reads a non-array content as an empty list"` (`content: null` → `items: []`).
- [ ] **Step 2:** `npx vitest run server/tanss-list.test.ts` → FAIL (`customTicketList is not a function`).
- [ ] **Step 3:** `customTicketList` in `createTanssClient` über `authed(session, "PUT", "/api/v1/tickets", filter)`, Rückgabe wie `ticketList` (`asArray(envelope.content)`, `envelope.meta?.linkedEntities ?? {}`). Typ + Doc-Kommentar im `TanssClient` (wofür, dass `page` bei 1 beginnt). In beiden Fakes: `customTicketList: record("customTicketList", { items: [], linked: {} })`.
- [ ] **Step 4:** `npx vitest run server/tanss-list.test.ts` → PASS; `npm run typecheck` → ohne Fehler.
- [ ] **Step 5: Commit** `TANSS: eigene Ticketliste (PUT /api/v1/tickets)`.

### Task 2: Vorauswahl und Prompts (`shared/solution.ts`)

**Files:**
- Create: `shared/solution.ts`
- Test: `shared/solution.test.ts`

**Interfaces:**
- Consumes: `TicketRow` (`shared/tickets.ts`), `SimilarHit`/`parseSimilar` (`shared/agent.ts`).
- Produces:
  ```ts
  export const SOLUTION_LOOKBACK_DAYS = 365;
  export const SOLUTION_MAX_CANDIDATES = 30;
  export const SOLUTION_MAX_READ = 5;
  export type SolutionCandidate = { id: number; title: string; excerpt: string; modified: number; score: number };
  export type SolutionSource = { ticketId: number; title: string; modified: number; reason: string };
  export type SolutionAnswer = {
    verdict: "ok" | "no-company" | "no-done" | "no-match" | "unreadable";
    text: string;
    sources: SolutionSource[];
    /** Done tickets looked at by the pre-selection. */
    checked: number;
    /** Source tickets actually read. */
    read: number;
    /** More done tickets existed than were fetched. */
    truncated: boolean;
  };
  export function problemWords(text: string): string[];
  export function rankCandidates(subject: { title: string; description: string }, tickets: Record<string, unknown>[], limit?: number): SolutionCandidate[];
  export function solutionPickPrompt(subject: TicketRow, description: string, candidates: SolutionCandidate[]): string;
  export function parseSolutionPick(value: unknown, known: Set<number>): SimilarHit[];
  export function solutionPrompt(subjectContext: string, sources: { ticketId: number; context: string; internalNote: string }[]): string;
  export const SOLUTION_MESSAGES: Record<Exclude<SolutionAnswer["verdict"], "ok">, string>;
  ```

- [ ] **Step 1: Failing tests** in `shared/solution.test.ts`:
  - `problemWords`: `"<p>Drucker im Büro druckt nicht mehr</p>"` → `["drucker", "büro", "druckt"]` (HTML weg, klein, Wörter < 4 Zeichen und Stoppwörter aus `searchTerms` weg, eindeutig, Reihenfolge des ersten Vorkommens).
  - `rankCandidates`: Subjekt `{ title: "Backup Fehler auf DC01", description: "Veeam Job bricht ab" }`, Tickets: `{id:1,title:"Backup Fehler DC02",content:"",modifiedTime:100}`, `{id:2,title:"Drucker",content:"Veeam Lizenz",modifiedTime:300}`, `{id:3,title:"Urlaub",content:"",modifiedTime:500}`, `{id:4,title:"Backup",content:"",internalContent:"Veeam neu gestartet",modifiedTime:200}` → IDs `[1, 4, 2]` (Titeltreffer zählen 3, Treffer in `content`/`internalContent` 1; ohne Treffer raus; Gleichstand → neueres `modifiedTime` zuerst). `excerpt` = Beschreibung ohne HTML, höchstens 200 Zeichen. `limit` 2 → `[1, 4]`.
  - `parseSolutionPick`: `{ similar: [{ticketId:1,reason:"a"},{ticketId:9,reason:"b"},{ticketId:1,reason:"c"}, …7 bekannte] }` → nur bekannte, ohne Doppelte, höchstens `SOLUTION_MAX_READ` (5).
  - `solutionPickPrompt` enthält `#<id>` jedes Kandidaten und verlangt JSON `{"similar":[...]}` mit höchstens 5 Einträgen; `solutionPrompt` enthält jeden Quell-Kontext, die interne Notiz unter „Interne Notiz am Ticket“, und die Anweisung, nur zu sagen, was in den Verläufen steht.
- [ ] **Step 2:** `npx vitest run shared/solution.test.ts` → FAIL (Modul fehlt).
- [ ] **Step 3:** Implementieren. Stoppwortliste aus `searchTerms` in `shared/agent.ts` als exportierte Konstante herausziehen und in beiden nutzen (nicht duplizieren). `parseSolutionPick` = `parseSimilar(...).slice(0, SOLUTION_MAX_READ)`. Prompts im Stil von `similarPrompt`/`nextStepPrompt`. Der Vorschlags-Prompt fragt je Quell-Ticket nach Ursache und Maßnahme und nach einem ersten Schritt jetzt; Klartext, keine JSON-Antwort; wenn kein Verlauf eine Lösung zeigt, das so sagen. `SOLUTION_MESSAGES`:
  - `no-company`: „Ticket hat keinen Kunden — es gibt nichts zu vergleichen.“
  - `no-done`: „Keine erledigten Tickets dieses Kunden in den letzten 12 Monaten — oder dein TANSS-Konto darf sie nicht sehen.“
  - `no-match`: „Unter den erledigten Tickets dieses Kunden beschreibt keins ein ähnliches Problem.“
  - `unreadable`: „Die passenden Tickets ließen sich nicht lesen.“
- [ ] **Step 4:** `npx vitest run shared/` → PASS (auch die bestehenden `shared/agent.test.ts`).
- [ ] **Step 5: Commit** `Lösung vorschlagen: Vorauswahl und Prompts`.

### Task 3: Erledigte Tickets eines Kunden holen und im Arbeitsspeicher halten

**Files:**
- Create: `server/done-tickets.ts`
- Test: `server/done-tickets.test.ts`

**Interfaces:**
- Consumes: `customTicketList` (Task 1), `SOLUTION_LOOKBACK_DAYS` (Task 2).
- Produces:
  ```ts
  export type DoneTickets = { done: Obj[]; linked: LinkedEntities; truncated: boolean };
  export function createDoneTickets(opts: { tanss: TanssClient; now: () => number; ttlMs?: number; maxEntries?: number }): {
    /** Done tickets of one customer, newest first; cached per employee + company. */
    get(session: TanssSession, companyId: number): Promise<DoneTickets>;
  };
  ```

- [ ] **Step 1: Failing tests** mit einem Fake, der `customTicketList` nach `includeDoneTickets` und `page` beantwortet:
  - `"pages through done and open lists from page 1 and keeps only done tickets"`: mit Schalter Seite 1 = 100 Tickets (IDs 1–100), Seite 2 = 3 Tickets; ohne Schalter Seite 1 = IDs 1–10. Erwartet: `done` = IDs 11–103, Aufrufe mit `page` 1 und 2 (nie 0), `itemsPerPage` 100, `companies: [companyId]`, `modifiedWithinTimeframe.to` = jetzt in Unix-Sekunden, `from` = jetzt − 365 Tage; `truncated: false`.
  - `"stops after five pages and says so"`: Liste mit Schalter liefert jede Seite voll → genau 5 Aufrufe mit Schalter, `truncated: true`.
  - `"sorts by modifiedTime, newest first"`: unsortierte Antwort → `done` absteigend nach `modifiedTime`.
  - `"serves a second call within ten minutes from memory"`: zweiter `get` gleicher Mitarbeiter + Kunde → keine neuen Aufrufe; nach `now` + 10 min + 1 ms → neue Aufrufe; anderer `session.employeeId` → neue Aufrufe.
  - `"keeps at most 20 entries"`: 21 Kunden → der älteste fliegt raus (erneuter `get` ruft wieder TANSS).
  - `"does not cache a failure"`: erster Aufruf wirft `TanssError` → Fehler kommt durch; zweiter Aufruf fragt erneut.
- [ ] **Step 2:** `npx vitest run server/done-tickets.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren. Liste ohne Schalter mit bis zu 10 Seiten, mit Schalter bis zu 5; Seite für Seite, Abbruch, sobald eine Seite weniger als 100 bringt. `linked` beider Listen zusammenführen. `Map` mit Einfügereihenfolge als LRU-light (ältester Schlüssel raus bei > 20). Nichts auf die Platte.
- [ ] **Step 4:** `npx vitest run server/done-tickets.test.ts` → PASS.
- [ ] **Step 5: Commit** `Lösung vorschlagen: erledigte Tickets je Kunde, 10 Minuten im Speicher`.

### Task 4: Route `POST /me/agent/solution` und Knopf im Ticket

**Files:**
- Modify: `server/agent.ts` (neue Route nach `/me/agent/similar`, `createDoneTickets` einmal pro App)
- Modify: `server/agent.test.ts`
- Modify: `src/api.ts` (`api.agent.solution(ticketId)` → `SolutionAnswer`)
- Modify: `src/views/TicketAgentActions.tsx` (Knopf, Insight)
- Modify: `src/views/TicketDrawer.tsx` (neue Prop `onDraft` an `TicketAgentActions`: setzt Text und schaltet auf interne Notiz)
- Modify: `README.md` (Zeile in der KI-Tabelle), `CHANGELOG.md` (`[Unveröffentlicht]` → `### Hinzugefügt`)

**Interfaces:**
- Consumes: Task 1–3.
- Produces: `POST /me/agent/solution` mit `{ ticketId: number }` → `SolutionAnswer`.

- [ ] **Step 1: Failing tests** in `server/agent.test.ts` (neuer `describe("solution")`, `setup` mit Fake-`customTicketList` und einem LLM, das je Prompt antwortet):
  - `"suggests a solution from done tickets of the same customer"`: Ticket 1 (`companyId` 5, „Backup DC01“); mit Schalter liefert die Liste Ticket 1, 20 („Backup DC01 Fehler“, erledigt), 21 („Drucker“, erledigt), 30 (offen); ohne Schalter 1 und 30. LLM: Pick-Prompt → `{"similar":[{"ticketId":20,"reason":"gleicher Job"},{"ticketId":1,"reason":"selbst"},{"ticketId":30,"reason":"offen"}]}`, Vorschlags-Prompt → `"Damals: Speicher voll."`. Erwartet: `verdict "ok"`, `text "Damals: Speicher voll."`, `sources` = nur `[{ ticketId: 20, title: "Backup DC01 Fehler", reason: "gleicher Job", modified: … }]`, `read: 1`, `checked: 2`; `ticketById`/`ticketHistory` für 20 geladen, nicht für 21/30; die Liste wurde mit `companies: [5]` geholt.
  - `"says so when the ticket has no customer"` → `verdict "no-company"`, kein `customTicketList`, kein LLM-Aufruf.
  - `"says so when there are no done tickets"` (beide Listen gleich) → `"no-done"`, kein LLM-Aufruf.
  - `"says so when nothing matches"` (erledigte ohne gemeinsames Wort) → `"no-match"`, kein LLM-Aufruf; KI wählt leere Liste → ebenfalls `"no-match"`, nur ein LLM-Aufruf.
  - `"skips a source that cannot be read"`: `ticketById` wirft für 20 → bei nur dieser Quelle `"unreadable"`, kein zweiter LLM-Aufruf.
  - `"puts the internal note of a source into the prompt"`: Ticket 20 hat `internalContent: "Aufbewahrung auf 14 Tage"` → steht im Vorschlags-Prompt.
  - `"answers 502-like errors from TANSS as an error"`: `customTicketList` wirft `TanssError("kaputt", 502)` → HTTP 502, `{ error: "Erledigte Tickets konnten nicht geladen werden: kaputt" }`.
- [ ] **Step 2:** `npx vitest run server/agent.test.ts -t solution` → FAIL (404).
- [ ] **Step 3:** Route bauen: `withSession`, `configured()`, `loadTicket` für das Subjekt; Ablauf und Grenzen wie in der Spec, Abschnitt „Ablauf“. Kandidaten ohne das Subjekt. Quellen mit `loadTicket(session, id, 1 / gewählte Anzahl)` laden (`Promise.allSettled`), `internalContent` aus `ticketById` als `internalNote` mitgeben (gekürzt auf 2 000 Zeichen). `ask(..., { json: true, maxTokens: 600 })` für die Auswahl, `ask(..., { maxTokens: 900 })` für den Vorschlag.
- [ ] **Step 4:** `npx vitest run server/agent.test.ts` → PASS.
- [ ] **Step 5: Oberfläche.** Knopf „Lösung vorschlagen“ hinter „Ähnliche Tickets“ (Busy-Text „sucht …“, `title` „Wie wurde das bei diesem Kunden schon gelöst?“). Insight `tone="ink"`, Titel `Lösungsvorschlag · {checked} erledigte geprüft · {read} gelesen` plus „ · nicht alle geprüft“ bei `truncated`; bei `verdict !== "ok"` nur der Text (`tone="flat"`). Bei „ok“: Text (`className="pre"`), Quell-Tickets wie die Liste bei „Ähnliche Tickets“ (`#id` öffnet, Titel, Datum aus `modified`, Begründung), Knöpfe „Ins Notizfeld“ (`props.onDraft(text)`) und „Kopieren“ (`navigator.clipboard.writeText`, Toast über vorhandenen Fehler-/Hinweisweg nicht nötig — Knopf-Text kurz „Kopiert“). README: Zeile in der KI-Tabelle („Lösung vorschlagen | Drawer, Eigenschaften | erledigte Tickets desselben Kunden der letzten 12 Monate; das Portal wählt bis zu 30 nach gemeinsamen Wörtern, das Modell bis zu 5, deren Verlauf samt interner Notiz es liest; nichts davon wird gespeichert außer 10 Minuten im Arbeitsspeicher“). CHANGELOG `[Unveröffentlicht]` → `### Hinzugefügt` – ein Satz.
- [ ] **Step 6:** `npm run check` → Typecheck und alle Tests grün. Danach Sichtprüfung mit einem Mock-Backend (Muster `/tmp/redesign-mock-drawer/mock.mjs`, Vite mit `API_URL`), das `/me/agent/solution` mit „ok“ und mit „no-done“ beantwortet: Knopf, Insight, Links, „Ins Notizfeld“ füllt das Feld und stellt auf interne Notiz.
- [ ] **Step 7: Commit** `Lösung vorschlagen im Ticket`.

### Task 5: Mehrere Tickets einem Techniker zuweisen

**Files:**
- Modify: `src/views/Tickets.tsx`
- Modify: `README.md` (Tastenzeile: `A` (Umschalt) zuweisen an …), `CHANGELOG.md` (`### Hinzugefügt`)

**Interfaces:**
- Consumes: `props.meta.technicians` (`{ id: number; name: string }[]`), vorhandenes `apply(ids, { assignedToEmployeeId }, label)`, `targets`.

- [ ] **Step 1:** Zustand `assignPick` (wie `statusPick`) und Suchtext. Knopf „Zuweisen an …“ in der Auswahlleiste direkt nach „Mir zuweisen“ (`title` „Einem Techniker zuweisen (⇧A)“). Picker wie der Status-Picker: Kopf „Zuweisen: {n} Ticket(s)“, darunter ein Eingabefeld mit `autoFocus` (Platzhalter „Techniker suchen“), das die Liste nach Namensteil filtert (Groß/Klein egal); Enter wählt den ersten Treffer; ohne Techniker-Liste „Technikerliste nicht verfügbar (Recht fehlt?)“. Auswahl → `apply(targets, { assignedToEmployeeId: t.id }, `Zugewiesen an ${t.name}`)`; Picker schließt.
- [ ] **Step 2:** Tastatur: im Key-Handler `event.key === "A"` bzw. `key === "a" && event.shiftKey` → Picker öffnen; der bestehende Zweig für „Mir zuweisen“ greift nur ohne Shift. `assignPick` in die Liste der offenen Dialoge (Escape schließt) und in die Abhängigkeiten des Effekts. Hinweiszeile unter der Liste um „⇧A zuweisen an …“ ergänzen.
- [ ] **Step 3:** `npm run check` → grün. Sichtprüfung mit Mock-Backend (Muster `/tmp/redesign-mock-tickets/mock.mjs`; `/me/meta` mit 3 Technikern, `PATCH /me/tickets/:id` antwortet ok, eins mit Fehler): Auswahl von 3 Tickets → Picker → Filter „ma“ → Klick → Toast „Zugewiesen an …: 2 gesetzt, 1 abgelehnt — #…“; ⇧A öffnet den Picker, `a` weist weiterhin mir zu.
- [ ] **Step 4:** README/CHANGELOG ergänzen, **Commit** `Mehrere Tickets einem Techniker zuweisen`.
