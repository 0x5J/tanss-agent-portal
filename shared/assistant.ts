import { berlinMinuteOfDay, berlinYmd, weekdayLabel } from "./days.ts";
import type { Routine } from "./routines.ts";
import type { BookingTemplate } from "./template.ts";
import { formatClock, type Support } from "./timeline.ts";

/** Where a suggestion comes from — shown, never sent to TANSS. */
export type EvidenceKind = "termin" | "anruf" | "linear" | "luecke" | "muster" | "baustein";

export type BookingIdea = {
  minutes: number;
  text: string;
  kind: EvidenceKind;
  /** The concrete trace it rests on, or the pattern it was derived from. */
  evidence: string;
  /** False for anything derived from habit rather than from a record. */
  documented: boolean;
  /** The customer as a *name*; the portal never books on it, see below. */
  company: string;
  startMinute: number | null;
};

export type AssistantResult = {
  ideas: BookingIdea[];
  /** Said out loud when the day cannot be filled from evidence. */
  note: string;
};

/** A thing booked on this weekday more than once — a reminder, not a record. */
export type DayPattern = {
  text: string;
  company: string;
  /** The typical length, not the longest. */
  minutes: number;
  seen: number;
};

export const MAX_IDEAS = 12;
export const TARGET_MINUTES = 8 * 60;
/** How far back patterns are looked for. */
export const PATTERN_DAYS = 14;
const PATTERN_MIN_SEEN = 2;
const PATTERN_MAX = 6;

/**
 * What was booked on the same weekday before, at least twice. The duration is
 * the median: a pattern must not inflate a day because it once ran long.
 */
