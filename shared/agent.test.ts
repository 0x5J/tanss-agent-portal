import { describe, expect, it } from "vitest";
import { companyCheckSource, companyPickPrompt, parseCompanyPick, parseMentionedCompany, sameCompany, threadBudget, mentionedTicketIds, rowLine, parseGapAnswer, parsePatterns, searchTerms, stripMailNoise, ticketContext } from "./agent.ts";
import { extractJson, normalizeBaseUrl, stripThinking } from "../server/llm.ts";
import type { TicketRow } from "./tickets.ts";
import type { ThreadEntry } from "./thread.ts";

const row: TicketRow = {
  id: 4711, title: "Backup", companyId: 1, companyName: "Müller", projectId: 0, projectName: "", statusId: 1, statusName: "Neu",
  typeName: "Störung", assigneeId: 0, assigneeName: "", departmentName: "", modified: 0, creationDate: 1_750_000_000, dueDate: 0,
  deadlineDate: 0, waiting: false, isProject: false, estimatedMinutes: 0,
};

function entry(key: string, text: string, at: number): ThreadEntry {
  return { key, kind: "Kommentar", author: "A", from: "", at, title: "", text, duration: 0 };
}

describe("ticketContext", () => {
  it("keeps the description and the newest entries within the budget", () => {
    const thread = [
      { ...entry("d", "Beschreibung", 1), kind: "Beschreibung" as const },
      entry("1", "x".repeat(3000), 2),
      entry("2", "mitte", 3),
      entry("3", "neu", 4),
    ];
    const text = ticketContext(row, thread, 1200);
    expect(text).toContain("Ticket #4711: Backup");
    expect(text).toContain("Zuständig: offen");
    expect(text).toContain("Beschreibung");
    expect(text).toContain("neu");
    expect(text).toContain("mitte");
    expect(text).not.toContain("xxxx");
    expect(text).toContain("1 ältere Einträge ausgelassen");
  });
});

describe("answers", () => {
  it("strips thinking and finds json in chatter", () => {
    expect(stripThinking("<think>hm</think>Hallo")).toBe("Hallo");
    expect(extractJson('Hier: ```json\n{"a":1}\n``` fertig')).toEqual({ a: 1 });
    expect(extractJson("nichts")).toBeNull();
  });
  it("validates the gap answer against the candidates", () => {
    expect(parseGapAnswer({ ticketId: 5, text: "t", reason: "r" }, new Set([4]))).toEqual({ ticketId: null, text: "t", reason: "r" });
    expect(parseGapAnswer({ ticketId: "4", text: "t" }, new Set([4])).ticketId).toBe(4);
  });
  it("keeps each ticket in one group only", () => {
    const groups = parsePatterns({ groups: [{ ticketIds: [1, 2] }, { ticketIds: [2, 3], reason: "x" }] }, new Set([1, 2, 3]));
    expect(groups).toEqual([{ ticketIds: [1, 2], reason: "" }]);
  });
});

describe("mentionedTicketIds", () => {
  it("reads #4711 and Ticket 4711", () => {
    expect(mentionedTicketIds("Was ist bei #4711 und Ticket 4698 los? #4711 nochmal", new Set())).toEqual([4711, 4698]);
    expect(mentionedTicketIds("nichts", new Set())).toEqual([]);
  });
});

describe("mail helpers", () => {
  it("cuts quotes, signatures and greetings", () => {
    expect(stripMailNoise("Hallo,\n\nläuft es?\n\nViele Grüße\nMüller\n> alt")).toBe("Hallo,\n\nläuft es?");
    expect(stripMailNoise("Frage\nVon: x@y\nGesendet: gestern")).toBe("Frage");
    expect(stripMailNoise("Am 22.08. schrieb Müller:\n> alt")).toBe("Am 22.08. schrieb Müller:\n> alt");
  });
  it("picks search terms from a title", () => {
    expect(searchTerms("FortiEDR blockiert Backup-Agent auf DC01")).toBe("FortiEDR blockiert Backup-Agent DC01");
    expect(searchTerms("Neue Mitarbeiterin: Onboarding M365 + MFA")).toBe("Mitarbeiterin Onboarding M365");
  });
});

describe("threadBudget", () => {
  it("scales with the window, bounded both ways", () => {
    expect(threadBudget(8_192)).toBe(12_750);
    expect(threadBudget(32_768)).toBe(67_800);
    expect(threadBudget(2_048)).toBe(8_000);
    expect(threadBudget(1_000_000)).toBe(120_000);
  });
});

describe("normalizeBaseUrl", () => {
  it("adds scheme and /v1", () => {
    expect(normalizeBaseUrl("localhost:11434")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseUrl("http://host.docker.internal:8000/v1/")).toBe("http://host.docker.internal:8000/v1");
    expect(normalizeBaseUrl("")).toBe("");
  });
});

