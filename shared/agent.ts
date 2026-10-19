/**
 * What the agent is given and what it is asked. Everything deterministic —
 * facts, context text, prompts, answer parsing — lives here so it can be
 * tested without a model.
 */
import { formatElapsed, ticketIdleDays, type Activity } from "./activity.ts";
import { berlinMinuteOfDay, berlinYmd, formatShortDate, shiftYmd } from "./days.ts";
import { styleSection, type StyleSettings } from "./style.ts";
import type { ThreadEntry } from "./thread.ts";
import { rowTone, type TicketRow } from "./tickets.ts";
import { formatClock, type Support } from "./timeline.ts";

/** A booking the agent suggests; executed only when a person approves it. */
export type Proposal = {
  id: string;
  employeeId: number;
  createdAt: number;
  kind: "booking";
  /** Why the agent thinks so, in one or two sentences. */
  reason: string;
  /** The traces it built on, as short lines. */
  evidence: string[];
  booking: {
    date: string;
    startMinute: number;
    duration: number;
    ticketId?: number;
    ticketTitle: string;
    companyId?: number;
    companyName: string;
    typeId: number;
    location: "OFFICE" | "CUSTOMER" | "REMOTE";
    text: string;
  };
};

export const SYSTEM_PROMPT =
  "Du bist der Assistent eines IT-Systemhaus-Technikers und arbeitest mit dem Ticketsystem TANSS. " +
  "Antworte auf Deutsch, sachlich und knapp. Erfinde keine Fakten: alles, was du sagst, muss aus dem " +
  "gegebenen Kontext folgen. Wenn der Kontext nicht reicht, sag das.";

/** Context window the budgets assume when the settings do not say. */
export const DEFAULT_CONTEXT_TOKENS = 32_768;
/** German prose in a typical tokenizer: about this many characters per token. */
const CHARS_PER_TOKEN = 3.2;
/** Tokens held back for instructions and the answer. */
const RESERVED_TOKENS = 2_500;

/**
 * What one ticket's thread may take up, in characters, for a model with the
 * given context window. Bounded so a tiny window still gets a useful thread
 * and a huge one does not drag whole mail archives along.
 */
export function threadBudget(contextTokens: number): number {
  const usable = Math.max(0, contextTokens - RESERVED_TOKENS) * CHARS_PER_TOKEN;
  return Math.round(Math.min(120_000, Math.max(8_000, usable * 0.7)));
}

/** Ticket plus thread as compact text, newest entries kept when it is long. */
export function ticketContext(ticket: TicketRow, thread: ThreadEntry[], maxChars = threadBudget(DEFAULT_CONTEXT_TOKENS)): string {
  const head = [
    `Ticket #${ticket.id}: ${ticket.title}`,
    `Kunde: ${ticket.companyName || "—"}${ticket.projectName ? ` · Projekt: ${ticket.projectName}` : ""}`,
    `Status: ${ticket.statusName || "—"} · Typ: ${ticket.typeName || "—"} · Zuständig: ${ticket.assigneeName || "offen"}`,
    `Erstellt: ${ticket.creationDate ? dateLabel(ticket.creationDate) : "—"}`,
  ].join("\n");
  const entries = thread.map((e) => {
    const when = e.at ? dateLabel(e.at) : "";
    const kind = e.kind === "Leistung" ? `Leistung (${e.duration} min)` : e.kind;
    const subject = e.title && e.kind !== "Beschreibung" ? ` „${e.title}"` : "";
    // Mails go in without quoted history and signatures — the thread has those already.
    const body = e.kind.startsWith("Mail") ? stripMailNoise(e.text) : e.text;
    // One entry may take up to a quarter of the budget, so a long mail does not eat it all.
    return `[${when}] ${kind} von ${e.author}${subject}:\n${clip(body, Math.max(2_000, Math.floor(maxChars / 4)))}`;
  });
  // Keep the description and as many of the newest entries as fit.
  const [description, ...rest] = entries;
  const kept: string[] = [];
  let size = head.length + (description?.length ?? 0);
  for (const entry of [...rest].reverse()) {
    if (size + entry.length > maxChars) break;
    kept.unshift(entry);
    size += entry.length;
  }
  const dropped = rest.length - kept.length;
  return [
    head,
    "",
    description ?? "",
    dropped > 0 ? `\n(… ${dropped} ältere Einträge ausgelassen …)\n` : "",
    ...kept,
  ].join("\n");
}

