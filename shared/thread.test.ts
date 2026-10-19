import { describe, expect, it } from "vitest";
import { buildThread, mailText } from "./thread.ts";

describe("buildThread", () => {
  it("puts the description first and the rest in time order", () => {
    const thread = buildThread(
      { title: "T", content: "Beschreibung", creationDate: 100, createdEmployeeId: 1 },
      {
        comments: [{ id: 1, date: 300, employeeId: 1, content: "Notiz", internal: true }],
        mails: [{ id: 2, date: 200, inbound: true, senderName: "Kunde", subject: "Re", bodyPlain: "Hallo" }],
        supports: [{ id: 3, date: 400, employeeId: 1, text: "Arbeit", duration: 45 }],
      },
      { employees: { "1": { name: "Sören" } } },
      "Müller GmbH",
    );
    expect(thread.map((e) => e.kind)).toEqual([
      "Beschreibung",
      "Mail eingehend",
      "Interne Notiz",
      "Leistung",
    ]);
    expect(thread[0].author).toBe("Sören");
    expect(thread[3].duration).toBe(45);
  });

  it("falls back to the company as author of the description", () => {
    const thread = buildThread({ title: "T" }, {}, {}, "Müller GmbH");
    expect(thread[0].author).toBe("Müller GmbH");
    expect(thread[0].text).toBe("(keine Beschreibung)");
  });
});

describe("mailText", () => {
  it("prefers plain text and strips html otherwise", () => {
    expect(mailText({ bodyPlain: "plain", bodyHtml: "<b>x</b>" })).toBe("plain");
    expect(mailText({ bodyHtml: "<p>Hallo&nbsp;Welt</p><br><style>x{}</style>Ende" })).toBe(
      "Hallo Welt\n\nEnde",
    );
  });
});

describe("mail sender", () => {
  it("keeps the sender address of a mail next to the display name", () => {
    const thread = buildThread(
      { title: "T", content: "B" },
      { mails: [{ id: 2, date: 200, inbound: true, senderName: "Frau Meier", senderEmail: "meier@mueller-kiel.de", subject: "Re", bodyPlain: "Hallo" }] },
      {},
      "Meier AG",
    );
    expect(thread[1].author).toBe("Frau Meier");
    expect(thread[1].from).toBe("meier@mueller-kiel.de");
  });

  it("leaves the address empty for everything that is not a mail", () => {
    const thread = buildThread({ title: "T" }, { comments: [{ id: 1, date: 300, content: "Notiz" }] }, {}, "Meier AG");
    expect(thread[1].from).toBe("");
  });
});