describe("companyCheckSource", () => {
  const description: ThreadEntry = { key: "d", kind: "Beschreibung", author: "Ticket", from: "", at: 1, title: "Backup", text: "Bitte im Auftrag der Müller GmbH prüfen.", duration: 0 };
  const inbound: ThreadEntry = { key: "m1", kind: "Mail eingehend", author: "Frau Meier", from: "meier@mueller-kiel.de", at: 2, title: "Re: Backup", text: "Guten Tag\n\nMit freundlichen Grüßen\nMeier", duration: 0 };

  it("takes the title, the description and the first incoming mail with its sender address", () => {
    const text = companyCheckSource(row, [description, inbound]);
    expect(text).toContain("Meier"); // the assigned company is named as such
    expect(text).toContain("Backup");
    expect(text).toContain("Müller GmbH");
    expect(text).toContain("meier@mueller-kiel.de");
    expect(text).toContain("Guten Tag");
    // the mail goes in without its signature, like everywhere else
    expect(text).not.toContain("freundlichen Grüßen");
  });

  it("leaves out comments, internal notes, outgoing mail and later incoming mail", () => {
    const later: ThreadEntry = { ...inbound, key: "m2", at: 9, from: "chef@fremd.de", text: "Später" };
    const text = companyCheckSource(row, [
      description,
      { ...entry("c", "Kommentar eines Kollegen", 3), kind: "Kommentar" },
      { ...entry("n", "Interne Notiz", 4), kind: "Interne Notiz" },
      { ...entry("o", "Ausgehende Antwort", 5), kind: "Mail ausgehend" },
      inbound,
      later,
    ]);
    expect(text).toContain("Guten Tag");
    expect(text).not.toContain("Kommentar eines Kollegen");
    expect(text).not.toContain("Interne Notiz");
    expect(text).not.toContain("Ausgehende Antwort");
    expect(text).not.toContain("chef@fremd.de");
  });
});

describe("sameCompany", () => {
  it("ignores legal form, punctuation, case and umlaut spelling", () => {
    expect(sameCompany("Müller GmbH", "müller  gmbh")).toBe(true);
    expect(sameCompany("Müller GmbH & Co. KG", "Mueller")).toBe(true);
    expect(sameCompany("Meier AG", "Meier Aktiengesellschaft")).toBe(true);
  });

  it("keeps different companies apart", () => {
    expect(sameCompany("Müller GmbH", "Müller Holding GmbH")).toBe(false);
    expect(sameCompany("Meier AG", "Müller GmbH")).toBe(false);
    expect(sameCompany("Meier AG", "")).toBe(false);
    expect(sameCompany("", "")).toBe(false);
  });
});

describe("parseMentionedCompany", () => {
  it("reads the named company and the quote it rests on", () => {
    expect(parseMentionedCompany({ name: " Müller GmbH ", evidence: " im Auftrag der Müller GmbH " })).toEqual({
      name: "Müller GmbH",
      evidence: "im Auftrag der Müller GmbH",
    });
  });

  it("reports no name when the model names none", () => {
    expect(parseMentionedCompany({ name: null }).name).toBe("");
    expect(parseMentionedCompany(null).name).toBe("");
  });
});

describe("parseCompanyPick", () => {
  it("takes the chosen candidate with its reason", () => {
    expect(parseCompanyPick({ companyId: 7, reason: "Domain passt" }, new Set([7, 9]))).toEqual({
      companyId: 7,
      reason: "Domain passt",
    });
  });

  it("refuses an id that was not offered", () => {
    expect(parseCompanyPick({ companyId: 3 }, new Set([7])).companyId).toBeNull();
    expect(parseCompanyPick({ companyId: null }, new Set([7])).companyId).toBeNull();
  });
});

describe("companyPickPrompt", () => {
  it("offers the candidates with id, place and domain", () => {
    const prompt = companyPickPrompt("Müller GmbH", "im Auftrag der Müller GmbH", [
      { id: 7, name: "Müller GmbH", city: "Kiel", domain: "mueller-kiel.de" },
      { id: 9, name: "Müller Holding", city: "Hamburg", domain: "" },
    ]);
    expect(prompt).toContain("Müller GmbH");
    expect(prompt).toContain("#7");
    expect(prompt).toContain("Kiel");
    expect(prompt).toContain("mueller-kiel.de");
    expect(prompt).toContain("companyId");
  });
});

describe("rowLine", () => {
  const now = Date.parse("2026-08-23T12:00:00+02:00") / 1000;
  const today = "2026-08-23";
  const since = "2025-08-23";
  const fresh: TicketRow = { ...row, creationDate: now - 3 * 3600, assigneeName: "Sören" };

  it("says hours for a ticket from this morning instead of rounding it to a day", () => {
    const line = rowLine(fresh, { at: now - 45 * 60, kind: "comment", historyRead: true }, today, since, now);
    expect(line).toContain("3 h alt");
    expect(line).toContain("45 min inaktiv");
  });

  it("keeps days where they are the honest unit", () => {
    const old = { ...row, creationDate: now - 5 * 86_400 };
    const line = rowLine(old, { at: now - 2 * 86_400, kind: "support", historyRead: true }, today, since, now);
    expect(line).toContain("5 d alt");
    expect(line).toContain("2 d inaktiv");
  });

  it("stays day-coarse where only a lower bound exists", () => {
    const ancient = { ...row, creationDate: Date.parse("2024-01-01T09:00:00+01:00") / 1000 };
    const line = rowLine(ancient, { at: 0, kind: "none", historyRead: false }, today, since, now);
    expect(line).toContain("> 365 d inaktiv");
  });

  it("leaves out the idleness when no activity is known", () => {
    expect(rowLine(fresh, undefined, today, since, now)).not.toContain("inaktiv");
  });
});
