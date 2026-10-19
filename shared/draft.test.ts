import { describe, expect, it } from "vitest";
import {
  draftForGap,
  draftFromIdea,
  draftFromRoutine,
  draftFromSupport,
  draftFromTemplate,
} from "./draft.ts";
import { toSupport } from "./timeline.ts";
import type { BookingTemplate } from "./template.ts";
import type { Routine } from "./routines.ts";

const at = (iso: string) => Date.parse(iso) / 1000;

const template = (over: Partial<BookingTemplate> = {}): BookingTemplate => ({
  key: "termin:900",
  kind: "appointment",
  date: at("2026-08-25T10:00:00+02:00"),
  startMinute: 600,
  duration: 45,
  title: "Jour fixe",
  detail: "",
  ticketId: 0,
  companyId: 5,
  companyName: "Kranz GmbH",
  location: "REMOTE",
  teamsUrl: "https://teams",
  ...over,
});

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: "r1",
  text: "Mail und Monitoring",
  minMinutes: 15,
  maxMinutes: 45,
  companyId: null,
  companyLabel: "",
  ticketId: null,
  ticketLabel: "",
  typeId: null,
  ...over,
});

describe("draft from a gap", () => {
  it("takes the whole gap", () => {
    expect(draftForGap("2026-08-25", 600, 720)).toEqual({ date: "2026-08-25", startMinute: 600, duration: 120 });
  });
});

describe("draft from a template", () => {
  it("carries time, target, text and place", () => {
    expect(draftFromTemplate("2026-08-25", template())).toMatchObject({
      startMinute: 600, duration: 45, companyId: 5, companyName: "Kranz GmbH",
      text: "Jour fixe", location: "REMOTE", fromTemplate: "termin:900",
    });
  });

  it("lets a ticket bring its own customer instead of sending both", () => {
    const draft = draftFromTemplate("2026-08-25", template({ ticketId: 4711 }));
    expect(draft.ticketId).toBe(4711);
    expect(draft.companyId).toBeUndefined();
    expect(draft.companyName).toBeUndefined();
  });
});

describe("draft from a routine", () => {
  it("uses the length the gap allows, not the routine's maximum", () => {
    expect(draftFromRoutine("2026-08-25", routine(), 600, 30)).toMatchObject({ startMinute: 600, duration: 30, text: "Mail und Monitoring" });
  });

  it("keeps the routine's target and type when it has one", () => {
    const draft = draftFromRoutine("2026-08-25", routine({ ticketId: 4711, ticketLabel: "#4711 Triage", typeId: 3 }), 600, 30);
    expect(draft).toMatchObject({ ticketId: 4711, ticketLabel: "#4711 Triage", typeId: 3 });
    expect(draft.companyId).toBeUndefined();
  });
});

describe("draft from an assistant idea", () => {
  it("never carries a customer — the model only saw a name", () => {
    const draft = draftFromIdea("2026-08-25", {
      minutes: 45, text: "Monitoring durchgesehen.", kind: "muster",
      evidence: "3× montags", documented: false, company: "Kranz GmbH", startMinute: 600,
    });
    expect(draft).toEqual({ date: "2026-08-25", startMinute: 600, duration: 45, text: "Monitoring durchgesehen." });
    expect(draft.companyId).toBeUndefined();
    expect(draft.companyName).toBeUndefined();
  });

  it("leaves the start open when the model had no opinion", () => {
    const draft = draftFromIdea("2026-08-25", {
      minutes: 30, text: "X", kind: "baustein", evidence: "", documented: false, company: "", startMinute: null,
    });
    expect(draft.startMinute).toBeUndefined();
  });
});

describe("draft from an existing booking", () => {
  it("mirrors the booking and carries the lock reason", () => {
    const support = {
      ...toSupport({}, {}),
      id: 900, date: at("2026-08-25T09:00:00+02:00"), duration: 60,
      ticketId: 4711, text: "Alte Fassung", typeId: 3, location: "CUSTOMER",
    };
    expect(draftFromSupport(support, "Diese Leistung ist bereits abgerechnet.")).toMatchObject({
      date: "2026-08-25", startMinute: 540, duration: 60, ticketId: 4711,
      text: "Alte Fassung", typeId: 3, location: "CUSTOMER", supportId: 900,
      lockText: "Diese Leistung ist bereits abgerechnet.",
    });
  });

  it("falls back to the customer when there is no ticket", () => {
    const support = { ...toSupport({}, {}), id: 901, date: at("2026-08-25T09:00:00+02:00"), duration: 30, companyId: 5, companyName: "Kranz GmbH" };
    expect(draftFromSupport(support, "")).toMatchObject({ companyId: 5, companyName: "Kranz GmbH" });
  });
});
