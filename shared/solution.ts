import { STOP_WORDS, parseSimilar, stripMailNoise, type SimilarHit } from "./agent.ts";
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

/**
 * Distinct lower-case words of a text that say something about a problem, in
 * order of first use. Hyphens separate words ("Drucker-Warteschlange").
 */
export function problemWords(text: string): string[] {
  const words = plainText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  return [...new Set(words)];
}

/** A subject word this long also matches a longer word that contains it ("drucker" in "etikettendrucker"). */
const PART_MATCH_MIN = 5;
/** Lists are weighed as if they had at least this many tickets, so tiny lists still score. */
const IDF_MIN_LIST = 7;
/**
 * A body hit qualifies a candidate only for a word with weight ≥ 0.5, i.e.
 * df ≤ N^(1 − 0.5) = √N — checked on df, so rounding cannot tip it.
 */
const BODY_QUALIFY_WEIGHT = 0.5;

/**
 * A TANSS description as text that keeps its lines, so stripMailNoise can
 * cut greeting, signature and quoted mails: block ends and <br> become line
 * breaks, other tags a space.
 */
function plainLines(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n");
}

/** The words of a text, for exact lookup and for part matches. */
function wordIndex(text: string): { set: Set<string>; joined: string } {
  const words = problemWords(text);
  return { set: new Set(words), joined: ` ${words.join(" ")} ` };
}

function hasWord(index: { set: Set<string>; joined: string }, word: string): boolean {
  // Words carry no spaces, so a substring of the joined list is a part of one word.
  return index.set.has(word) || (word.length >= PART_MATCH_MIN && index.joined.includes(word));
}

/**
 * Done tickets that share words with the subject, best first.
 *
 * Subject words come from the title and the description without greeting,
 * signature and quoted mails (stripMailNoise). Each word has a weight
 * ln(N / df) / ln(N), with N the number of done tickets (at least 7) and df
 * the tickets it hits — 1 for a word only one ticket has, 0 for a word every
 * ticket has.
 *
 * Qualifying and ranking are separate. A candidate qualifies only through a
 * subject word with weight > 0 in its title, or one with weight ≥
 * BODY_QUALIFY_WEIGHT (df ≤ √N) in its description or internal note. Mail
 * signatures, greetings and addresses never sit in titles and are frequent
 * in bodies, so they cannot qualify a ticket, however many of them add up —
 * one customer's tickets from several senders keep each signature at a
 * middling weight, which a score floor could not tell from a topic.
 * Qualified candidates rank by the sum over all subject words: 3 × weight
 * for a title hit, otherwise 1 × weight for a body hit, a word once per
 * candidate. Ties go to the newer ticket. Lists under 7 tickets are weighed
 * as if they had 7, so every word keeps a weight there.
 */
export function rankCandidates(
  subject: { title: string; description: string },
  tickets: Record<string, unknown>[],
  limit: number = SOLUTION_MAX_CANDIDATES,
): SolutionCandidate[] {
  const wanted = problemWords(`${subject.title}\n${stripMailNoise(plainLines(subject.description))}`);
  if (wanted.length === 0) return [];
  const indexed = tickets
    .map((t) => ({
      t,
      id: Number(t.id),
      title: wordIndex(String(t.title ?? "")),
      body: wordIndex(`${plainText(t.content)} ${plainText(t.internalContent)}`),
    }))
    .filter((c) => Number.isFinite(c.id));

  const n = Math.max(IDF_MIN_LIST, indexed.length);
  const weights = new Map<string, { weight: number; rare: boolean }>();
  for (const w of wanted) {
    const df = indexed.filter((c) => hasWord(c.title, w) || hasWord(c.body, w)).length;
    if (df > 0) weights.set(w, { weight: Math.log(n / df) / Math.log(n), rare: df <= n ** (1 - BODY_QUALIFY_WEIGHT) });
  }

  const ranked: SolutionCandidate[] = [];
  for (const { t, id, title, body } of indexed) {
    let score = 0;
    let qualifies = false;
    for (const [w, { weight, rare }] of weights) {
      if (hasWord(title, w)) {
        score += 3 * weight;
        qualifies ||= weight > 0;
      } else if (hasWord(body, w)) {
        score += weight;
        qualifies ||= rare;
      }
    }
    if (!qualifies) continue;
    ranked.push({
      id,
      title: String(t.title ?? ""),
      excerpt: plainText(t.content).slice(0, EXCERPT_CHARS),
      modified: Number(t.modifiedTime) || 0,
      score,
    });
  }
  ranked.sort((a, b) => b.score - a.score || b.modified - a.modified);
  return ranked.slice(0, limit);
}

export function solutionPickPrompt(subject: TicketRow, description: string, candidates: SolutionCandidate[]): string {
  return (
    "Welche der erledigten Tickets unten beschreiben dasselbe Problem wie das aktuelle Ticket, sodass ihr Verlauf zeigen könnte, wie es gelöst wurde? " +
    "Nur echte Übereinstimmung (gleiche Symptome, gleiche Komponente, gleicher Vorgang), nicht bloß ein gemeinsames Stichwort. " +
    'Antworte ausschließlich als JSON: {"similar":[{"ticketId":1,"reason":"…"}]} mit höchstens 5 Einträgen, die besten zuerst — leere Liste, wenn nichts passt.\n\n' +
    `Aktuelles Ticket #${subject.id} · ${subject.companyName || "—"} · „${subject.title}"\n${clip(plainText(description), 800)}\n\nErledigte Tickets:\n` +
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
