import { describe, expect, it } from "vitest";
import { renderDayReport, reportName, type DayReportInput } from "./report.ts";
import type { ClaimEntry } from "./dashboard.ts";

const claim = (over: Partial<ClaimEntry> = {}): ClaimEntry => ({
  day: "2026-08-25",
  id: 55608,
  title: "Geo-Anomalie erkannt",
  minute: 508,
  assigneeId: 7,
  assigneeName: "Sören Jacobsen",
  fromId: 0,
  fromName: "",
  lists: ["view:soc"],
  ...over,
});

const input = (over: Partial<DayReportInput> = {}): DayReportInput => ({
  day: "2026-08-25",
  listLabel: "SOC",
  curve: [
    { minute: 480, count: 12 },
    { minute: 720, count: 17 },
    { minute: 1080, count: 14 },
  ],
  intake: Object.assign(new Array(24).fill(0), { 8: 2, 14: 1 }),
  claims: [claim(), claim({ id: 55653, minute: 517, assigneeName: "Szymon Adwent", assigneeId: 8, fromId: 7, fromName: "Sören Jacobsen" })],
  createdAt: Date.parse("2026-08-26T00:05:00+02:00") / 1000,
  intervalMinutes: 5,
  ...over,
});

describe("renderDayReport", () => {
  it("states the measured figures, not derived ones", () => {
    const html = renderDayReport(input());
    expect(html).toContain("<b>14</b>"); // last measured count
    expect(html).toContain("<b>12</b>"); // first
    expect(html).toContain("<b>17</b>"); // peak
    expect(html).toContain("Höchststand um 12:00");
    expect(html).toContain("<b>3</b>"); // intake 2 + 1
    expect(html).toContain("<b>2</b>"); // claims
  });

  it("lists every takeover with time, ticket and both sides", () => {
    const html = renderDayReport(input());
    expect(html).toContain("08:28");
    expect(html).toContain("#55608");
    expect(html).toContain("Geo-Anomalie erkannt");
    expect(html).toContain("war unzugewiesen");
    expect(html).toContain("Szymon Adwent");
    // The handover names who had it before.
    expect(html).toMatch(/Szymon Adwent<\/td>\s*<td class="muted">Sören Jacobsen/);
  });

  it("says plainly when nothing happened instead of showing an empty chart", () => {
    const html = renderDayReport(input({ claims: [], intake: new Array(24).fill(0), curve: [] }));
    expect(html).toContain("hat niemand ein Ticket dieser Liste übernommen");
    expect(html).toContain("kein Ticket in dieser Liste angelegt");
    expect(html).toContain("keine Messpunkte aufgezeichnet");
  });

  it("escapes what comes out of TANSS", () => {
    const html = renderDayReport(input({ claims: [claim({ title: '<script>alert("x")</script>' })] }));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("carries its own styling and needs nothing from outside", () => {
    const html = renderDayReport(input());
    expect(html).toContain("@page { size: A4;");
    expect(html).not.toMatch(/<(script|link)\b/);
    expect(html).not.toContain("http://");
  });

  it("names a file so a folder sorts by day", () => {
    expect(reportName("2026-08-25", "view:vmt6tz")).toBe("2026-08-25_view-vmt6tz.html");
    expect(reportName("2026-08-25", "list:own")).toBe("2026-08-25_list-own.html");
  });
});
