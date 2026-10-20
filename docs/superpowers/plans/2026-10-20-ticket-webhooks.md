# Webhooks bei Statuswechsel pro Ticket – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Techniker legen in den Einstellungen Webhooks an, hängen sie an Tickets, und das Portal meldet jeden Statuswechsel dieser Tickets per signiertem HTTP-POST samt abgeleitetem Anlass.

**Architecture:** Reine Logik (Modell, Vorlage, Anlass) in `shared/webhooks.ts`. Ein serverseitiger Watcher (`server/webhook-watcher.ts`) prüft alle 5 Minuten über die geteilte TANSS-Sitzung die verknüpften Tickets, legt erkannte Wechsel als Zustellungen in eine dateibasierte Warteschlange und arbeitet sie mit Wiederholungen ab (`server/webhook-sender.ts`). Routen in `server/webhook-routes.ts`; Oberfläche als neuer Einstellungs-Reiter und als Abschnitt im Ticket-Drawer.

**Tech Stack:** Fastify 5, zod 4, React 19, vitest 4, Node ≥ 22 (`fetch`, `AbortSignal.timeout`, `node:crypto`).

**Spec:** `docs/superpowers/specs/2026-10-20-ticket-webhooks-design.md`

## Global Constraints

- Portal schreibt nie TANSS-Konfiguration; der Watcher liest nur (`ticketById`, `ticketHistory`, `technicians`).
- Alles pro `employeeId`; ein Techniker sieht und benutzt nur eigene Webhooks, Verknüpfungen, Protokolleinträge.
- Geprüft wird nur für den Techniker, dem die aktuelle geteilte Sitzung gehört; alle TANSS-Aufrufe über `shared.run(...)`.
- Prüftakt `SAMPLE_INTERVAL_MINUTES` (5). Aufruf-Zeitlimit 10 s; Erfolg = 2xx; zwei Wiederholungen nach 30 s und 120 s.
- Protokoll: alle offenen Zustellungen + die neuesten 200 abgeschlossenen pro Techniker.
- Keine Einschränkung der Ziel-URL außer `http:`/`https:`.
- Header: `X-Portal-Delivery`, `X-Portal-Timestamp` (Unix-Sekunden), mit Geheimnis `X-Portal-Signature: sha256=<hex HMAC-SHA256 über "<timestamp>.<body>">`.
- Anlass ohne Mail-/Kommentartexte: nur Art, Name, Zeit.
- Geheimnis wird nie an den Client zurückgegeben (`hasSecret` statt `secret`); `webhooks.json` mit Modus 600.
- UI auf Deutsch, Du-Form, Redesign-Kit (`src/ui/kit.tsx`); neue CSS-Klassen mit Präfix `wh-`.
- UI-Prüfung nur mit Mock, nie mit echtem TANSS-Konto.

## Review Focus

- Ticket wechselt Status, während der Webhook inaktiv ist, dann Reaktivieren → kein Aufruf für den alten Wechsel (Test in Task 6).
- Server stürzt zwischen „Zustellung gespeichert“ und „Verknüpfung fortgeschrieben“ ab → nächste Prüfung erzeugt keine zweite Zustellung (Test in Task 5).
- Ein Webhook mit Filter passt nicht, ein zweiter am selben Ticket schon → nur der zweite sendet, beide Verknüpfungen haben danach den neuen Stand (Test in Task 5).
- Vorlage mit Titel, der `"` und Zeilenumbrüche enthält → gültiges JSON beim Empfänger (Test in Task 2).
- Techniker B ruft `/me/webhooks/:id` oder `/me/tickets/:id/webhooks` mit der ID eines Webhooks von A auf → 404, nichts verändert (Test in Task 6).

---

### Task 1: Datenmodell und Parser

