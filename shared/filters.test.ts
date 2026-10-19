import { describe, expect, it } from "vitest";
import { applyFilters, columnOptions, EMPTY_FILTERS, hasFilters, parseSavedViews, presetFilters, toggleValue } from "./filters.ts";
import { toTicketRow } from "./tickets.ts";

const rows = [
  toTicketRow({ id: 1, companyId: 1, statusId: 1, typeId: 1, assignedToEmployeeId: 7 }, { companies: { "1": { name: "Müller" } }, ticketStates: { "1": { name: "Neu" } }, ticketTypes: { "1": { name: "Störung" } }, employees: { "7": { name: "Sören" } } }, []),
  toTicketRow({ id: 2, companyId: 2, statusId: 1, typeId: 1, assignedToDepartmentId: 4 }, { companies: { "2": { name: "Kranz" } }, ticketStates: { "1": { name: "Neu" } }, ticketTypes: { "1": { name: "Störung" } }, departments: { "4": { name: "SOC" } } }, []),
  toTicketRow({ id: 3, companyId: 1, statusId: 2 }, { companies: { "1": { name: "Müller" } }, ticketStates: { "2": { name: "Wartet" } } }, []),
];

describe("columnOptions", () => {
  it("counts distinct values and names the empty one", () => {
    expect(columnOptions(rows, "company")).toEqual([{ value: "Kranz", count: 1 }, { value: "Müller", count: 2 }]);
    expect(columnOptions(rows, "assignee")).toEqual([
      { value: "offen", count: 2 },
      { value: "Sören", count: 1 },
    ]);
  });
});

describe("department filter", () => {
  it("filters by department independent of the assignee", () => {
    const f = toggleValue(EMPTY_FILTERS, "department", "SOC");
    expect(applyFilters(rows, f).map((r) => r.id)).toEqual([2]);
    expect(columnOptions(rows, "department")).toEqual([{ value: "SOC", count: 1 }, { value: "—", count: 2 }]);
  });
});

describe("applyFilters", () => {
  it("ANDs the columns and ORs the values", () => {
    const f = toggleValue(toggleValue(EMPTY_FILTERS, "company", "Müller"), "status", "Neu");
    expect(applyFilters(rows, f).map((r) => r.id)).toEqual([1]);
    const two = toggleValue(f, "status", "Wartet");
    expect(applyFilters(rows, two).map((r) => r.id)).toEqual([1, 3]);
    expect(applyFilters(rows, EMPTY_FILTERS)).toHaveLength(3);
  });

  it("toggle removes an existing value", () => {
    const f = toggleValue(toggleValue(EMPTY_FILTERS, "type", "Störung"), "type", "Störung");
    expect(hasFilters(f)).toBe(false);
  });
});

describe("parseSavedViews", () => {
  it("keeps valid entries and drops broken ones", () => {
    const views = parseSavedViews(
      [
        { id: "a", name: " Müller offen ", list: "own", filters: { company: ["Müller"], status: [1] } },
        { id: "b", name: "", list: "own", filters: {} },
        { id: "c", name: "x", list: "nope", filters: {} },
        "junk",
      ],
      ["own", "general"],
    );
    expect(views).toEqual([{ id: "a", name: "Müller offen", list: "own", filters: { ...EMPTY_FILTERS, company: ["Müller"] } }]);
    expect(parseSavedViews(null, ["own"])).toEqual([]);
  });
});

describe("presetFilters", () => {
  const me = { id: 7, name: "Sören" };
  it("spells the tabs out as filters", () => {
    expect(presetFilters("own", rows, me).assignee).toEqual(["Sören"]);
    expect(presetFilters("general", rows, me).assignee).toEqual(["offen"]);
    expect(presetFilters("all", rows, me)).toEqual(EMPTY_FILTERS);
    expect(presetFilters("technician", [...rows, { ...rows[0], id: 9, assigneeId: 8, assigneeName: "Tina" }], me).assignee).toEqual(["Tina"]);
  });
  it("takes the waiting states from the rows", () => {
    const waiting = rows.map((r) => ({ ...r, waiting: r.statusName === "Wartet" }));
    expect(presetFilters("waiting", waiting, me).status).toEqual(["Wartet"]);
  });
  it("falls back to the id when the name is unknown", () => {
    expect(presetFilters("own", [], { id: 7, name: "" }).assignee).toEqual(["#7"]);
  });
});
