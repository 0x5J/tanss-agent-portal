/**
 * What the chat agent may ask for and how its results are worded. All three
 * tools only read. Nothing here knows TANSS or Fastify, so it is testable
 * with fixtures — like the prompts in agent.ts.
 */
import { berlinYmd, formatShortDate } from "./days.ts";
import type { TicketRow } from "./tickets.ts";
import type { Support } from "./timeline.ts";

/** Hits one search may hand to the model; more is noise it cannot weigh. */
export const MAX_SEARCH_ROWS = 15;
/** Below this many characters a ticket read is not worth a round. */
export const MIN_READ_CHARS = 1_500;
/** Bookings one tool call reports; the newest ones. */
export const MAX_SUPPORT_ROWS = 20;

export const BUDGET_EXHAUSTED =
  "Kein Platz mehr für weitere Verläufe — bitte mit dem bereits Gelesenen antworten und sagen, was ungeprüft blieb.";

export const TICKET_LIMIT_REACHED =
  "Es sind schon drei Verläufe gelesen — bitte mit diesen antworten und sagen, was ungeprüft blieb.";

/** A failed search, told apart from a genuinely empty one — the source line must not claim it was checked when it was not. */
export function searchFailedText(query: string): string {
  return `Die Suche nach „${query}" ist fehlgeschlagen — kein Ergebnis, nicht geprüft.`;
}

export const CHAT_TOOLS = [
  {
    name: "tickets_suchen",
    description:
      "Sucht Tickets in TANSS und im offenen Board nach einem Begriff — Kundenname, Stichwort aus dem Titel. " +
      "Gibt Ticketnummern mit Kunde, Titel, Status und Zuständigem zurück, aber keinen Verlauf.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: `Suchbegriff, z. B. „Müller" oder „Backup"` } },
      required: ["text"],
    },
  },
  {
    name: "ticket_lesen",
    description:
      "Liest ein Ticket samt Verlauf: Beschreibung, Kommentare, Mails und Leistungen, die neuesten zuerst. " +
      "Höchstens drei Tickets je Gespräch — nimm die, auf die es wirklich ankommt.",
    parameters: {
      type: "object",
      properties: { id: { type: "integer", description: "Ticketnummer, z. B. 4711" } },
      required: ["id"],
    },
  },
  {
    name: "leistungen_ticket",
    description:
      "Zeigt die auf ein Ticket gebuchten Leistungen des letzten Jahres: Datum, Dauer, wer gebucht hat und die erste Zeile des Textes. " +
      `Gut für „wie viel Zeit steckt da schon drin".`,
    parameters: {
      type: "object",
      properties: { id: { type: "integer", description: "Ticketnummer, z. B. 4711" } },
      required: ["id"],
    },
  },
] as const;

export const CHAT_TOOL_NAMES = CHAT_TOOLS.map((t) => t.name);

/** How many characters the next ticket may take: a third of the total, capped by what is left. */
export function readShare(total: number, left: number): number {
  return Math.max(0, Math.min(left, Math.round(total / 3)));
}

export function searchResultText(query: string, rows: TicketRow[], max = MAX_SEARCH_ROWS): string {
  if (rows.length === 0) return `Keine Tickets zu „${query}" gefunden.`;
  const lines = rows.slice(0, max).map(
    (r) =>
      `#${r.id} · ${r.companyName || "—"} · „${r.title}" · Status ${r.statusName || "—"} · ` +
      `Zuständig ${r.assigneeName || "offen"} · geändert ${r.modified ? formatShortDate(berlinYmd(r.modified)) : "—"}`,
  );
  const rest = rows.length - lines.length;
  const more = rest > 0 ? `\n… ${rest} weitere Treffer, bitte genauer suchen.` : "";
  return `Treffer zu „${query}" (${rows.length}):\n${lines.join("\n")}${more}`;
}

export function supportsText(supports: Support[], myEmployeeId: number, max = MAX_SUPPORT_ROWS): string {
  if (supports.length === 0) return "Auf diesem Ticket sind keine Leistungen gebucht.";
  const total = supports.reduce((sum, s) => sum + s.duration, 0);
  const lines = [...supports]
    .sort((a, b) => a.date - b.date)
    .slice(-max)
    .map(
      (s) =>
        `${s.date ? formatShortDate(berlinYmd(s.date)) : "—"} · ${s.duration} min · ` +
        `${s.employeeId === myEmployeeId ? "ich" : "Kollege"} · ${s.text.split("\n")[0].trim() || "—"}`,
    );
  return `Gebuchte Leistungen (${supports.length}, zusammen ${total} min):\n${lines.join("\n")}`;
}