**Files:**
- Create: `shared/webhooks.ts`
- Test: `shared/webhooks.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Webhook = { id: string; name: string; url: string; trigger: "status";
    statusFilter: number[]; template: string; secret: string; active: boolean };
  export type PublicWebhook = Omit<Webhook, "secret"> & { hasSecret: boolean };
  export type WebhookLink = { webhookId: string; ticketId: number; once: boolean;
    lastStatusId: number; lastStatusName: string; checkedAt: number /* unix s */ };
  export type DeliveryState = "pending" | "ok" | "failed";
  export type Delivery = { id: string; key: string; webhookId: string; webhookName: string;
    url: string; ticketId: number; statusOld: string; statusNew: string; body: string;
    once: boolean; createdAt: number; attempts: number; nextAttemptAt: number;
    state: DeliveryState; result: string; finishedAt: number };
  export const MAX_WEBHOOKS = 50;
  export const MAX_FINISHED_DELIVERIES = 200;
  export const DEFAULT_TEMPLATE = "{{json}}";
  export function parseWebhooks(raw: unknown): Webhook[];
  export function parseLinks(raw: unknown): WebhookLink[];
  export function parseDeliveries(raw: unknown): Delivery[];
  export function toPublic(w: Webhook): PublicWebhook;
  export function matchesFilter(w: Webhook, newStatusId: number): boolean;
  export function trimDeliveries(list: Delivery[]): Delivery[];
  export function newId(): string; // crypto.randomUUID()
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("drops webhooks without name or with a non-http url", () => {
  const list = parseWebhooks([
    { id: "a", name: "n8n", url: "https://n8n.local/hook", statusFilter: [3], template: "{{json}}", secret: "s", active: true },
    { id: "b", name: "", url: "https://x" },
    { id: "c", name: "ftp", url: "ftp://x" },
  ]);
  expect(list.map((w) => w.id)).toEqual(["a"]);
  expect(list[0].trigger).toBe("status");
});
it("toPublic hides the secret", () => {
  const [w] = parseWebhooks([{ id: "a", name: "x", url: "http://10.0.0.5/h", secret: "geheim" }]);
  expect(toPublic(w)).not.toHaveProperty("secret");
  expect(toPublic(w).hasSecret).toBe(true);
});
it("empty filter matches every status, otherwise only listed ones", () => {
  const [all, some] = parseWebhooks([
    { id: "a", name: "a", url: "http://h" },
    { id: "b", name: "b", url: "http://h", statusFilter: [5] },
  ]);
  expect(matchesFilter(all, 9)).toBe(true);
  expect(matchesFilter(some, 9)).toBe(false);
  expect(matchesFilter(some, 5)).toBe(true);
});
it("trimDeliveries keeps every pending and the newest 200 finished", () => {
  const finished = Array.from({ length: 250 }, (_, i) => delivery({ id: `f${i}`, state: "ok", finishedAt: i }));
  const out = trimDeliveries([delivery({ id: "p", state: "pending" }), ...finished]);
  expect(out.filter((d) => d.state === "pending")).toHaveLength(1);
  expect(out.filter((d) => d.state !== "pending")).toHaveLength(200);
  expect(out.some((d) => d.id === "f249")).toBe(true);
  expect(out.some((d) => d.id === "f0")).toBe(false);
});
```
(`delivery(partial)` ist ein Test-Helfer, der ein vollständiges `Delivery` mit Standardwerten baut.) Missing `template` → `DEFAULT_TEMPLATE`, missing `active` → `true`, list capped at `MAX_WEBHOOKS`.

- [ ] **Step 2:** `npx vitest run shared/webhooks.test.ts` → FAIL (module not found)
- [ ] **Step 3:** Implement in `shared/webhooks.ts`, tolerant reader im Stil von `shared/routines.ts` (ungültige Einträge fallen weg, keine Exceptions).
- [ ] **Step 4:** `npx vitest run shared/webhooks.test.ts` → PASS
- [ ] **Step 5:** Commit `Webhooks: Datenmodell`

### Task 2: Inhalt, Vorlage und Anlass

**Files:**
- Modify: `shared/webhooks.ts`
- Test: `shared/webhooks.test.ts`

**Interfaces:**
- Consumes: Task 1 types; `ThreadEntry` aus `shared/thread.ts`; `berlinMinuteOfDay` aus `shared/days.ts`.
- Produces:
  ```ts
  export type CauseKind = "mail" | "comment" | "support" | "portal" | "unknown";
  export type Cause = { derived: boolean; kind: CauseKind; by: string; at: string /* ISO or "" */; summary: string };
  export type WebhookPayload = {
    ticket: { id: number; title: string; url: string; customer: string };
    status: { old: { id: number; name: string }; new: { id: number; name: string } };
    cause: Cause; changedAt: string; technician: string;
    webhook: { id: string; name: string }; test: boolean };
  export const PLACEHOLDERS: string[]; // ticket.id ticket.title ticket.url customer status.old status.new cause.summary cause.kind cause.by cause.at changedAt technician webhook.name json
  export function deriveCause(thread: ThreadEntry[], sinceUnix: number, untilUnix: number,
    portal?: { at: number; by: string }): Cause;
  export function renderTemplate(template: string, payload: WebhookPayload): string; // throws Error with German message
  export function templateError(template: string): string | null; // renders against samplePayload()
  export function samplePayload(webhook: { id: string; name: string }): WebhookPayload; // test: true
  ```

