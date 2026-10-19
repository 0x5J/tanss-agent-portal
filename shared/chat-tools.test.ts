import { describe, expect, it } from "vitest";
import {
  BUDGET_EXHAUSTED,
  CHAT_TOOLS,
  CHAT_TOOL_NAMES,
  MIN_READ_CHARS,
  readShare,
  searchResultText,
  supportsText,
} from "./chat-tools.ts";
import type { TicketRow } from "./tickets.ts";
import type { Support } from "./timeline.ts";

// 2026-08-23 10:00 Berlin
const NOW = Math.floor(Date.UTC(2026, 7, 23, 8, 0, 0) / 1000);

function row(over: Partial<TicketRow> = {}): TicketRow {
  return {
    id: 1,
    title: "Backup DC01",
    companyId: 5,
    companyName: "Müller GmbH",
    projectId: 0,
    projectName: "",
    statusId: 2,
    statusName: "Neu",
    typeName: "Störung",
    assigneeId: 7,
    assigneeName: "Sören",
    departmentName: "",
    modified: NOW,
    creationDate: NOW,
    dueDate: 0,
    deadlineDate: 0,
    waiting: false,
    isProject: false,
    estimatedMinutes: 0,
    ...over,
  };
}

function support(over: Partial<Support> = {}): Support {
  return {
    id: 1,
    date: NOW,
    duration: 30,
    ticketId: 1,
    companyId: 5,
    companyName: "Müller GmbH",
    text: "Exclusion gesetzt\nund geprüft",
    typeId: 3,
    typeName: "Remote",
    location: "REMOTE",
    employeeId: 7,
    booked: false,
    clearanceStatus: "",
    voucherId: 0,
    internal: false,
    durationNotCharged: 0,
    reasonNotChargedText: "",
    ...over,
  };
}

describe("the toolbox", () => {
  it("holds exactly the three reading tools", () => {
    expect(CHAT_TOOL_NAMES).toEqual(["tickets_suchen", "ticket_lesen", "leistungen_ticket"]);
    expect(CHAT_TOOLS.map((t) => t.name)).toEqual([...CHAT_TOOL_NAMES]);
    // A writing tool must never sneak in here.
    expect(CHAT_TOOL_NAMES.some((n) => /schreib|kommentar|buch|status|anleg/i.test(n))).toBe(false);
    for (const tool of CHAT_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.parameters).toMatchObject({ type: "object" });
    }
  });
});

describe("the reading budget", () => {
  it("hands out a third of the total and never more than what is left", () => {
    expect(readShare(30_000, 30_000)).toBe(10_000);
    expect(readShare(30_000, 4_000)).toBe(4_000);
  });

  it("falls under the minimum once the budget is nearly used up", () => {
    expect(readShare(30_000, 900)).toBeLessThan(MIN_READ_CHARS);
    expect(BUDGET_EXHAUSTED).toContain("Gelesenen");
  });
});

describe("search results", () => {
  it("lists the hits as one line each", () => {
    const text = searchResultText("Müller", [row(), row({ id: 2, title: "Drucker", assigneeName: "" })]);
    expect(text).toContain(`Treffer zu „Müller" (2)`);
    expect(text).toContain(`#1 · Müller GmbH · „Backup DC01" · Status Neu · Zuständig Sören`);
    expect(text).toContain("Zuständig offen");
  });

  it("says plainly when nothing was found", () => {
    expect(searchResultText("Meier", [])).toBe(`Keine Tickets zu „Meier" gefunden.`);
  });

  it("caps the list and says how many were left out", () => {
    const many = Array.from({ length: 20 }, (_, i) => row({ id: i + 1 }));
    const text = searchResultText("Müller", many, 15);
    expect(text.split("\n").filter((l) => l.startsWith("#"))).toHaveLength(15);
    expect(text).toContain("5 weitere");
  });
});

describe("booked supports", () => {
  it("lists date, duration, who and the first line, with a total", () => {
    const text = supportsText([support(), support({ id: 2, employeeId: 9, duration: 15 })], 7);
    expect(text).toContain("(2, zusammen 45 min)");
    expect(text).toContain("23.08.2026 · 30 min · ich · Exclusion gesetzt");
    expect(text).toContain("· Kollege ·");
    // Only the first line of the text, so a long entry cannot flood the answer.
    expect(text).not.toContain("und geprüft");
  });

  it("says plainly when nothing is booked", () => {
    expect(supportsText([], 7)).toBe("Auf diesem Ticket sind keine Leistungen gebucht.");
  });
});