export function summaryPrompt(context: string): string {
  return (
    "Fasse den Stand dieses Tickets in höchstens fünf kurzen Zeilen zusammen: Was ist das Problem, " +
    "was wurde getan, was ist offen, wer ist am Zug. Keine Einleitung, keine Überschrift.\n\n" +
    context
  );
}

/**
 * The activity text for one issue of the day import. The raw material is what
 * was noted in Linear; the job is to bring it into the shape a booking text
 * has here — the user's own style included.
 */
export function issueTextPrompt(
  material: { issue: string; title: string; project: string; notes: string },
  style: StyleSettings | null,
): string {
  const notes = material.notes.trim();
  return [
    "Fasse zusammen, was an diesem Issue getan wurde, und bring es in die beschriebene Form. Nur den Text liefern.",
    style ? styleSection(style) : "",
    `Issue: ${material.issue} — ${material.title}`,
    `Projekt: ${material.project}`,
    notes
      ? `Eigene Arbeitsnotizen des Tages:\n${notes}`
      : "Für diesen Tag gibt es keine Arbeitsnotizen. Stütze dich nur auf Titel und Projekt und bleib entsprechend knapp.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type DraftIntent = "status" | "summary" | "close" | "custom" | "support" | "reply";

export const DRAFT_INTENTS: { id: DraftIntent; label: string }[] = [
  { id: "status", label: "Statusanfrage an den Kunden" },
  { id: "summary", label: "Zusammenfassung für den Kunden" },
  { id: "close", label: "Abschlussnotiz" },
  { id: "custom", label: "Eigene Anweisung" },
];

export function draftPrompt(
  intent: DraftIntent,
  instruction: string,
  internal: boolean,
  contexts: string[],
  authorName: string,
  focus = "",
  /** The user's own style; only booking texts follow it. */
  style: StyleSettings | null = null,
): string {
  if (intent === "support") {
    return (
      "Formuliere den Tätigkeitstext für eine Leistungsbuchung zu diesem Ticket: was wurde zuletzt konkret getan " +
      "(nach den neuesten Kommentaren, Mails und Leistungen). Nur den Text liefern." +
      (instruction ? ` Hinweis: ${instruction}` : "") +
      (style ? `\n\n${styleSection(style)}` : "") +
      "\n\n" +
      contexts.join("\n\n")
    );
  }
  if (intent === "reply") {
    return (
      "Entwirf eine Antwort auf die unten markierte eingehende Mail. Beziehe dich auf ihre Fragen und den Stand aus " +
      "dem Ticketverlauf; freundlich, per Sie, ohne Interna, ohne Betreff. Nur den Text liefern." +
      (authorName ? ` Unterschrift: ${authorName}.` : "") +
      (instruction ? ` Hinweis: ${instruction}` : "") +
      `\n\n=== Zu beantwortende Mail ===\n${focus}\n=== Ende ===\n\n` +
      contexts.join("\n\n")
    );
  }
  const audience = internal
    ? "Der Text ist eine interne Notiz, nur Kollegen lesen ihn."
    : "Der Text geht als Kommentar an den Kunden: freundlich, per Sie, ohne Interna.";
  const task =
    intent === "status"
      ? "Entwirf eine kurze Nachfrage beim Kunden nach dem aktuellen Stand bzw. einer ausstehenden Rückmeldung."
      : intent === "summary"
        ? "Entwirf eine Zusammenfassung des bisherigen Verlaufs und des nächsten Schritts."
        : intent === "close"
          ? "Entwirf eine Abschlussnotiz: was war das Problem, was war die Lösung."
          : `Anweisung: ${instruction}`;
  const multi =
    contexts.length > 1
      ? ` Der Text wird in ${contexts.length} Tickets gleichzeitig eingetragen, also nichts Ticketspezifisches nennen, nur das Gemeinsame.`
      : "";
  return (
    `${task} ${audience}${multi} Nur den Text liefern, ohne Betreff, Anrede-Variablen oder Erklärung.` +
    (authorName ? ` Unterschrift: ${authorName}.` : "") +
    "\n\n" +
    contexts.join("\n\n---\n\n")
  );
}

/** The row lines the briefing and the pattern search see. */
export function rowLine(
  row: TicketRow,
  activity: Activity | undefined,
  today: string,
  since: string,
  nowUnix: number,
): string {
  const idle = activity ? ticketIdleDays(row.creationDate, activity, today, since) : null;
  // A lower bound has no moment to point at, so it stays in days.
  const idleText = idle ? (idle.atLeast ? `> ${idle.days} d` : formatElapsed(idle.at, nowUnix)) : "";
  return (
    `#${row.id} · ${row.companyName || "—"} · „${row.title}" · Status ${row.statusName || "—"} · ` +
    `Zuständig ${row.assigneeName || "offen"} · ${formatElapsed(row.creationDate, nowUnix)} alt` +
    (idle ? ` · ${idleText} inaktiv` : "")
  );
}

export type BriefingFacts = {
  total: number;
  mine: number;
  newSinceYesterday: number[];
  overdue: number[];
  waiting: number[];
  stale: number[];
  unassigned: number[];
};

export function briefingFacts(
  rows: TicketRow[],
  activity: Record<number, Activity>,
  employeeId: number,
  today: string,
  since: string,
  nowUnix: number,
): BriefingFacts {
  const yesterday = shiftYmd(today, -1);
  const facts: BriefingFacts = {
    total: rows.length,
    mine: 0,
    newSinceYesterday: [],
    overdue: [],
    waiting: [],
    stale: [],
    unassigned: [],
  };
  for (const row of rows) {
    const mine = row.assigneeId === employeeId;
    if (mine) facts.mine++;
    if (row.creationDate && berlinYmd(row.creationDate) >= yesterday) facts.newSinceYesterday.push(row.id);
    const tone = rowTone(row, nowUnix);
    if (tone === "overdue") facts.overdue.push(row.id);
    if (row.waiting) facts.waiting.push(row.id);
    if (!row.assigneeId) facts.unassigned.push(row.id);
    const a = activity[row.id];
    if (mine && a && ticketIdleDays(row.creationDate, a, today, since).days >= 7) facts.stale.push(row.id);
  }
  return facts;
}

/** What a briefing is about: everything of mine, or one list of the board. */
export type BriefingScope = { kind: "mine" } | { kind: "list"; label: string };

export function briefingPrompt(
  facts: BriefingFacts,
  rows: TicketRow[],
  activity: Record<number, Activity>,
  today: string,
  since: string,
  nowUnix: number,
  scope: BriefingScope = { kind: "mine" },
): string {
  const lines = (ids: number[]) =>
    ids
      .slice(0, 25)
      .map((id) => rows.find((r) => r.id === id))
      .filter((r): r is TicketRow => Boolean(r))
      .map((r) => "  " + rowLine(r, activity[r.id], today, since, nowUnix))
      .join("\n");
  return (
    `Heute ist ${formatShortDate(today)}. ` +
    (scope.kind === "mine"
      ? "Schreibe ein Morgen-Briefing über meine eigenen Tickets"
      : `Schreibe ein Briefing über die Ticketliste „${scope.label}"`) +
    " in höchstens sechs Sätzen, Fließtext, keine Liste, keine Überschrift. Nenne Ticketnummern mit #. " +
    "Hebe hervor, was zusammengehört oder dringend wirkt; Zahlen nur aus den Fakten unten, nichts dazu erfinden.\n\n" +
    (scope.kind === "mine"
      ? `Fakten: ${facts.total} offene Tickets bei mir.\n`
      : `Fakten: ${facts.total} Tickets in der Liste, ${facts.mine} davon bei mir.\n`) +
    `Neu seit gestern (${facts.newSinceYesterday.length}):\n${lines(facts.newSinceYesterday) || "  keine"}\n` +
    `Überfällig (${facts.overdue.length}):\n${lines(facts.overdue) || "  keine"}\n` +
    `Meine seit ≥7 Tagen inaktiv (${facts.stale.length}):\n${lines(facts.stale) || "  keine"}\n` +
    `Unzugewiesen (${facts.unassigned.length}):\n${lines(facts.unassigned) || "  keine"}\n` +
    `Wartet auf Kunde: ${facts.waiting.length}`
  );
}

export type PatternGroup = { ticketIds: number[]; reason: string };

export function patternsPrompt(
  rows: TicketRow[],
  activity: Record<number, Activity>,
  today: string,
  since: string,
  nowUnix: number,
): string {
  return (
    "Unten stehen offene Tickets. Finde Gruppen von Tickets, die wahrscheinlich denselben Vorfall, dasselbe " +
    "System oder dasselbe Thema betreffen (gleicher Kunde und ähnliche Symptome, gleiche Fehlermeldung, Folgetickets). " +
    "Nur Gruppen mit mindestens zwei Tickets; keine Gruppe erfinden, wenn nichts zusammengehört. " +
    'Antworte ausschließlich als JSON: {"groups":[{"ticketIds":[1,2],"reason":"…"}]}\n\n' +
    rows.map((r) => rowLine(r, activity[r.id], today, since, nowUnix)).join("\n")
  );
}

export function parsePatterns(value: unknown, known: Set<number>): PatternGroup[] {
  const groups = (value as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) return [];
  const seen = new Set<number>();
  const result: PatternGroup[] = [];
  for (const g of groups) {
    const raw = (g as { ticketIds?: unknown; reason?: unknown }) ?? {};
    const ids = Array.isArray(raw.ticketIds)
      ? [...new Set(raw.ticketIds.map(Number).filter((n) => known.has(n) && !seen.has(n)))]
      : [];
    if (ids.length < 2) continue;
    for (const id of ids) seen.add(id);
    result.push({ ticketIds: ids, reason: String(raw.reason ?? "").trim() });
  }
  return result;
}

/** One ticket the gap search may attribute the time to. */
export type GapCandidate = {
  ticket: TicketRow;
  /** My comments that day, as "[HH:MM] text". */
  comments: string[];
};

export type GapAnswer = {
  ticketId: number | null;
  text: string;
  reason: string;
};

export function gapPrompt(
  day: string,
  start: number,
  end: number,
  candidates: GapCandidate[],
  daySupports: Support[],
): string {
  const booked = daySupports
    .filter((s) => berlinYmd(s.date) === day)
    .sort((a, b) => a.date - b.date)
    .map((s) => {
      const from = berlinMinuteOfDay(s.date);
      return `  ${formatClock(from)}–${formatClock(from + s.duration)} ${s.ticketId ? `#${s.ticketId} ` : ""}${s.companyName}: ${clip(s.text.split("\n")[0], 120)}`;
    })
    .join("\n");
  const list = candidates
    .map(
      (c) =>
        `  #${c.ticket.id} · ${c.ticket.companyName || "—"} · „${c.ticket.title}" · Status ${c.ticket.statusName || "—"}` +
        (c.ticket.modified ? ` · geändert ${clockOf(c.ticket.modified, day)}` : "") +
        (c.comments.length ? `\n    meine Kommentare: ${c.comments.map((x) => clip(x, 200)).join(" | ")}` : ""),
    )
    .join("\n");
  return (
    `Am ${formatShortDate(day)} ist zwischen ${formatClock(start)} und ${formatClock(end)} keine Leistung gebucht. ` +
    "Entscheide anhand der Spuren unten, an welchem Ticket ich in dieser Zeit am wahrscheinlichsten gearbeitet habe, " +
    "und formuliere einen Leistungstext für die Buchung (1–2 Sätze, Vergangenheitsform, fachlich). " +
    "Gibt es keinen belastbaren Anhaltspunkt, setze ticketId auf null und erkläre das in reason. " +
    'Antworte ausschließlich als JSON: {"ticketId":4711,"text":"…","reason":"…"}\n\n' +
    `Bereits gebucht an dem Tag:\n${booked || "  nichts"}\n\n` +
    `Eigene Tickets mit Spuren an dem Tag:\n${list || "  keine"}`
  );
}

export function parseGapAnswer(value: unknown, candidates: Set<number>): GapAnswer {
  const raw = (value as { ticketId?: unknown; text?: unknown; reason?: unknown } | null) ?? {};
  const id = Number(raw.ticketId ?? 0);
  return {
    ticketId: Number.isInteger(id) && id > 0 && candidates.has(id) ? id : null,
    text: String(raw.text ?? "").trim(),
    reason: String(raw.reason ?? "").trim(),
  };
}

// --- next step ---------------------------------------------------------------

export type NextStep = { text: string; owner: string; statusName: string | null };

export function nextStepPrompt(context: string, stateNames: string[]): string {
  return (
    "Was ist der nächste Schritt in diesem Ticket? Antworte ausschließlich als JSON: " +
    '{"text":"ein Satz, was konkret zu tun ist","owner":"wir|Kunde|Kollege","status":"Name oder null"}. ' +
    "status ist nur dann gesetzt, wenn der Ticketstatus nach dem Verlauf offensichtlich nicht mehr passt, und dann exakt " +
    `einer dieser Namen: ${stateNames.map((n) => `„${n}"`).join(", ") || "(keine bekannt)"}.\n\n` +
    context
  );
}

export function parseNextStep(value: unknown, stateNames: string[]): NextStep {
  const raw = (value as { text?: unknown; owner?: unknown; status?: unknown } | null) ?? {};
  const status = String(raw.status ?? "").trim();
  const match = stateNames.find((n) => n.toLowerCase() === status.toLowerCase()) ?? null;
  return { text: String(raw.text ?? "").trim(), owner: String(raw.owner ?? "").trim(), statusName: match };
}

// --- similar tickets ---------------------------------------------------------

export type SimilarHit = { ticketId: number; reason: string };

/** Words of a title worth searching for: no stop words, no short tokens. */
export function searchTerms(title: string): string {
  const stop = new Set(["und", "oder", "der", "die", "das", "für", "mit", "auf", "von", "bei", "nach", "über", "nicht", "mehr", "eine", "einen", "einer", "dem", "den", "des", "ist", "seit", "zum", "zur", "wird", "kein", "keine", "neue", "neuer", "neues"]);
  return title
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stop.has(w.toLowerCase()))
    .slice(0, 4)
    .join(" ");
}

export function similarPrompt(subject: TicketRow, description: string, candidates: TicketRow[]): string {
  return (
    `Welche der Kandidaten unten betreffen wahrscheinlich dasselbe Problem, dasselbe System oder denselben Vorgang wie das Ticket? ` +
    "Nur echte Ähnlichkeit (gleiche Symptome, gleiche Komponente, Folgeticket), nicht bloß derselbe Kunde. " +
    'Antworte ausschließlich als JSON: {"similar":[{"ticketId":1,"reason":"…"}]} — leere Liste, wenn nichts passt.\n\n' +
    `Ticket #${subject.id} · ${subject.companyName || "—"} · „${subject.title}"\n${clip(description, 800)}\n\nKandidaten:\n` +
    candidates.map((r) => `  #${r.id} · ${r.companyName || "—"} · „${r.title}" · Status ${r.statusName || "—"}`).join("\n")
  );
}

export function parseSimilar(value: unknown, known: Set<number>): SimilarHit[] {
  const list = (value as { similar?: unknown } | null)?.similar;
  if (!Array.isArray(list)) return [];
  const seen = new Set<number>();
  const out: SimilarHit[] = [];
  for (const item of list) {
    const raw = (item as { ticketId?: unknown; reason?: unknown }) ?? {};
    const id = Number(raw.ticketId);
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ ticketId: id, reason: String(raw.reason ?? "").trim() });
  }
  return out;
}