- [ ] **Step 1: Write the failing tests**

```ts
const AT = 1792485720; // 2026-10-20 10:42 Berlin
it("takes the newest entry inside the window as the derived cause", () => {
  const thread = [
    entry({ kind: "Kommentar", author: "Anna", at: AT - 600 }),
    entry({ kind: "Mail eingehend", author: "Max Mustermann", at: AT }),
    entry({ kind: "Leistung", author: "Ben", at: AT + 999 }), // after the window
  ];
  expect(deriveCause(thread, AT - 900, AT + 60)).toEqual({
    derived: true, kind: "mail", by: "Max Mustermann",
    at: new Date(AT * 1000).toISOString(), summary: "Mail von Max Mustermann um 10:42",
  });
});
it("ignores the description and reports unknown when nothing is in the window", () => {
  const c = deriveCause([entry({ kind: "Beschreibung", at: AT })], AT - 10, AT + 10);
  expect(c).toEqual({ derived: true, kind: "unknown", by: "", at: "", summary: "Kein Anlass im Verlauf gefunden" });
});
it("a change made in the portal wins and is not derived", () => {
  const c = deriveCause([entry({ kind: "Kommentar", author: "Anna", at: AT })], AT - 10, AT + 10, { at: AT + 5, by: "Sören" });
  expect(c).toMatchObject({ derived: false, kind: "portal", by: "Sören", summary: "Im Portal von Sören geändert um 10:42" });
});
it("escapes values so the body stays valid JSON", () => {
  const p = samplePayload({ id: "w", name: "n8n" });
  p.ticket.title = 'Drucker "Büro"\nzweite Zeile';
  const body = renderTemplate('{"t":"{{ticket.title}}","id":{{ticket.id}}}', p);
  expect(JSON.parse(body)).toEqual({ t: 'Drucker "Büro"\nzweite Zeile', id: p.ticket.id });
});
it("{{json}} is the whole payload", () => {
  const p = samplePayload({ id: "w", name: "n8n" });
  expect(JSON.parse(renderTemplate("{{json}}", p))).toEqual(p);
});
it("reports unknown placeholders and invalid JSON", () => {
  expect(templateError('{"a":"{{nope}}"}')).toBe("Unbekannter Platzhalter: {{nope}}");
  expect(templateError('{"a":{{ticket.title}}}')).toBe("Die Vorlage ergibt kein gültiges JSON");
  expect(templateError("{{json}}")).toBeNull();
});
```
Mapping Thread-Art → Anlass: `Mail eingehend|Mail ausgehend` → `mail` („Mail von …“), `Kommentar|Interne Notiz` → `comment` („Kommentar von …“), `Leistung` → `support` („Zeitbuchung von …“). Fenster ist `(sinceUnix, untilUnix]`. Platzhalter-Werte: Strings JSON-escaped ohne Anführungszeichen, Zahlen als Zahl, `status.old`/`status.new` = Statusname, `{{json}}` = `JSON.stringify(payload)`.

- [ ] **Step 2:** `npx vitest run shared/webhooks.test.ts` → FAIL
- [ ] **Step 3:** Implement the five functions in `shared/webhooks.ts`.
- [ ] **Step 4:** `npx vitest run shared/webhooks.test.ts` → PASS
- [ ] **Step 5:** Commit `Webhooks: Inhalt, Vorlage und Anlass`

### Task 3: Speicher

**Files:**
- Modify: `server/store.ts` (Typ `Store`, `createMemoryStore`, `createFileStore`)
- Test: `server/webhook-store.test.ts`

**Interfaces:**
- Produces on `Store`:
  ```ts
  webhooks(employeeId: number): Webhook[];
  setWebhooks(employeeId: number, list: Webhook[]): void;          // webhooks.json, mode 600
  webhookLinks(employeeId: number): WebhookLink[];
  setWebhookLinks(employeeId: number, list: WebhookLink[]): void;  // webhook-links.json
  webhookDeliveries(employeeId: number): Delivery[];
  setWebhookDeliveries(employeeId: number, list: Delivery[]): void; // webhook-deliveries.json, stores trimDeliveries(list)
  ```

