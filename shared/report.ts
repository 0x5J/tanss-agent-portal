import { formatLongDate } from "./days.ts";
import type { ClaimEntry } from "./dashboard.ts";

/**
 * Everything the day report is allowed to state. Only measured values go in:
 * the counts come from the day's samples, the intake from the tickets seen
 * that day, the takeovers from the history. Nothing is reconstructed.
 */
export type DayReportInput = {
  day: string;
  listLabel: string;
  /** Minute of the day → count, in order. */
  curve: { minute: number; count: number }[];
  /** 24 buckets, tickets created in that Berlin hour. */
  intake: number[];
  claims: ClaimEntry[];
  /** When the report was written, unix seconds. */
  createdAt: number;
  /** Minutes between measurements, for the honest note about gaps. */
  intervalMinutes: number;
};

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function clock(minute: number): string {
  const safe = Math.max(0, Math.round(minute));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

/** Bars over 24 hours, drawn as plain SVG so the file needs nothing else. */
function intakeChart(intake: number[]): string {
  const max = Math.max(1, ...intake);
  const width = 660;
  const height = 130;
  const pad = { left: 26, bottom: 18, top: 6 };
  const slot = (width - pad.left - 6) / 24;
  const bars = intake
    .map((value, hour) => {
      if (value <= 0) return "";
      const h = ((height - pad.top - pad.bottom) * value) / max;
      const x = pad.left + hour * slot + slot * 0.18;
      const y = height - pad.bottom - h;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(slot * 0.64).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="#2a78d6"/>`;
    })
    .join("");
  const ticks = [0, 6, 12, 18]
    .map(
      (hour) =>
        `<text x="${(pad.left + hour * slot + slot / 2).toFixed(1)}" y="${height - 5}" font-size="9" text-anchor="middle" fill="#6b7280">${hour}</text>`,
    )
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Eingang je Stunde">
    <line x1="${pad.left}" x2="${width - 6}" y1="${height - pad.bottom}" y2="${height - pad.bottom}" stroke="#d1d5db"/>
    <text x="${pad.left - 6}" y="${pad.top + 8}" font-size="9" text-anchor="end" fill="#6b7280">${max}</text>
    ${bars}${ticks}
  </svg>`;
}

/** The day's course as a line; a gap in the data stays a gap in the line. */
function curveChart(curve: { minute: number; count: number }[], intervalMinutes: number): string {
  const width = 660;
  const height = 150;
  const pad = { left: 26, bottom: 18, top: 8 };
  if (curve.length === 0) {
    return `<p class="muted">Für diesen Tag wurden keine Messpunkte aufgezeichnet.</p>`;
  }
  const max = Math.max(1, ...curve.map((p) => p.count));
  const x = (minute: number) => pad.left + (minute / (24 * 60)) * (width - pad.left - 6);
  const y = (count: number) => height - pad.bottom - ((height - pad.top - pad.bottom) * count) / max;
  const gap = Math.max(intervalMinutes * 3, 15);
  const segments: string[] = [];
  let current: string[] = [];
  let previous = -Infinity;
  for (const point of curve) {
    if (point.minute - previous > gap && current.length) {
      segments.push(current.join(" "));
      current = [];
    }
    current.push(`${current.length ? "L" : "M"} ${x(point.minute).toFixed(1)} ${y(point.count).toFixed(1)}`);
    previous = point.minute;
  }
  if (current.length) segments.push(current.join(" "));
  const paths = segments
    .map((d) => `<path d="${d}" fill="none" stroke="#2a78d6" stroke-width="1.6" stroke-linejoin="round"/>`)
    .join("");
  const ticks = [0, 6, 12, 18, 24]
    .map(
      (hour) =>
        `<text x="${x(hour * 60).toFixed(1)}" y="${height - 5}" font-size="9" text-anchor="middle" fill="#6b7280">${hour}</text>`,
    )
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Verlauf über den Tag">
    <line x1="${pad.left}" x2="${width - 6}" y1="${height - pad.bottom}" y2="${height - pad.bottom}" stroke="#d1d5db"/>
    <text x="${pad.left - 6}" y="${pad.top + 8}" font-size="9" text-anchor="end" fill="#6b7280">${max}</text>
    ${paths}${ticks}
  </svg>`;
}

/**
 * One day of one list as a self-contained A4 page. No scripts, no external
 * files — it has to still open in five years.
 */
export function renderDayReport(input: DayReportInput): string {
  const first = input.curve[0]?.count ?? 0;
  const last = input.curve[input.curve.length - 1]?.count ?? 0;
  const peak = input.curve.reduce((best, p) => (p.count > best.count ? p : best), { minute: 0, count: 0 });
  const intakeTotal = input.intake.reduce((sum, n) => sum + n, 0);
  const byPerson = new Map<string, number>();
  for (const claim of input.claims) {
    const name = claim.assigneeName || `#${claim.assigneeId}`;
    byPerson.set(name, (byPerson.get(name) ?? 0) + 1);
  }
  const people = [...byPerson.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "de"));

  const claimRows = [...input.claims]
    .sort((a, b) => a.minute - b.minute)
    .map(
      (c) => `<tr>
        <td class="mono">${clock(c.minute)}</td>
        <td class="mono">#${c.id}</td>
        <td>${esc(c.title || "—")}</td>
        <td>${esc(c.assigneeName || `#${c.assigneeId}`)}</td>
        <td class="muted">${c.fromId > 0 ? esc(c.fromName || `#${c.fromId}`) : "war unzugewiesen"}</td>
      </tr>`,
    )
    .join("");

  const hourRows = input.intake
    .map((n, hour) => (n > 0 ? `<tr><td class="mono">${String(hour).padStart(2, "0")}–${String(hour + 1).padStart(2, "0")}</td><td class="mono">${n}</td></tr>` : ""))
    .join("");

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>${esc(input.listLabel)} · ${esc(input.day)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #fff; color: #14181f;
    font: 11pt/1.45 "Helvetica Neue", Arial, sans-serif;
    max-width: 178mm; margin-inline: auto; padding: 10mm 0;
  }
  h1 { font-size: 17pt; margin: 0 0 2mm; }
  h2 { font-size: 12pt; margin: 8mm 0 2mm; padding-bottom: 1mm; border-bottom: 1px solid #d1d5db; }
  .sub { color: #6b7280; font-size: 9.5pt; margin: 0 0 6mm; }
  .mono { font-family: "SF Mono", Consolas, monospace; font-variant-numeric: tabular-nums; }
  .muted { color: #6b7280; }
  .figures { display: flex; gap: 6mm; flex-wrap: wrap; margin-bottom: 4mm; }
  .figure { border: 1px solid #d1d5db; border-radius: 3px; padding: 3mm 4mm; min-width: 32mm; }
  .figure b { display: block; font-size: 15pt; font-weight: 600; }
  .figure span { font-size: 8.5pt; color: #6b7280; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  th { text-align: left; font-weight: 600; border-bottom: 1px solid #d1d5db; padding: 1.5mm 2mm; }
  td { padding: 1.2mm 2mm; border-bottom: 1px solid #eef0f3; vertical-align: top; }
  .chips span { display: inline-block; border: 1px solid #d1d5db; border-radius: 999px; padding: 0.6mm 2.5mm; margin: 0 1.5mm 1.5mm 0; font-size: 9pt; }
  .note { font-size: 8.5pt; color: #6b7280; margin-top: 8mm; border-top: 1px solid #eef0f3; padding-top: 2mm; }
  section { break-inside: avoid; }
</style>
</head>
<body>
  <h1>${esc(input.listLabel)}</h1>
  <p class="sub">${esc(formatLongDate(input.day))} · erzeugt ${new Date(input.createdAt * 1000).toLocaleString("de-DE")}</p>

  <div class="figures">
    <div class="figure"><b>${last}</b><span>Tickets am Tagesende</span></div>
    <div class="figure"><b>${first}</b><span>zu Beginn der Messung</span></div>
    <div class="figure"><b>${peak.count}</b><span>Höchststand${peak.count ? ` um ${clock(peak.minute)}` : ""}</span></div>
    <div class="figure"><b>${intakeTotal}</b><span>neu an diesem Tag</span></div>
    <div class="figure"><b>${input.claims.length}</b><span>Übernahmen</span></div>
  </div>

  <section>
    <h2>Verlauf über den Tag</h2>
    ${curveChart(input.curve, input.intervalMinutes)}
  </section>

  <section>
    <h2>Eingang je Stunde</h2>
    ${intakeTotal ? intakeChart(input.intake) : '<p class="muted">An diesem Tag ist kein Ticket in dieser Liste angelegt worden.</p>'}
    ${hourRows ? `<table><thead><tr><th>Stunde</th><th>neu</th></tr></thead><tbody>${hourRows}</tbody></table>` : ""}
  </section>

  <section>
    <h2>Übernommen</h2>
    ${
      people.length
        ? `<div class="chips">${people.map(([name, count]) => `<span>${esc(name)} · ${count}</span>`).join("")}</div>`
        : ""
    }
    ${
      claimRows
        ? `<table><thead><tr><th>Zeit</th><th>Ticket</th><th>Titel</th><th>übernommen von</th><th>vorher</th></tr></thead><tbody>${claimRows}</tbody></table>`
        : '<p class="muted">An diesem Tag hat niemand ein Ticket dieser Liste übernommen.</p>'
    }
  </section>

  <p class="note">
    Alle Zahlen stammen aus Messungen im Abstand von ${input.intervalMinutes} Minuten. Wo nicht gemessen wurde,
    hat die Verlaufslinie eine Lücke; Übernahmen sind auf ${input.intervalMinutes} Minuten genau. Zeiten in Europe/Berlin.
  </p>
</body>
</html>`;
}

/** "2026-08-25_view-soc.html" — sortable by name, readable in a folder. */
export function reportName(day: string, listKey: string): string {
  return `${day}_${listKey.replace(/[^a-zA-Z0-9]+/g, "-")}.html`;
}
