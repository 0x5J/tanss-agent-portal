import { describe, expect, it } from "vitest";
import { DEFAULT_STYLE_RULES, MAX_EXAMPLES, parseStyle, styleSection } from "./style.ts";

describe("styleSection", () => {
  it("carries the rules and the chosen examples", () => {
    const block = styleSection({ rules: "Kurz und trocken.", examples: ["Backup geprüft.", "VPN neu aufgebaut."] });
    expect(block).toContain("So soll eine Leistungsbeschreibung aussehen:\nKurz und trocken.");
    expect(block).toContain("- Backup geprüft.");
    expect(block).toContain("- VPN neu aufgebaut.");
  });

  it("leaves the example block out when there is none", () => {
    expect(styleSection({ rules: "Kurz.", examples: [] })).not.toContain("Beispiele");
  });

  it("falls back to the default rules rather than sending nothing", () => {
    expect(styleSection({ rules: "   ", examples: [] })).toContain(DEFAULT_STYLE_RULES);
  });

  it("never sends more than three examples", () => {
    const block = styleSection({ rules: "x", examples: ["a", "b", "c", "d", "e"] });
    expect(block).toContain("- c");
    expect(block).not.toContain("- d");
  });
});

describe("parseStyle", () => {
  it("keeps what is usable and caps the rest", () => {
    const style = parseStyle({ rules: "  Eigener Stil.  ", examples: ["  a  ", "", "b", "c", "d"] });
    expect(style.rules).toBe("Eigener Stil.");
    expect(style.examples).toEqual(["a", "b", "c"]);
    expect(style.examples).toHaveLength(MAX_EXAMPLES);
  });

  it("falls back to the defaults on rubbish", () => {
    expect(parseStyle(null)).toEqual({ rules: DEFAULT_STYLE_RULES, examples: [] });
    expect(parseStyle({ examples: "kaputt" }).examples).toEqual([]);
  });
});