- [ ] **Step 1: Write the failing tests** — für Memory- und File-Store (tmp-Verzeichnis wie in `server/claims-history.test.ts`): Werte pro `employeeId` getrennt; File-Store liest nach Neuanlage (`createFileStore(dir)` ein zweites Mal) dieselben Daten; `webhooks.json` hat Modus `0o600` (`statSync(...).mode & 0o777`); `setWebhookDeliveries` mit 250 abgeschlossenen speichert 200.
- [ ] **Step 2:** `npx vitest run server/webhook-store.test.ts` → FAIL
- [ ] **Step 3:** Implement following the `routines`/`llm.json` patterns; parse on read with Task 1 parsers.
- [ ] **Step 4:** `npx vitest run server/webhook-store.test.ts` → PASS
- [ ] **Step 5:** Commit `Webhooks: Speicher`

### Task 4: Versand

**Files:**
- Create: `server/webhook-sender.ts`
- Test: `server/webhook-sender.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Fetcher = typeof fetch;
  export type SendResult = { ok: boolean; status: number; error: string };
  export const SEND_TIMEOUT_MS = 10_000;
  export const RETRY_DELAYS_S = [30, 120];
  export function signature(secret: string, timestamp: number, body: string): string; // "sha256=<hex>"
  export async function send(fetcher: Fetcher, opts: { url: string; body: string; deliveryId: string;
    secret: string; nowUnix: number }): Promise<SendResult>;
  /** Next state after an attempt; attempts counts this one. */
  export function afterAttempt(d: Delivery, r: SendResult, nowUnix: number): Delivery;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
it("signs timestamp and body", () => {
  const expected = createHmac("sha256", "k").update('1700000000.{"a":1}').digest("hex");
  expect(signature("k", 1700000000, '{"a":1}')).toBe(`sha256=${expected}`);
});
it("posts JSON with delivery, timestamp and signature headers", async () => {
  const seen: RequestInit[] = [];
  const fetcher = (async (_u: string, init: RequestInit) => { seen.push(init); return new Response("", { status: 204 }); }) as Fetcher;
  const r = await send(fetcher, { url: "http://h", body: "{}", deliveryId: "d1", secret: "k", nowUnix: 1700000000 });
  expect(r).toEqual({ ok: true, status: 204, error: "" });
  const h = new Headers(seen[0].headers);
  expect(seen[0].method).toBe("POST");
  expect(h.get("content-type")).toBe("application/json");
  expect(h.get("x-portal-delivery")).toBe("d1");
  expect(h.get("x-portal-timestamp")).toBe("1700000000");
  expect(h.get("x-portal-signature")).toBe(signature("k", 1700000000, "{}"));
});
it("omits the signature without a secret", ...);          // header absent
it("a non-2xx answer and a thrown error are failures", ...); // { ok:false, status:500, error:"HTTP 500" } / { ok:false, status:0, error:<message> }
it("retries after 30 s, then 120 s, then gives up", () => {
  const fail = { ok: false, status: 500, error: "HTTP 500" };
  let d = delivery({ state: "pending", attempts: 0 });
  d = afterAttempt(d, fail, 1000); expect(d).toMatchObject({ state: "pending", attempts: 1, nextAttemptAt: 1030 });
  d = afterAttempt(d, fail, 1030); expect(d).toMatchObject({ state: "pending", attempts: 2, nextAttemptAt: 1150 });
  d = afterAttempt(d, fail, 1150); expect(d).toMatchObject({ state: "failed", attempts: 3, result: "HTTP 500", finishedAt: 1150 });
});
it("success finishes with the status code as result", ...); // state "ok", result "204"
```

- [ ] **Step 2:** `npx vitest run server/webhook-sender.test.ts` → FAIL
- [ ] **Step 3:** Implement; Zeitlimit via `AbortSignal.timeout(SEND_TIMEOUT_MS)`, Abbruch ergibt `error: "Zeitlimit überschritten"`.
- [ ] **Step 4:** → PASS
- [ ] **Step 5:** Commit `Webhooks: Versand mit Signatur und Wiederholung`

### Task 5: Watcher – Erkennen und Abarbeiten

