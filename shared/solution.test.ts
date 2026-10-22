import { describe, expect, it } from "vitest";
import {
  SOLUTION_MAX_READ,
  SOLUTION_MESSAGES,
  parseSolutionPick,
  problemWords,
  rankCandidates,
  solutionPickPrompt,
  solutionPrompt,
} from "./solution.ts";
import type { TicketRow } from "./tickets.ts";

const row: TicketRow = {
  id: 4711, title: "Backup Fehler auf DC01", companyId: 1, companyName: "Müller", projectId: 0, projectName: "", statusId: 1, statusName: "Neu",
  typeName: "Störung", assigneeId: 0, assigneeName: "", departmentName: "", modified: 0, creationDate: 1_750_000_000, dueDate: 0,
  deadlineDate: 0, waiting: false, isProject: false, estimatedMinutes: 0,
};

const subject = { title: "Backup Fehler auf DC01", description: "Veeam Job bricht ab" };
const tickets = [
  { id: 1, title: "Backup Fehler DC02", content: "", modifiedTime: 100 },
  { id: 2, title: "Drucker", content: "Veeam Lizenz", modifiedTime: 300 },
  { id: 3, title: "Urlaub", content: "", modifiedTime: 500 },
  { id: 4, title: "Backup", content: "", internalContent: "Veeam neu gestartet", modifiedTime: 200 },
];

describe("problemWords", () => {
  it("drops HTML, short words and stop words, keeps first-occurrence order", () => {
    expect(problemWords("<p>Drucker im Büro druckt nicht mehr</p>")).toEqual(["drucker", "büro", "druckt"]);
  });
  it("lower-cases and de-duplicates", () => {
    expect(problemWords("Backup BACKUP backup Fehler")).toEqual(["backup", "fehler"]);
  });
  it("separates words at tags and entities", () => {
    expect(problemWords("<td>Drucker</td><td>Toner</td>&nbsp;leer")).toEqual(["drucker", "toner", "leer"]);
  });
});

describe("rankCandidates", () => {
  it("scores title hits 3, body hits 1, drops zero scores, newer first on ties", () => {
    expect(rankCandidates(subject, tickets).map((c) => c.id)).toEqual([1, 4, 2]);
  });
  it("counts a word only once per candidate", () => {
    const [hit] = rankCandidates({ title: "Backup", description: "" }, [
      { id: 7, title: "Backup", content: "Backup Backup", internalContent: "backup", modifiedTime: 1 },
    ]);
    expect(hit?.score).toBe(3);
  });
  it("breaks ties by newer modifiedTime", () => {
    const ids = rankCandidates({ title: "Backup", description: "" }, [
      { id: 1, title: "Backup", modifiedTime: 10 },
      { id: 2, title: "Backup", modifiedTime: 20 },
    ]).map((c) => c.id);
    expect(ids).toEqual([2, 1]);
  });
  it("respects the limit", () => {
    expect(rankCandidates(subject, tickets, 2).map((c) => c.id)).toEqual([1, 4]);
  });
  it("fills title, modified and an HTML-free excerpt of at most 200 characters", () => {
    const [hit] = rankCandidates({ title: "Backup", description: "" }, [
      { id: 5, title: "Backup kaputt", content: `<p>${"x".repeat(300)}</p>`, modifiedTime: 42 },
    ]);
    expect(hit).toMatchObject({ id: 5, title: "Backup kaputt", modified: 42 });
    expect(hit?.excerpt).toBe("x".repeat(200));
  });
  it("copes with missing fields", () => {
    const [hit] = rankCandidates({ title: "Backup", description: "" }, [{ id: 6, title: "Backup" }]);
    expect(hit).toMatchObject({ id: 6, excerpt: "", modified: 0 });
  });
  it("returns nothing when the subject has no usable word", () => {
    expect(rankCandidates({ title: "Ja", description: "" }, tickets)).toEqual([]);
  });
});

describe("parseSolutionPick", () => {
  it("keeps known ids once, at most SOLUTION_MAX_READ", () => {
    const known = new Set([1, 2, 3, 4, 5, 6, 7]);
    const picks = parseSolutionPick(
      {
        similar: [
          { ticketId: 1, reason: "a" }, { ticketId: 9, reason: "b" }, { ticketId: 1, reason: "c" },
          { ticketId: 2, reason: "d" }, { ticketId: 3, reason: "e" }, { ticketId: 4, reason: "f" },
          { ticketId: 5, reason: "g" }, { ticketId: 6, reason: "h" }, { ticketId: 7, reason: "i" },
        ],
      },
      known,
    );
    expect(SOLUTION_MAX_READ).toBe(5);
    expect(picks.map((p) => p.ticketId)).toEqual([1, 2, 3, 4, 5]);
    expect(picks[0]?.reason).toBe("a");
  });
  it("returns an empty list for garbage", () => {
    expect(parseSolutionPick(null, new Set([1]))).toEqual([]);
  });
});

describe("solutionPickPrompt", () => {
  it("names every candidate and asks for JSON with at most 5 entries", () => {
    const candidates = rankCandidates(subject, tickets);
    const prompt = solutionPickPrompt(row, "Veeam Job bricht ab", candidates);
    for (const c of candidates) expect(prompt).toContain(`#${c.id}`);
    expect(prompt).toContain('{"similar":[');
    expect(prompt).toMatch(/höchstens 5/);
    expect(prompt).toContain("#4711");
  });
});

describe("solutionPrompt", () => {
  it("includes each source, the internal note and the stay-with-the-thread instruction", () => {
    const prompt = solutionPrompt("KONTEXT AKTUELL", [
      { ticketId: 11, context: "VERLAUF ELF", internalNote: "Lizenz erneuert" },
      { ticketId: 12, context: "VERLAUF ZWÖLF", internalNote: "" },
    ]);
    expect(prompt).toContain("KONTEXT AKTUELL");
    expect(prompt).toContain("#11");
    expect(prompt).toContain("VERLAUF ELF");
    expect(prompt).toContain("VERLAUF ZWÖLF");
    expect(prompt).toContain("Interne Notiz am Ticket");
    expect(prompt).toContain("Lizenz erneuert");
    expect(prompt.match(/Interne Notiz am Ticket/g)).toHaveLength(1);
    expect(prompt).toMatch(/nur.*was in den Verläufen steht/i);
  });
});

describe("SOLUTION_MESSAGES", () => {
  it("has a message for every non-ok verdict", () => {
    expect(Object.keys(SOLUTION_MESSAGES).sort()).toEqual(["no-company", "no-done", "no-match", "unreadable"]);
    expect(SOLUTION_MESSAGES["no-company"]).toBe("Ticket hat keinen Kunden — es gibt nichts zu vergleichen.");
  });
});
