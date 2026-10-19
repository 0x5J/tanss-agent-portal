import { describe, expect, it } from "vitest";
import { isBookable, parseMappings, parseTarget } from "./mapping.ts";

describe("parseTarget", () => {
  it("keeps one target, never both", () => {
    expect(parseTarget({ ticketId: 4711, ticketLabel: "#4711", companyId: 5, companyLabel: "Kranz" })).toMatchObject({
      ticketId: 4711, ticketLabel: "#4711", companyId: null, companyLabel: "",
    });
    expect(parseTarget({ companyId: 5, companyLabel: "Kranz" })).toMatchObject({ ticketId: null, companyId: 5 });
  });

  it("treats a missing type as ask-each-time", () => {
    expect(parseTarget({ companyId: 5 }).typeId).toBeNull();
    expect(parseTarget({ companyId: 5, typeId: 3 }).typeId).toBe(3);
  });
});

describe("parseMappings", () => {
  it("drops entries that point nowhere", () => {
    const mappings = parseMappings({
      "SOC Betrieb": { companyId: 5, companyLabel: "Kranz", typeId: 3 },
      "Leeres Projekt": { ticketLabel: "nur ein Text" },
      "  ": { companyId: 9 },
    });
    expect(Object.keys(mappings)).toEqual(["SOC Betrieb"]);
  });

  it("survives rubbish", () => {
    expect(parseMappings(null)).toEqual({});
    expect(parseMappings("kaputt")).toEqual({});
  });
});

describe("isBookable", () => {
  it("needs a target and a type", () => {
    expect(isBookable(undefined)).toBe(false);
    expect(isBookable(parseTarget({ companyId: 5 }))).toBe(false);
    expect(isBookable(parseTarget({ companyId: 5, typeId: 3 }))).toBe(true);
    expect(isBookable(parseTarget({ ticketId: 4711, typeId: 3 }))).toBe(true);
  });
});