// --- customer check ----------------------------------------------------------

/** A company TANSS knows, as the pick step sees it. */
export type CompanyCandidate = { id: number; name: string; city: string; domain: string };

/** What the check found: the named company, the pick and how it compares to the ticket. */
export type CompanyCheck = {
  mentioned: string;
  evidence: string;
  currentCompanyName: string;
  suggestion: { companyId: number; name: string; reason: string } | null;
  candidates: CompanyCandidate[];
  verdict: "matches" | "none-named" | "not-found" | "differs";
};

export function mentionedCompanyPrompt(source: string): string {
  return (
    "Für welche Kundenfirma ist dieses Ticket? Nenne nur den Firmennamen, der im Text als Auftraggeber oder " +
    "Betroffener auftritt — nicht Hersteller, Lieferanten oder nebenbei erwähnte Dritte, und nicht uns als " +
    "Dienstleister. Die Absenderadresse der Mail ist ein starker Hinweis. Steht keine Firma im Text, ist name null. " +
    'Antworte ausschließlich als JSON: {"name":"Firma oder null","evidence":"das Zitat, auf dem das beruht"}.\n\n' +
    source
  );
}

export function parseMentionedCompany(value: unknown): { name: string; evidence: string } {
  const raw = (value as { name?: unknown; evidence?: unknown } | null) ?? {};
  const name = String(raw.name ?? "").trim();
  return {
    // A model that means "none" sometimes writes the word instead of the value.
    name: /^(null|none|keine?|unbekannt|-)$/i.test(name) ? "" : name,
    evidence: String(raw.evidence ?? "").trim(),
  };
}

