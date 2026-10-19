import { describe, expect, it } from "vitest";
import { assistantPrompt, findPatterns, parseAssistant, type DayContext } from "./assistant.ts";
import { toSupport, type Support } from "./timeline.ts";

const at = (iso: string) => Date.parse(iso) / 1000;
const support = (iso: string, duration: number, text: string, company = "Kranz"): Support => ({
  ...toSupport({}, {}),
  id: Math.round(Math.abs(at(iso)) % 100000),
  date: at(iso),
  duration,
  text,
  companyName: company,
});

describe("findPatterns", () => {
  // 2026-08-25 is a Monday; 08-18 and 08-11 are the Mondays before.
  it("finds what recurs on the same weekday and takes the median", () => {
    const history = [
      support("2026-08-18T08:00:00+02:00", 30, "Monitoring durchgesehen"),
      support("2026-08-11T08:00:00+02:00", 90, "Monitoring durchgesehen"),
      support("2026-08-04T08:00:00+02:00", 45, "Monitoring durchgesehen"),
      support("2026-08-19T08:00:00+02:00", 60, "Nur einmal, und am Dienstag"),
    ];
    const patterns = findPatterns(history, "2026-08-25");
    expect(patterns).toHaveLength(1);
    // Median of 30/90/45 is 45 — not the longest, or a Monday would inflate.
    expect(patterns[0]).toMatchObject({ text: "Monitoring durchgesehen", minutes: 45, seen: 3 });
  });

  it("needs at least two sightings and ignores the day itself", () => {
    const history = [
      support("2026-08-18T08:00:00+02:00", 30, "Einmalig"),
      support("2026-08-25T08:00:00+02:00", 30, "Heute schon gebucht"),
      support("2026-08-11T08:00:00+02:00", 30, "Heute schon gebucht"),
    ];
    expect(findPatterns(history, "2026-08-25").map((p) => p.text)).toEqual([]);
  });
});

describe("assistantPrompt", () => {
  const context: DayContext = {
    day: "2026-08-25",
    booked: [support("2026-08-25T09:00:00+02:00", 60, "Firewall geprüft")],
    templates: [],
    gaps: [{ start: 10 * 60, end: 12 * 60 }],
    routines: [{ id: "r1", text: "Mail", minMinutes: 15, maxMinutes: 45, companyId: null, companyLabel: "", ticketId: null, ticketLabel: "", typeId: null }],
    patterns: [{ text: "Monitoring", company: "Kranz", minutes: 45, seen: 3 }],
    linear: [{ issue: "ESK-499", title: "Firewall", minutes: 90, notes: "Cluster geprüft" }],
    bookedMinutes: 60,
    focus: null,
  };

  it("states what is booked, open and recurring", () => {
    const prompt = assistantPrompt(context);
    expect(prompt).toContain("Gebucht: 60 von 480 Minuten. Offen: 420 Minuten.");
    expect(prompt).toContain("09:00–10:00 · 60 min · Kranz · Firewall geprüft");
    expect(prompt).toContain("10:00–12:00 (120 min)");
    expect(prompt).toContain("Mail · 15–45 min");
    expect(prompt).toContain("3× · Kranz · 45 min · Monitoring");
    expect(prompt).toContain("ESK-499 Firewall · 90 min · Cluster geprüft");
    expect(prompt).toContain("Welche Buchungen fehlen?");
  });

  it("names empty blocks instead of leaving them out", () => {
    const prompt = assistantPrompt({ ...context, templates: [], patterns: [], linear: [] });
    expect(prompt).toContain("Termine und Anrufe ohne Buchung:\n- keine");
    expect(prompt).toContain("Linear-Aktivität ohne Buchung:\n- keine");
    expect(prompt).toContain("nichts erkennbar");
  });

  it("limits the question to one gap when asked about one", () => {
    const prompt = assistantPrompt({ ...context, focus: { start: 10 * 60, end: 12 * 60 } });
    expect(prompt).toContain("Es geht nur um die Lücke 10:00–12:00 (120 Minuten)");
    expect(prompt).toContain("überschreite die Länge der Lücke nicht");
    expect(prompt).not.toContain("Welche Buchungen fehlen?");
  });
});

describe("parseAssistant", () => {
  it("keeps what is usable and drops what is not", () => {
    const result = parseAssistant({
      ideas: [
        { minutes: 45, text: "Monitoring durchgesehen", kind: "muster", evidence: "3× montags", documented: false, company: "Kranz", startMinute: 600 },
        { minutes: 0, text: "Dauer fehlt" },
        { minutes: 30, text: "" },
        { minutes: 30, text: "Ohne Art", kind: "unsinn", startMinute: 5000 },
      ],
      note: "Zwei Stunden bleiben unerklärt.",
    });
    expect(result.ideas).toHaveLength(2);
    expect(result.ideas[0]).toMatchObject({ minutes: 45, kind: "muster", documented: false, startMinute: 600 });
    // Unknown kind falls back, an impossible start becomes "no opinion".
    expect(result.ideas[1]).toMatchObject({ kind: "luecke", startMinute: null });
    expect(result.note).toBe("Zwei Stunden bleiben unerklärt.");
  });

  it("treats anything but an explicit true as a guess", () => {
    const result = parseAssistant({ ideas: [{ minutes: 30, text: "X", documented: "ja" }] });
    expect(result.ideas[0].documented).toBe(false);
  });

  it("survives rubbish", () => {
    expect(parseAssistant(null)).toEqual({ ideas: [], note: "" });
    expect(parseAssistant({ ideas: "kaputt" })).toEqual({ ideas: [], note: "" });
  });
});
