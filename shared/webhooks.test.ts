import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEMPLATE,
  deriveCause,
  MAX_FINISHED_DELIVERIES,
  MAX_TEMPLATE_LENGTH,
  MAX_WEBHOOKS,
  matchesFilter,
  newId,
  isHttpUrl,
  parseDeliveries,
  parseLinks,
  parseWebhooks,
  renderTemplate,
  samplePayload,
  templateError,
  toPublic,
  trimDeliveries,
  type Delivery,
  isHeaderName,
  secretHint,
} from "./webhooks.ts";
import type { ThreadEntry } from "./thread.ts";

const delivery = (over: Partial<Delivery> = {}): Delivery => ({
  id: "d1",
  key: "w1:42:3",
  webhookId: "w1",
  webhookName: "n8n",
  url: "https://n8n.local/hook",
  ticketId: 42,
  statusOld: "Offen",
  statusNew: "Erledigt",
  body: "{}",
  once: false,
  createdAt: 1000,
  attempts: 0,
  nextAttemptAt: 1000,
  state: "pending",
  result: "",
  finishedAt: 0,
  ...over,
});

describe("parseWebhooks", () => {
  it("drops webhooks without name or with a non-http url", () => {
    const list = parseWebhooks([
      { id: "a", name: "n8n", url: "https://n8n.local/hook", statusFilter: [3], template: "{{json}}", secret: "s", active: true },
      { id: "b", name: "", url: "https://x" },
      { id: "c", name: "ftp", url: "ftp://x" },
    ]);
    expect(list.map((w) => w.id)).toEqual(["a"]);
    expect(list[0].trigger).toBe("status");
  });
  it("fills defaults for template and active", () => {
    const [w] = parseWebhooks([{ id: "a", name: "x", url: "http://h" }]);
    expect(w.template).toBe(DEFAULT_TEMPLATE);
    expect(w.active).toBe(true);
    expect(w.statusFilter).toEqual([]);
    expect(w.secret).toBe("");
    expect(parseWebhooks([{ id: "a", name: "x", url: "http://h", active: false }])[0].active).toBe(false);
  });
  it("keeps a template up to MAX_TEMPLATE_LENGTH and cuts beyond it", () => {
    expect(MAX_TEMPLATE_LENGTH).toBe(20_000);
    const long = "x".repeat(19_000);
    expect(parseWebhooks([{ id: "a", name: "x", url: "http://h", template: long }])[0].template).toBe(long);
    const over = "x".repeat(MAX_TEMPLATE_LENGTH + 1);
    expect(parseWebhooks([{ id: "a", name: "x", url: "http://h", template: over }])[0].template).toHaveLength(MAX_TEMPLATE_LENGTH);
  });
  it("assigns an id when missing and survives garbage", () => {
    expect(parseWebhooks("nope")).toEqual([]);
    expect(parseWebhooks([null, 5, "x"])).toEqual([]);
    const [w] = parseWebhooks([{ name: "x", url: "http://h" }]);
    expect(w.id).not.toBe("");
  });
  it("keeps only positive integer status ids", () => {
    const [w] = parseWebhooks([{ id: "a", name: "x", url: "http://h", statusFilter: [3, "4", 0, -1, 2.5, "x", null] }]);
    expect(w.statusFilter).toEqual([3, 4]);
  });
  it("caps the list at MAX_WEBHOOKS", () => {
    const many = Array.from({ length: MAX_WEBHOOKS + 10 }, (_, i) => ({ id: `w${i}`, name: "n", url: "http://h" }));
    expect(parseWebhooks(many)).toHaveLength(MAX_WEBHOOKS);
  });
});

