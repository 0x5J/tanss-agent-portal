import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline, plainAgentText } from "./markdown.ts";

describe("parseInline", () => {
  it("reads bold, italic and code", () => {
    expect(parseInline("**Ursache:** Druckertreiber *veraltet*, siehe `spooler`")).toEqual([
      { bold: ["Ursache:"] },
      " Druckertreiber ",
      { italic: ["veraltet"] },
      ", siehe ",
      { code: "spooler" },
    ]);
  });

  it("reads underscores as marks only at word edges", () => {
    expect(parseInline("__fett__ und _schräg_ in file_name_x")).toEqual([
      { bold: ["fett"] },
      " und ",
      { italic: ["schräg"] },
      " in file_name_x",
    ]);
  });

  it("leaves lone stars and arithmetic alone", () => {
    expect(parseInline("2*3*4 und ein * allein und **offen")).toEqual(["2*3*4 und ein * allein und **offen"]);
  });

  it("reads italic inside bold", () => {
    expect(parseInline("**ganz *wichtig* hier**")).toEqual([{ bold: ["ganz ", { italic: ["wichtig"] }, " hier"] }]);
  });
});

describe("parseBlocks", () => {
  it("splits paragraphs, headings and lists", () => {
    const text = [
      "### Ticket #4711",
      "**Ursache:** Zertifikat abgelaufen.",
      "Zweite Zeile.",
      "",
      "- erster Punkt",
      "* zweiter Punkt",
      "  geht weiter",
      "",
      "---",
      "1. Schritt eins",
      "2. Schritt zwei",
    ].join("\n");
    expect(parseBlocks(text)).toEqual([
      { kind: "h", text: "Ticket #4711" },
      { kind: "p", lines: ["**Ursache:** Zertifikat abgelaufen.", "Zweite Zeile."] },
      { kind: "ul", items: ["erster Punkt", "zweiter Punkt geht weiter"] },
      { kind: "ol", start: 1, items: ["Schritt eins", "Schritt zwei"] },
    ]);
  });

  it("does not take a ticket number or a bold start for a heading or bullet", () => {
    expect(parseBlocks("#4711 war ähnlich\n**Fett** am Anfang")).toEqual([
      { kind: "p", lines: ["#4711 war ähnlich", "**Fett** am Anfang"] },
    ]);
  });

  it("keeps the numbering when items are split by blank lines", () => {
    expect(parseBlocks("1. eins\n\n2. zwei")).toEqual([
      { kind: "ol", start: 1, items: ["eins"] },
      { kind: "ol", start: 2, items: ["zwei"] },
    ]);
  });
});

describe("plainAgentText", () => {
  it("drops the marks and keeps lists readable", () => {
    expect(plainAgentText("## Vorschlag\n**Ursache:** Treiber\n\n* neu installieren\n* _neu starten_")).toBe(
      "Vorschlag\n\nUrsache: Treiber\n\n- neu installieren\n- neu starten",
    );
  });

  it("leaves plain text as it is", () => {
    expect(plainAgentText("Kein Verlauf zeigt eine Lösung.")).toBe("Kein Verlauf zeigt eine Lösung.");
  });
});