**Files:**
- Create: `server/webhook-watcher.ts`
- Test: `server/webhook-watcher.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `TanssClient`, `TanssError` (`server/tanss.ts`); `SharedSession` (`server/shared-session.ts`); `toTicketRow` (`shared/tickets.ts`); `buildThread` (`shared/thread.ts`).
- Produces:
  ```ts
  export type WebhookWatcher = {
    check(): Promise<void>;   // detection pass for the session owner
    flush(): Promise<void>;   // sends due deliveries of store.session()?.employeeId
    start(): void; stop(): void; // check every SAMPLE_INTERVAL_MINUTES, flush every 15 s; timers unref'd
    notePortalChange(employeeId: number, ticketId: number, atUnix: number): void; // in memory only
    /** Current status of a ticket as a new baseline. */
    baseline(session: TanssSession, ticketId: number): Promise<{ statusId: number; statusName: string }>;
    test(employeeId: number, webhookId: string): Promise<SendResult>; // samplePayload, not logged
    resend(employeeId: number, deliveryId: string): Delivery | null;  // new pending copy, new id, same body
  };
  export function createWebhookWatcher(opts: { tanss: TanssClient; store: Store; shared: SharedSession;
    ticketUrl: string; fetcher?: Fetcher; now?: () => number }): WebhookWatcher;
  ```

`check()` Ablauf (die Reihenfolge ist entscheidend für die Duplikatfreiheit):
1. `shared.state()`; ohne `present` → nichts tun. `employeeId` = Eigentümer der Sitzung.
2. Verknüpfungen dieses Technikers, deren Webhook existiert und `active` ist, nach `ticketId` gruppieren.
3. In einem `shared.run`: Technikername einmal über `tanss.technicians` (Fehler → `""`). Pro Ticket `ticketById`.
   - `TanssError` 404 → alle Verknüpfungen des Tickets entfernen, je eine abgeschlossene Zustellung `state: "failed"`, `result: "Ticket nicht mehr abrufbar – Verknüpfung entfernt"`, `attempts: 0`.
   - Status gleich → nur `checkedAt = now`.
   - Status anders → einmal `ticketHistory`, `deriveCause(buildThread(...), link.checkedAt, now, portalMark)`, für jede Verknüpfung mit `matchesFilter` eine Zustellung mit `key = \`${webhookId}|${ticketId}|${lastStatusId}>${newStatusId}|${checkedAt}\`` anlegen, **außer eine mit gleichem `key` existiert schon**. Erst `setWebhookDeliveries`, danach `setWebhookLinks` mit neuem Stand für **alle** Verknüpfungen des Tickets.
4. Andere Fehler eines Tickets lassen dessen Verknüpfungen unverändert (nächster Durchlauf holt nach).

`flush()`: fällige `pending` (`nextAttemptAt <= now`) nacheinander senden, `afterAttempt` anwenden, nach jedem Versand speichern. Bei `ok` und `once` die Verknüpfung (webhookId, ticketId) entfernen. Ein Webhook, der inzwischen gelöscht wurde, beendet seine offenen Zustellungen mit `failed`, `result: "Webhook gelöscht"`.

- [ ] **Step 1: Write the failing tests** (Fake-`TanssClient` wie in `server/app.test.ts`, Memory-Store, Fake-`SharedSession` mit `state()` → `{ present: true, employeeId: 7, … }` und `run(work) => work(SESSION)`, Fake-Fetcher, steuerbare `now`):
  - `no change, no delivery` — Status gleich wie `lastStatusId` → keine Zustellung, `checkedAt` aktualisiert.
  - `a change queues one delivery with old/new names and the derived cause` — `body` parst zu Payload mit `status.old.name`, `status.new.name`, `cause.kind: "mail"`, `ticket.url = ticketUrl + id`.
  - `filter: only the matching webhook sends, both links move on`.
  - `crash between saving deliveries and links does not duplicate` — Store-Spy lässt `setWebhookLinks` einmal werfen; zweites `check()` → weiterhin genau eine Zustellung.
  - `inactive webhooks are not checked` — keine `ticketById`-Aufrufe für sie.
  - `a foreign session pauses the check` — `state().employeeId = 8`, Links von 7 → keine TANSS-Aufrufe.
  - `404 removes the link and logs it`.
  - `portal change becomes the cause` — `notePortalChange(7, id, now-10)` → `cause.kind: "portal"`, `derived: false`.
  - `flush sends, retries, and once unlinks on success` — Fetcher 500 → `pending, attempts 1`; `now += 30` → 204 → `ok`; `once`-Verknüpfung entfernt.
  - `a pending delivery survives a restart` — neuer Watcher auf demselben Store sendet sie mit derselben `id` (Header `x-portal-delivery`).
  - `resend copies body with a new id`.