export function findPatterns(history: Support[], day: string): DayPattern[] {
  const weekday = weekdayLabel(day);
  const groups = new Map<string, { text: string; company: string; minutes: number[] }>();
  for (const s of history) {
    const at = berlinYmd(s.date);
    if (at === day || weekdayLabel(at) !== weekday) continue;
    const text = s.text.split("\n")[0]!.trim().slice(0, 120);
    if (!text) continue;
    const key = `${s.companyName}|${text.toLowerCase()}`;
    const group = groups.get(key) ?? { text, company: s.companyName, minutes: [] };
    group.minutes.push(s.duration);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((g) => g.minutes.length >= PATTERN_MIN_SEEN)
    .map((g) => ({ text: g.text, company: g.company, minutes: median(g.minutes), seen: g.minutes.length }))
    .sort((a, b) => b.seen - a.seen || b.minutes - a.minutes)
    .slice(0, PATTERN_MAX);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

/** Everything the assistant may reason from, and nothing else. */
export type DayContext = {
  day: string;
  booked: Support[];
  templates: BookingTemplate[];
  gaps: { start: number; end: number }[];
  routines: Routine[];
  patterns: DayPattern[];
  /** Linear issues worked on that day and not booked yet. */
  linear: { issue: string; title: string; minutes: number; notes: string }[];
  bookedMinutes: number;
  /** Set when the question is about one gap rather than the whole day. */
  focus: { start: number; end: number } | null;
};

export const ASSISTANT_RULES = `Du hilfst einem IT-Dienstleister, seinen Tag vollständig zu erfassen. Du erfindest keine Arbeit.

Ein Vorschlag stammt aus genau einer dieser drei Quellen:

1. BELEGT — es liegt eine Spur des Tages vor: ein nicht gebuchter Termin, ein
   Telefonat oder Linear-Aktivität. Setze documented auf true und nenne die
   Spur in evidence.

2. MUSTER — eine Tätigkeit, die an diesem Wochentag wiederholt gebucht wurde,
   heute aber fehlt. Setze documented auf false und schreibe in evidence,
   worauf das Muster beruht. Formuliere den Text als Rückfrage im Sinne von
   "möglicherweise", nicht als Feststellung. Ein Muster ist eine Erinnerung,
   kein Nachweis.

3. BAUSTEIN — eine wiederkehrende Tätigkeit aus der hinterlegten Liste, die
   nirgends eine Spur hinterlässt. Behandle sie wie ein Muster: documented auf
   false, kind auf "baustein", als Rückfrage formuliert. Halte dich an die
   angegebene Zeitspanne und schlage einen Baustein nur vor, wenn im Tag Platz
   dafür ist.

Weitere Grenzen:
- Runde niemals eine Dauer hoch, damit die Sollzeit aufgeht. Die Sollzeit ist
  ein Anhaltspunkt, kein Ziel, das erreicht werden muss.
- Schlage nichts vor, wofür weder Spur noch Muster existiert, auch wenn dann
  Stunden fehlen. Schreibe in note offen, wie viel unerklärt bleibt.
- Jeder Vorschlag ist ein Entwurf, den der Nutzer prüft. Formuliere nüchtern
  und täusche keine Sicherheit vor.
- Ein Leistungstext ist ein bis drei Sätze, sachlich, in der Vergangenheitsform,
  ohne Anrede und ohne Zeitangabe — die Dauer steht im eigenen Feld.

Antworte ausschließlich mit einem JSON-Objekt:
{"ideas":[{"minutes":<ganze Zahl>,"text":"…","kind":"termin|anruf|linear|luecke|muster|baustein","evidence":"…","documented":true|false,"company":"…","startMinute":<Minute des Tages oder null>}],"note":"…"}
Höchstens ${MAX_IDEAS} Einträge. "note" bleibt leer, wenn nichts offen ist.`;

function block(title: string, lines: string[], empty: string): string {
  return `${title}:\n${lines.length ? lines.map((l) => `- ${l}`).join("\n") : `- ${empty}`}`;
}

export function assistantPrompt(context: DayContext): string {
  const missing = Math.max(0, TARGET_MINUTES - context.bookedMinutes);
  const parts = [
    `Tag: ${context.day} (${weekdayLabel(context.day)})`,
    `Gebucht: ${context.bookedMinutes} von ${TARGET_MINUTES} Minuten. Offen: ${missing} Minuten.`,
    block(
      "Bereits gebucht",
      context.booked.map((s) => {
        const from = berlinMinuteOfDay(s.date);
        return `${formatClock(from)}–${formatClock(from + s.duration)} · ${s.duration} min · ${s.companyName || "ohne Kunde"} · ${s.text.split("\n")[0]!.slice(0, 160)}`;
      }),
      "nichts",
    ),
    block(
      "Termine und Anrufe ohne Buchung",
      context.templates.map(
        (t) =>
          `${t.kind === "call" ? "Anruf" : "Termin"} ${formatClock(t.startMinute)}–${formatClock(t.startMinute + t.duration)} · ${t.duration} min · ${t.title}${t.companyName ? ` (${t.companyName})` : ""}`,
      ),
      "keine",
    ),
    block(
      "Linear-Aktivität ohne Buchung",
      context.linear.map(
        (l) => `${l.issue} ${l.title} · ${l.minutes} min${l.notes ? ` · ${l.notes}` : ""}`,
      ),
      "keine",
    ),
    block(
      "Unbelegte Zeitlücken",
      context.gaps.map((g) => `${formatClock(g.start)}–${formatClock(g.end)} (${g.end - g.start} min)`),
      "keine",
    ),
    block(
      "Hinterlegte Bausteine (ohne Spur, nur als Rückfrage)",
      context.routines.map((r) => `${r.text} · ${r.minMinutes}–${r.maxMinutes} min`),
      "keine",
    ),
    block(
      `Wiederkehrend an einem ${weekdayLabel(context.day)}`,
      context.patterns.map((p) => `${p.seen}× · ${p.company || "ohne Kunde"} · ${p.minutes} min · ${p.text}`),
      "nichts erkennbar",
    ),
    context.focus
      ? `Es geht nur um die Lücke ${formatClock(context.focus.start)}–${formatClock(context.focus.end)} (${context.focus.end - context.focus.start} Minuten). Was gehört dort hin? Schlage nichts vor, was zeitlich woanders liegt, und überschreite die Länge der Lücke nicht. Gibt es dafür weder Spur noch Muster, sage das.`
      : "Welche Buchungen fehlen? Nenne für jede die Quelle.",
  ];
  return parts.join("\n\n");
}

const KINDS: EvidenceKind[] = ["termin", "anruf", "linear", "luecke", "muster", "baustein"];

/**
 * Reads the model's answer. An entry that does not fit is dropped rather than
 * repaired — a made-up duration is worse than one suggestion less.
 */
export function parseAssistant(raw: unknown): AssistantResult {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const ideas: BookingIdea[] = [];
  for (const item of Array.isArray(obj.ideas) ? obj.ideas.slice(0, MAX_IDEAS) : []) {
    if (typeof item !== "object" || item === null) continue;
    const i = item as Record<string, unknown>;
    const minutes = Math.round(Number(i.minutes ?? 0));
    const text = String(i.text ?? "").trim();
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60 || !text) continue;
    const kind = KINDS.includes(i.kind as EvidenceKind) ? (i.kind as EvidenceKind) : "luecke";
    const rawStart = Number(i.startMinute);
    ideas.push({
      minutes,
      text: text.slice(0, 2000),
      kind,
      evidence: String(i.evidence ?? "").trim().slice(0, 500),
      // Only an explicit true counts as documented; anything else is a guess.
      documented: i.documented === true,
      company: String(i.company ?? "").trim().slice(0, 200),
      startMinute:
        Number.isInteger(rawStart) && rawStart >= 0 && rawStart < 24 * 60 ? rawStart : null,
    });
  }
  return { ideas, note: String(obj.note ?? "").trim().slice(0, 1000) };
}