export function companyPickPrompt(mentioned: string, evidence: string, candidates: CompanyCandidate[]): string {
  return (
    `Im Ticket ist „${mentioned}“ als Kunde genannt${evidence ? ` („${clip(evidence, 300)}“)` : ""}. ` +
    "Welcher der Kunden aus TANSS ist damit gemeint? Nur wählen, wenn es wirklich dieselbe Firma ist — bei bloß " +
    "ähnlichem Namen, anderem Standort oder Zweifel ist companyId null. " +
    'Antworte ausschließlich als JSON: {"companyId":1,"reason":"warum dieser"}.\n\nKunden in TANSS:\n' +
    candidates
      .map((c) => `  #${c.id} · ${c.name}${c.city ? ` · ${c.city}` : ""}${c.domain ? ` · ${c.domain}` : ""}`)
      .join("\n")
  );
}

export function parseCompanyPick(value: unknown, known: Set<number>): { companyId: number | null; reason: string } {
  const raw = (value as { companyId?: unknown; reason?: unknown } | null) ?? {};
  const id = Number(raw.companyId);
  return {
    companyId: known.has(id) ? id : null,
    reason: String(raw.reason ?? "").trim(),
  };
}

/** Legal forms that say nothing about which company is meant ("Holding" does). */
const LEGAL_FORMS = /\b(gmbh|mbh|ag|aktiengesellschaft|kg|kgaa|ohg|gbr|ug|se|e\.?\s?k|e\.?\s?v|co|company|inc|ltd|llc)\b/g;