describe("toPublic / matchesFilter", () => {
  it("toPublic hides the secret", () => {
    const [w] = parseWebhooks([{ id: "a", name: "x", url: "http://10.0.0.5/h", secret: "geheim" }]);
    expect(toPublic(w)).not.toHaveProperty("secret");
    expect(toPublic(w).hasSecret).toBe(true);
    const [n] = parseWebhooks([{ id: "b", name: "x", url: "http://h" }]);
    expect(toPublic(n).hasSecret).toBe(false);
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
});

describe("parseLinks", () => {
  it("drops entries without webhook or ticket and fills defaults", () => {
    const list = parseLinks([
      { webhookId: "a", ticketId: 7, once: true, lastStatusId: 3, lastStatusName: "Offen", checkedAt: 99 },
      { webhookId: "", ticketId: 7 },
      { webhookId: "a", ticketId: 0 },
      { webhookId: "a", ticketId: 8 },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ webhookId: "a", ticketId: 7, once: true, lastStatusId: 3, lastStatusName: "Offen", checkedAt: 99 });
    expect(list[1]).toEqual({ webhookId: "a", ticketId: 8, once: false, lastStatusId: 0, lastStatusName: "", checkedAt: 0 });
    expect(parseLinks({})).toEqual([]);
  });

  it("keeps the rebaseline mark only when it is set", () => {
    const [marked, plain] = parseLinks([
      { webhookId: "a", ticketId: 7, rebaseline: true },
      { webhookId: "a", ticketId: 8, rebaseline: "yes" },
    ]);
    expect(marked).toMatchObject({ rebaseline: true });
    expect(plain).not.toHaveProperty("rebaseline");
  });
});

describe("parseDeliveries", () => {
  it("round-trips a valid delivery and drops broken ones", () => {
    const d = delivery({ state: "failed", attempts: 3, result: "HTTP 500", finishedAt: 5 });
    const list = parseDeliveries([d, { id: "" }, null, { ...d, id: "x", state: "weird" }]);
    expect(list[0]).toEqual(d);
    expect(list.map((x) => x.id)).toEqual(["d1"]);
    expect(parseDeliveries(undefined)).toEqual([]);
  });
});

describe("trimDeliveries", () => {
  it("keeps every pending and the newest 200 finished", () => {
    const finished = Array.from({ length: 250 }, (_, i) => delivery({ id: `f${i}`, state: "ok", finishedAt: i }));
    const out = trimDeliveries([delivery({ id: "p", state: "pending" }), ...finished]);
    expect(MAX_FINISHED_DELIVERIES).toBe(200);
    expect(out.filter((d) => d.state === "pending")).toHaveLength(1);
    expect(out.filter((d) => d.state !== "pending")).toHaveLength(200);
    expect(out.some((d) => d.id === "f249")).toBe(true);
    expect(out.some((d) => d.id === "f0")).toBe(false);
  });
});

describe("newId", () => {
  it("returns unique ids", () => {
    expect(newId()).not.toBe(newId());
  });
});

const entry = (over: Partial<ThreadEntry> = {}): ThreadEntry => ({
  key: "e",
  kind: "Kommentar",
  author: "",
  from: "",
  at: 0,
  title: "",
  text: "",
  duration: 0,
  ...over,
});

describe("cause, template and sample", () => {
  const AT = 1792485720; // 2026-10-20 10:42 Berlin

  it("takes the newest entry inside the window as the derived cause", () => {
    const thread = [
      entry({ kind: "Kommentar", author: "Anna", at: AT - 600 }),
      entry({ kind: "Mail eingehend", author: "Max Mustermann", at: AT }),
      entry({ kind: "Leistung", author: "Ben", at: AT + 999 }), // after the window
    ];
    expect(deriveCause(thread, AT - 900, AT + 60)).toEqual({
      derived: true,
      kind: "mail",
      by: "Max Mustermann",
      at: new Date(AT * 1000).toISOString(),
      summary: "Mail von Max Mustermann um 10:42",
    });
  });

  it("maps comments, notes and supports to their kinds", () => {
    expect(deriveCause([entry({ kind: "Interne Notiz", author: "Anna", at: AT })], AT - 1, AT)).toMatchObject({
      kind: "comment",
      summary: "Kommentar von Anna um 10:42",
    });
    expect(deriveCause([entry({ kind: "Leistung", author: "Ben", at: AT })], AT - 1, AT)).toMatchObject({
      kind: "support",
      summary: "Zeitbuchung von Ben um 10:42",
    });
  });

  it("uses an open start and a closed end for the window", () => {
    const thread = [entry({ kind: "Kommentar", author: "Anna", at: AT })];
    expect(deriveCause(thread, AT, AT + 10).kind).toBe("unknown");
    expect(deriveCause(thread, AT - 10, AT).kind).toBe("comment");
  });

  it("ignores the description and reports unknown when nothing is in the window", () => {
    const c = deriveCause([entry({ kind: "Beschreibung", at: AT })], AT - 10, AT + 10);
    expect(c).toEqual({ derived: true, kind: "unknown", by: "", at: "", summary: "Kein Anlass im Verlauf gefunden" });
  });

  it("a change made in the portal wins and is not derived", () => {
    const c = deriveCause([entry({ kind: "Kommentar", author: "Anna", at: AT })], AT - 10, AT + 10, {
      at: AT + 5,
      by: "Sören",
    });
    expect(c).toMatchObject({ derived: false, kind: "portal", by: "Sören", summary: "Im Portal von Sören geändert um 10:42" });
    expect(c.at).toBe(new Date((AT + 5) * 1000).toISOString());
  });

  it("never puts mail or comment text into the cause", () => {
    const c = deriveCause([entry({ kind: "Mail eingehend", author: "Max", at: AT, text: "GEHEIM", title: "Betreff" })], AT - 1, AT);
    expect(JSON.stringify(c)).not.toMatch(/GEHEIM|Betreff/);
  });

  it("escapes values so the body stays valid JSON", () => {
    const p = samplePayload({ id: "w", name: "n8n" });
    p.ticket.title = 'Drucker "Büro"\nzweite Zeile';
    const body = renderTemplate('{"t":"{{ticket.title}}","id":{{ticket.id}}}', p);
    expect(JSON.parse(body)).toEqual({ t: 'Drucker "Büro"\nzweite Zeile', id: p.ticket.id });
  });

  it("accepts whitespace inside the braces and fills status names", () => {
    const p = samplePayload({ id: "w", name: "n8n" });
    expect(renderTemplate("{{ status.old }} -> {{status.new}} ({{webhook.name}})", p)).toBe("Neu -> Erledigt (n8n)");
  });

  it("{{json}} is the whole payload", () => {
    const p = samplePayload({ id: "w", name: "n8n" });
    expect(JSON.parse(renderTemplate("{{json}}", p))).toEqual(p);
    expect(p.test).toBe(true);
  });

  it("reports unknown placeholders and invalid JSON", () => {
    expect(templateError('{"a":"{{nope}}"}')).toBe("Unbekannter Platzhalter: {{nope}}");
    expect(templateError('{"a":{{ticket.title}}}')).toBe("Die Vorlage ergibt kein gültiges JSON");
    expect(templateError("{{json}}")).toBeNull();
    expect(templateError(DEFAULT_TEMPLATE)).toBeNull();
  });

  it("throws for an unknown placeholder when rendering", () => {
    expect(() => renderTemplate("{{nope}}", samplePayload({ id: "w", name: "n" }))).toThrow(
      "Unbekannter Platzhalter: {{nope}}",
    );
  });
});

describe("isHttpUrl", () => {
  it("accepts http and https only", () => {
    expect(isHttpUrl("http://h.local/a")).toBe(true);
    expect(isHttpUrl("https://h.local/a")).toBe(true);
    expect(isHttpUrl("ftp://h.local")).toBe(false);
    // fetch refuses these, so every call would fail
    expect(isHttpUrl("https://user:pass@h.local/a")).toBe(false);
    expect(isHttpUrl("https://user@h.local/a")).toBe(false);
    expect(isHttpUrl("kein url")).toBe(false);
  });
});

describe("auth", () => {
  it("defaults to the signature and keeps a valid header mode", () => {
    const [old, bearer, header, broken] = parseWebhooks([
      { id: "a", name: "alt", url: "http://h" },
      { id: "b", name: "token", url: "http://h", auth: "bearer", secret: "tok_x" },
      { id: "c", name: "eigen", url: "http://h", auth: "header", headerName: "X-Api-Key" },
      { id: "d", name: "kaputt", url: "http://h", auth: "header", headerName: "Content-Type" },
    ]);
    expect(old).toMatchObject({ auth: "signature", headerName: "" });
    expect(bearer).toMatchObject({ auth: "bearer", headerName: "" });
    expect(header).toMatchObject({ auth: "header", headerName: "X-Api-Key" });
    expect(broken).toMatchObject({ auth: "signature", headerName: "" });
  });

  it("checks header names", () => {
    expect(isHeaderName("X-Api-Key")).toBe(true);
    expect(isHeaderName("Authorization")).toBe(true);
    expect(isHeaderName("X-Portal-Signature")).toBe(false);
    expect(isHeaderName("mit leerzeichen")).toBe(false);
    expect(isHeaderName("")).toBe(false);
  });

  it("hints at a secret without revealing it", () => {
    expect(secretHint("")).toBe("");
    expect(secretHint("kurz")).toBe("(4 Zeichen)");
    expect(secretHint("tok_abcdefghijklmnopqrstuvwxyz")).toBe("tok_…yz (30 Zeichen)");
    const [w] = parseWebhooks([{ id: "a", name: "x", url: "http://h", secret: "tok_abcdefghijklmnopqrstuvwxyz" }]);
    expect(toPublic(w)).toMatchObject({ hasSecret: true, secretHint: "tok_…yz (30 Zeichen)" });
    expect(JSON.stringify(toPublic(w))).not.toContain("abcdefghijklmnop");
  });
});