- [ ] **Step 2:** `npx vitest run server/webhook-watcher.test.ts` → FAIL
- [ ] **Step 3:** Implement `createWebhookWatcher`. Statusname: `toTicketRow(item, linked, []).statusName`, sonst `#<id>`.
- [ ] **Step 4:** → PASS
- [ ] **Step 5:** Commit `Webhooks: Statuswechsel erkennen und zustellen`

### Task 6: Routen und Verdrahtung

**Files:**
- Create: `server/webhook-routes.ts`
- Modify: `server/app.ts` (Option `webhooks?: WebhookWatcher`, `registerWebhookRoutes(...)` neben `registerAgentRoutes`; im `PATCH /me/tickets/:id` nach erfolgreichem `updateTicket` mit geändertem `statusId` → `opts.webhooks?.notePortalChange(session.employeeId, id, nowUnix)`)
- Modify: `server/index.ts` (Watcher erzeugen mit `config.tanssTicketUrl`, `start()`, an `buildApp` übergeben)
- Test: `server/webhook-routes.test.ts`

**Interfaces:**
- Consumes: Task 5 `WebhookWatcher`; in `app.ts` vorhandene `employee(request, reply)` und `withSession(...)`.
- Produces (alle unter Login, alle nur auf eigene Daten):

| Route | Body | Antwort |
|---|---|---|
| `GET /me/webhooks` | – | `{ webhooks: PublicWebhook[] }` |
| `POST /me/webhooks` | `{ name, url, statusFilter?, template?, secret?, active? }` | `{ webhook: PublicWebhook }` |
| `PUT /me/webhooks/:id` | wie POST; `secret` fehlt = behalten, `""` = entfernen | `{ webhook }`; aktiv ← inaktiv setzt Ausgangsstand aller Verknüpfungen via `baseline` neu |
| `DELETE /me/webhooks/:id` | – | `{ ok: true }`, löst alle Verknüpfungen |
| `POST /me/webhooks/:id/test` | – | `SendResult` |
| `GET /me/webhooks/deliveries` | – | `{ deliveries: Delivery[] }` neueste zuerst, ohne `body` |
| `POST /me/webhooks/deliveries/:id/resend` | – | `{ delivery }` |
| `GET /me/tickets/:id/webhooks` | – | `{ links: WebhookLink[] }` |
| `POST /me/tickets/:id/webhooks` | `{ webhookId, once }` | `{ link }`, Ausgangsstand via `baseline`; Duplikat → 409 „Dieser Webhook hängt schon an dem Ticket“ |
| `DELETE /me/tickets/:id/webhooks/:webhookId` | – | `{ ok: true }` |

Validierung mit zod: `name` 1–80, `url` `http(s)` (via `new URL`), `statusFilter` ≤ 50 ganze Zahlen, `template` ≤ 20 000 Zeichen und `templateError(...) === null` (sonst 400 mit dieser Meldung), `secret` ≤ 200, höchstens `MAX_WEBHOOKS`. Unbekannte oder fremde IDs → 404 „Webhook nicht gefunden“.

- [ ] **Step 1: Write the failing tests** mit `app.inject` (Login-Helfer aus `server/app.test.ts` übernehmen): CRUD-Rundlauf ohne `secret` in Antworten; ungültige Vorlage → 400 mit Meldung; Anhängen speichert Ausgangsstand aus `ticketById`; zweites Anhängen → 409; **Techniker 8 sieht die Webhooks von 7 nicht und bekommt auf deren IDs 404** (zweiter Login mit `login`-Override `employeeId: 8`); Status per `PATCH` ändern ruft `notePortalChange`; **Webhook deaktivieren, Ticketstatus im Fake ändern, wieder aktivieren, `check()` → keine Zustellung** (Ausgangsstand neu gesetzt).
- [ ] **Step 2:** `npx vitest run server/webhook-routes.test.ts` → FAIL
- [ ] **Step 3:** Implement `registerWebhookRoutes(app, { store, watcher, employee, withSession, now })` und die Verdrahtung.
- [ ] **Step 4:** `npm run check` → alles grün
- [ ] **Step 5:** Commit `Webhooks: Routen`