/** A company name reduced to what identifies it, for comparing two spellings. */
export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9\s.]/g, " ")
    .replace(LEGAL_FORMS, " ")
    .replace(/[.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when both names mean the same company, spelling differences aside. */
export function sameCompany(a: string, b: string): boolean {
  const left = normalizeCompany(a);
  const right = normalizeCompany(b);
  return left.length > 0 && left === right;
}

/**
 * The text the customer check looks at: what stood in the ticket when it came
 * in — title, description and the first incoming mail with its sender address,
 * whose domain is often the clearest hint. Later comments stay out so an
 * internally mentioned third company cannot mislead the check.
 */
export function companyCheckSource(ticket: TicketRow, thread: ThreadEntry[], maxChars = 4_000): string {
  const description = thread.find((e) => e.kind === "Beschreibung");
  const mail = thread.filter((e) => e.kind === "Mail eingehend").sort((a, b) => a.at - b.at)[0];
  const parts = [
    `Zugewiesener Kunde laut TANSS: ${ticket.companyName || "—"}`,
    `Titel: ${ticket.title}`,
    `Beschreibung:\n${clip(description?.text ?? "", maxChars / 2)}`,
  ];
  if (mail) {
    const sender = mail.from ? `${mail.author} <${mail.from}>` : mail.author;
    parts.push(
      `Erste eingehende Mail von ${sender}${mail.title ? ` · Betreff „${mail.title}“` : ""}:\n` +
        clip(stripMailNoise(mail.text), maxChars / 2),
    );
  }
  return parts.join("\n\n");
}

// --- mail cleanup ------------------------------------------------------------

/**
 * Drops quoted history, signatures and disclaimers from a mail body before the
 * model sees it — deterministic, so the cut is the same every time.
 */
export function stripMailNoise(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^(>|von:|from:|-{3,}\s*(ursprüngliche|original)|am .* schrieb .*:$|on .* wrote:$|_{5,}|-- $)/i.test(t)) break;
    if (/^(mit freundlichen grüßen|viele grüße|beste grüße|freundliche grüße|best regards|kind regards|liebe grüße)/i.test(t)) break;
    out.push(line);
  }
  return out.join("\n").trim() || text.trim();
}

