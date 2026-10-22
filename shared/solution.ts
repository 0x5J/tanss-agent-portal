import { STOP_WORDS, parseSimilar, type SimilarHit } from "./agent.ts";
import type { TicketRow } from "./tickets.ts";

/** How far back the done tickets of a customer are looked at. */
export const SOLUTION_LOOKBACK_DAYS = 365;
/** Candidates the pre-selection hands to the model. */
export const SOLUTION_MAX_CANDIDATES = 30;
/** Source tickets the model may pick, and the agent reads in full. */
export const SOLUTION_MAX_READ = 5;

export type SolutionCandidate = { id: number; title: string; excerpt: string; modified: number; score: number };
export type SolutionSource = { ticketId: number; title: string; modified: number; reason: string };
export type SolutionAnswer = {
  verdict: "ok" | "no-company" | "no-done" | "no-match" | "unreadable";
  text: string;
  sources: SolutionSource[];
  /** Done tickets looked at by the pre-selection. */
  checked: number;
  /** Source tickets actually read. */
  read: number;
  /** More done tickets existed than were fetched. */
  truncated: boolean;
};

export const SOLUTION_MESSAGES: Record<Exclude<SolutionAnswer["verdict"], "ok">, string> = {
  "no-company": "Ticket hat keinen Kunden — es gibt nichts zu vergleichen.",
  "no-done": "Keine erledigten Tickets dieses Kunden in den letzten 12 Monaten — oder dein TANSS-Konto darf sie nicht sehen.",
  "no-match": "Unter den erledigten Tickets dieses Kunden beschreibt keins ein ähnliches Problem.",
  unreadable: "Die passenden Tickets ließen sich nicht lesen.",
};

const EXCERPT_CHARS = 200;

/** Text of a TANSS field with tags and the common entities gone; tags separate words. */
export function plainText(html: unknown): string {
  return String(html ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Distinct lower-case words of a text that say something about a problem, in order of first use. */
export function problemWords(text: string): string[] {
  const words = plainText(text)
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  return [...new Set(words)];
}

/**
 * Done tickets that share words with the subject, best first. A subject word
 * scores 3 when it is in the candidate's title, otherwise 1 when it is in the
 * description or internal note; tickets without a hit drop out, ties go to the
 * newer one.
 */
export function rankCandidates(
  subject: { title: string; description: string },
  tickets: Record<string, unknown>[],
  limit: number = SOLUTION_MAX_CANDIDATES,
): SolutionCandidate[] {
  const wanted = problemWords(`${subject.title} ${subject.description}`);
  if (wanted.length === 0) return [];
  const ranked: SolutionCandidate[] = [];
  for (const t of tickets) {
    const id = Number(t.id);
    if (!Number.isFinite(id)) continue;
    const title = String(t.title ?? "");
    const inTitle = new Set(problemWords(title));
    const inBody = new Set(problemWords(`${plainText(t.content)} ${plainText(t.internalContent)}`));
    let score = 0;
    for (const w of wanted) score += inTitle.has(w) ? 3 : inBody.has(w) ? 1 : 0;
    if (score === 0) continue;
    ranked.push({ id, title, excerpt: plainText(t.content).slice(0, EXCERPT_CHARS), modified: Number(t.modifiedTime) || 0, score });
  }
  ranked.sort((a, b) => b.score - a.score || b.modified - a.modified);
  return ranked.slice(0, limit);
}

export function solutionPickPrompt(subject: TicketRow, description: string, candidates: SolutionCandidate[]): string {
  return (
    "Welche der erledigten Tickets unten beschreiben dasselbe Problem wie das aktuelle Ticket, sodass ihr Verlauf zeigen könnte, wie es gelöst wurde? " +
    "Nur echte Übereinstimmung (gleiche Symptome, gleiche Komponente, gleicher Vorgang), nicht bloß ein gemeinsames Stichwort. " +
    'Antworte ausschließlich als JSON: {"similar":[{"ticketId":1,"reason":"…"}]} mit höchstens 5 Einträgen, die besten zuerst — leere Liste, wenn nichts passt.\n\n' +
    `Aktuelles Ticket #${subject.id} · ${subject.companyName || "—"} · „${subject.title}"\n${clip(description, 800)}\n\nErledigte Tickets:\n` +
    candidates.map((c) => `  #${c.id} · „${c.title}"${c.excerpt ? ` · ${clip(c.excerpt, EXCERPT_CHARS)}` : ""}`).join("\n")
  );
}

export function parseSolutionPick(value: unknown, known: Set<number>): SimilarHit[] {
  return parseSimilar(value, known).slice(0, SOLUTION_MAX_READ);
}

export function solutionPrompt(
  subjectContext: string,
  sources: { ticketId: number; context: string; internalNote: string }[],
): string {
  return (
    "Schlage vor, wie das aktuelle Ticket gelöst werden kann, gestützt auf die erledigten Tickets desselben Kunden unten. " +
    "Nenne je erledigtem Ticket (mit Nummer) die Ursache und was gemacht wurde, danach einen Vorschlag für den ersten Schritt jetzt. " +
    "Sage nur, was in den Verläufen steht; erfinde nichts dazu. Zeigt kein Verlauf eine Lösung (z. B. weil das Ticket noch läuft oder der Verlauf nichts dazu sagt), sage das offen und leite nichts ab. " +
    "Antworte in kurzem Klartext auf Deutsch, nicht als JSON.\n\n" +
    `--- Aktuelles Ticket ---\n${subjectContext}\n\n` +
    sources
      .map(
        (s) =>
          `--- Erledigtes Ticket #${s.ticketId} ---\n${s.context}` +
          (s.internalNote.trim() ? `\n\nInterne Notiz am Ticket:\n${s.internalNote.trim()}` : ""),
      )
      .join("\n\n")
  );
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)} …` : t;
}