### Task 7: Einstellungs-Reiter „Webhooks“

**Files:**
- Modify: `src/api.ts` (`api.webhooks.{list,create,update,remove,test,deliveries,resend,links,attach,detach}` passend zu Task 6)
- Create: `src/views/WebhooksSettings.tsx`
- Modify: `src/views/Settings.tsx` (Tab `{ id: "webhooks", label: "Webhooks" }` nach „Agent“, rendert `<WebhooksSettings onError onToast />`; die Statusliste lädt der Reiter selbst über `api.meta()`)
- Modify: `src/styles/settings.css` (Klassen `wh-*`)

Inhalt des Reiters:
- Kopf mit `SectionTitle "Webhooks"` und Button „Webhook anlegen“.
- Leerzustand: ein Satz, wofür Webhooks gut sind, und dass sie im Ticket erst nach dem Anlegen erscheinen.
- Liste: Name, Ziel-Host, Filter („jeder Wechsel“ oder Statusnamen), Schalter aktiv, Anzahl verknüpfter Tickets, Buttons „Testen“, „Bearbeiten“, „Löschen“ (mit Rückfrage).
- Formular: Name, URL, Mehrfachauswahl Zielstatus aus `api.meta().states`, Vorlage (Textarea, mit `DEFAULT_TEMPLATE` vorbelegt, darunter Liste der `PLACEHOLDERS`), Geheimnis (Passwortfeld; bei vorhandenem „gesetzt – leer lassen zum Behalten“ und Button „entfernen“). Fehler aus dem Server direkt am Formular.
- Test-Ergebnis als Toast: „Test erfolgreich (204)“ bzw. „Test fehlgeschlagen: <error>“.
- Protokoll: Tabelle Zeit, Webhook, Ticket, alt → neu, Ergebnis (grün/rot/„wartet“), „Erneut senden“ bei abgeschlossenen.

- [ ] **Step 1:** Implement; `npx tsc -b` → ohne Fehler.
- [ ] **Step 2:** Mit Mock prüfen (Mock unter `/tmp/…/mock.mjs`, `API_URL` für Vite): anlegen, bearbeiten, testen, löschen, Protokoll; hell und dunkel.
- [ ] **Step 3:** Commit `Webhooks: Einstellungen`

### Task 8: Abschnitt im Ticket

**Files:**
- Create: `src/views/TicketWebhooks.tsx`
- Modify: `src/views/TicketDrawer.tsx` (in `td-side` nach „Zeitsumme“: `<TicketWebhooks ticketId={ticketId} onError onToast />`)
- Modify: `src/styles/drawer.css` (Klassen `wh-*`)

Verhalten: lädt `api.webhooks.list()` und `api.webhooks.links(ticketId)`; **gibt `null` zurück, solange die Liste leer ist oder noch lädt.** Sonst Abschnitt „Webhooks“: angehängte als Zeilen (Name, „einmalig“-Hinweis, Lösen-Button), darunter Auswahl der noch nicht angehängten aktiven Webhooks, Häkchen „einmalig“, Button „Anhängen“. Toast „Webhook angehängt“ / „Webhook gelöst“.

- [ ] **Step 1:** Implement; `npx tsc -b` → ohne Fehler.
- [ ] **Step 2:** Mit Mock prüfen: ohne Webhooks kein Abschnitt; mit Webhook anhängen, lösen; Statuswechsel im Mock → Zustellung erscheint im Protokoll (Mock-Empfänger lokal, z. B. kleiner `node:http`-Server, der Header und Rumpf ausgibt; Signatur nachrechnen).
- [ ] **Step 3:** Commit `Webhooks: Auswahl im Ticket`

### Task 9: Doku und Abschluss

**Files:**
- Modify: `README.md` (Abschnitt „Webhooks“: Zweck, Grenzen – bis 5 min Verzögerung, A→C, Anlass abgeleitet –, Header und Signaturprüfung mit kurzem Node-Beispiel, Platzhalter)
- Modify: `CHANGELOG.md` (`[Unveröffentlicht]` → `### Hinzugefügt`)

- [ ] **Step 1:** Doku schreiben; keine Firmennamen oder internen URLs (Beispiele mit `n8n.example.com`).
- [ ] **Step 2:** `npm run check && npm run build` → grün.
- [ ] **Step 3:** Commit `Webhooks: Doku`