export function cleanMailPrompt(subject: string, body: string): string {
  return (
    "Reduziere diese Mail auf ihren eigentlichen Inhalt: Anliegen, Fragen, genannte Fakten (Hostnamen, Zeiten, Fehlermeldungen). " +
    "Keine Anrede, keine Grußformel, keine Zitate älterer Mails, keine Signatur, keine Disclaimer. Höchstens fünf kurze Zeilen, " +
    "nichts hinzufügen.\n\n" +
    `Betreff: ${subject}\n\n${clip(body, 6000)}`
  );
}

// --- chat --------------------------------------------------------------------

export type ChatTurn = { role: "user" | "assistant"; content: string };

/** Ticket numbers a message refers to, "#4711" or "Ticket 4711". */
export function mentionedTicketIds(text: string, known: Set<number>): number[] {
  const ids = new Set<number>();
  for (const m of text.matchAll(/(?:#|ticket\s*)(\d+)/gi)) ids.add(Number(m[1]));
  // A single digit is a list position more often than a ticket — unless the board knows it.
  return [...ids].filter((id) => known.has(id) || id >= 10);
}

export const CHAT_SYSTEM_PROMPT =
  SYSTEM_PROMPT +
  " Du antwortest in einem Chat und hast Werkzeuge, um in TANSS nachzusehen. " +
  "Die Ticketzeilen im Kontext sind nur eine Übersicht: Nummer, Kunde, Titel, Status — kein Verlauf und kein Inhalt. " +
  "Sobald es um den Inhalt eines Tickets geht, was passiert ist, was zu tun bleibt oder was ein Kunde lesen soll, " +
  "rufst du zuerst ticket_lesen für jedes betroffene Ticket auf. Ein Text, der aus dem Titel allein entsteht, ist geraten. " +
  "Brauchst du eine Ticketnummer oder einen Kunden, den der Kontext nicht nennt, such ihn mit tickets_suchen. " +
  "Rate nie eine Ticketnummer und erfinde nie einen Verlaufsinhalt; findest du nichts, sag das. " +
  "Antworte knapp, Ticketnummern mit #. Verlangt der Nutzer einen Text zum Weiterverwenden — eine Mail, " +
  "eine Zusammenfassung, eine Notiz — dann schreib ihn vollständig aus, ohne Vorrede und ohne Nachklapp. " +
  "Geht es um mehrere Tickets in einem Text, ordne nach Sache statt nach Ticket und nenne jede Ticketnummer " +
  "einmal, damit der Kunde zuordnen kann. " +
  "Du kannst nichts ausführen: keine Buchungen, keine Kommentare, keine Statusänderungen. Wenn der Nutzer so etwas " +
  "möchte, sag, wo er es im Portal tut (Entwurf im Ticket, „Agent fragen“ an einer Lücke in Zeiten, Freigaben).";

export function chatContext(input: {
  today: string;
  since: string;
  /** Unix seconds, so ages and idleness can be finer than a calendar day. */
  nowUnix: number;
  employeeName: string;
  rows: TicketRow[];
  activity: Record<number, Activity>;
  tickets: { row: TicketRow; context: string }[];
  daySupports: Support[];
  openTicketId: number | null;
}): string {
  const mine = input.rows.filter((r) => r.assigneeId && r.assigneeName === input.employeeName);
  const others = input.rows.filter((r) => !mine.includes(r));
  const lines = [...mine, ...others]
    .slice(0, 80)
    .map((r) => rowLine(r, input.activity[r.id], input.today, input.since, input.nowUnix));
  const booked = input.daySupports
    .sort((a, b) => a.date - b.date)
    .map((s) => {
      const from = berlinMinuteOfDay(s.date);
      return `  ${formatClock(from)}–${formatClock(from + s.duration)} ${s.ticketId ? `#${s.ticketId} ` : ""}${s.companyName}: ${clip(s.text.split("\n")[0], 100)}`;
    });
  const parts = [
    `Heute ist ${formatShortDate(input.today)}. Ich bin ${input.employeeName || "der Techniker"}.`,
    input.openTicketId ? `Gerade geöffnet: Ticket #${input.openTicketId}.` : "",
    `Offene Tickets (${input.rows.length}${input.rows.length > 80 ? ", die ersten 80" : ""}; meine zuerst):\n${lines.join("\n") || "  keine"}`,
    `Meine Buchungen heute:\n${booked.join("\n") || "  keine"}`,
    ...input.tickets.map((t) => `--- Verlauf ---\n${t.context}`),
  ];
  return parts.filter(Boolean).join("\n\n");
}

function dateLabel(unix: number): string {
  return `${formatShortDate(berlinYmd(unix))} ${formatClock(berlinMinuteOfDay(unix))}`;
}

function clockOf(unix: number, day: string): string {
  return berlinYmd(unix) === day ? formatClock(berlinMinuteOfDay(unix)) : formatShortDate(berlinYmd(unix));
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)} …` : t;
}
