/**
 * A day in Linear, turned into booking suggestions. Everything here is
 * deterministic: no model is involved in deciding how long something took.
 * Where a rule shortens a duration it leaves a flag, so the reviewer sees
 * what was cut instead of trusting a number that quietly shrank.
 */

export type StateWindow = {
  /** Minute of the import day the state was entered; clipped at 0. */
  start: number;
  /** Minute it was left; may exceed 1440 when it ran past midnight. */
  end: number;
  state: string;
};

export type IssueActivity = {
  issue: string;
  title: string;
  project: string;
  url: string;
  windows: StateWindow[];
  /** Minutes the person noted in their own comments, 0 when none. */
  commentMinutes: number;
  /** The day's own notes — this becomes the booking text. */
  summary: string;
  /** True when the issue had more state changes than were read. */
  historyTruncated: boolean;
  /** Stretches of work with a known start, derived from the notes. */
  sessions: { start: number; minutes: number }[];
};

export type TimeSource = "comment" | "history";

/** A workflow state as Linear names it; `type` groups them (started, …). */
export type WorkflowState = { name: string; type: string };

export type ImportRules = {
  /** Which source decides the duration. */
  timeSource: TimeSource;
  /** Workflow state names that count as working time. */
  states: string[];
  /** Longest single sitting that will be believed, in hours. */
  sessionHours: number;
  /** Working window as "HH:MM-HH:MM"; time outside it is dropped. */
  window: string;
  /** Cap for the whole day, in hours. */
  dayMaxHours: number;
  /** Grid the final duration is rounded to, in minutes. */
  roundMinutes: number;
};

export const DEFAULT_RULES: ImportRules = {
  timeSource: "comment",
  states: [],
  sessionHours: 4,
  window: "06:00-20:00",
  dayMaxHours: 10,
  roundMinutes: 15,
};

export const ROUND_CHOICES = [5, 10, 15, 30] as const;
export const DAY_MINUTES = 24 * 60;

/** A note about something the rules changed — never a silent correction. */
export type Flag = { label: string; reason: string };

export type Suggestion = {
  issue: string;
  title: string;
  project: string;
  url: string;
  windows: StateWindow[];
  /** Minutes before rounding. */
  raw: number;
  /** Minutes after rounding — what would be booked. */
  minutes: number;
  start: number;
  text: string;
  flags: Flag[];
};

function hm(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function clock(minute: number): string {
  const safe = ((Math.round(minute) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

/** "06:00-20:00" as minutes; an unreadable value falls back to the default. */
export function parseWindow(raw: string): { from: number; to: number } {
  const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return { from: 6 * 60, to: 20 * 60 };
  const from = Number(match[1]) * 60 + Number(match[2]);
  const to = Number(match[3]) * 60 + Number(match[4]);
  if (from >= to || to > DAY_MINUTES) return { from: 6 * 60, to: 20 * 60 };
  return { from, to };
}

/** "2 h 9 min", "ca. 11 h 40 min", "1:30 h", "23 min" — all in minutes. */
export function parseDurationExpression(raw: string): number {
  const text = raw.toLowerCase().replace(/\b(ca\.|rund|etwa|knapp|gut)\b/g, " ");

  const clockForm = /(\d{1,2}):(\d{2})\s*(?:h|std)/.exec(text);
  if (clockForm) return Number(clockForm[1]) * 60 + Number(clockForm[2]);

  let minutes = 0;
  let found = false;
  const hours = /(\d+(?:[.,]\d+)?)\s*(?:h\b|std\b|stunden?\b)/.exec(text);
  if (hours) {
    minutes += Math.round(Number(hours[1]!.replace(",", ".")) * 60);
    found = true;
  }
  // Read after the hours, not instead of them: "2 h 9 min" is 129.
  const mins = /(\d+)\s*(?:min\b|minuten?\b)/.exec(text);
  if (mins) {
    minutes += Number(mins[1]);
    found = true;
  }
  return found ? minutes : 0;
}

/** One stretch of work as a note records it. */
export type WorkSession = { minutes: number; endMinute: number | null };

/** The last clock time before the marker — "14:04 … (Dauer: 20 min)". */
export function endBefore(text: string): number | null {
  let last: number | null = null;
  for (const match of text.matchAll(/(\d{1,2}):(\d{2})/g)) {
    const minute = Number(match[1]) * 60 + Number(match[2]);
    if (Number(match[1]) <= 23 && Number(match[2]) <= 59) last = minute;
  }
  return last;
}

/**
 * Every "Dauer: …" in a note. The expression ends at a bracket, comma or
 * semicolon, so "(Dauer: 1 h 9 min, davon 40 min Recherche)" is 69, not 109.
 */
export function parseWorkSessions(body: string): WorkSession[] {
  const sessions: WorkSession[] = [];
  for (const match of body.matchAll(/dauer:\s*([^),;]+)/gi)) {
    const minutes = parseDurationExpression(match[1]!);
    if (minutes <= 0) continue;
    sessions.push({ minutes, endMinute: endBefore(body.slice(0, match.index ?? 0)) });
  }
  return sessions;
}

export function commentMinutes(comments: { body: string }[]): number {
  return comments.reduce(
    (total, c) => total + parseWorkSessions(c.body).reduce((sum, s) => sum + s.minutes, 0),
    0,
  );
}

/**
 * Where each noted stretch began. The end is the clock time written next to
 * the marker; without one the comment's own timestamp stands in.
 */
export function collectSessions(
  comments: { createdAt: string; body: string }[],
  dayFrom: number,
): { start: number; minutes: number }[] {
  const sessions: { start: number; minutes: number }[] = [];
  for (const comment of comments) {
    const writtenAt = Math.floor(Date.parse(comment.createdAt) / 1000);
    const fallback = Number.isFinite(writtenAt) ? Math.round((writtenAt - dayFrom) / 60) : null;
    for (const session of parseWorkSessions(comment.body)) {
      const end = session.endMinute ?? fallback;
      if (end === null) continue;
      sessions.push({ start: Math.max(0, end - session.minutes), minutes: session.minutes });
    }
  }
  return sessions.sort((a, b) => a.start - b.start);
}

/**
 * The state history replayed as minute ranges of the import day. A window
 * still open at midnight ends at 1441 rather than at 1440, so the rules can
 * flag it instead of quietly closing it.
 */
export function buildWindows(
  transitions: { createdAt: string; fromState?: { name?: string } | null; toState?: { name?: string } | null }[],
  dayFrom: number,
): StateWindow[] {
  const points = transitions
    .map((t) => ({
      at: Math.round((Math.floor(Date.parse(t.createdAt) / 1000) - dayFrom) / 60),
      from: t.fromState?.name ?? "",
      to: t.toState?.name ?? "",
    }))
    .filter((p) => Number.isFinite(p.at) && (p.from || p.to))
    .sort((a, b) => a.at - b.at);
  if (points.length === 0) return [];

  const before = points.filter((p) => p.at <= 0);
  const during = points.filter((p) => p.at > 0 && p.at < DAY_MINUTES);
  const windows: StateWindow[] = [];
  let state = before.length ? before[before.length - 1]!.to : during[0]?.from ?? "";
  let start = 0;
  for (const point of during) {
    if (state) windows.push({ start, end: point.at, state });
    state = point.to;
    start = point.at;
  }
  if (state) {
    const after = points.find((p) => p.at >= DAY_MINUTES);
    windows.push({ start, end: after ? after.at : DAY_MINUTES + 1, state });
  }
  return windows.filter((w) => w.end > w.start);
}

/**
 * Suggestions for the whole day. Rules are applied in a fixed order and each
 * one that changed something says so.
 */
export function buildSuggestions(activities: IssueActivity[], rules: ImportRules): Suggestion[] {
  const bounds = parseWindow(rules.window);
  const grid = rules.roundMinutes > 0 ? rules.roundMinutes : 15;
  const sessionCap = Math.round(rules.sessionHours * 60);

  const suggestions: Suggestion[] = [];
  for (const activity of activities) {
    const flags: Flag[] = [];
    let total = 0;
    let firstStart: number | null = null;

    for (const window of activity.windows) {
      if (rules.states.length && !rules.states.includes(window.state)) continue;
      let start = Math.max(0, window.start);
      let end = window.end;
      if (end > DAY_MINUTES) {
        flags.push({
          label: "über Nacht offen",
          reason: "Das Fenster lief über Mitternacht hinaus und wurde am Tagesende bei 24:00 geschnitten.",
        });
        end = DAY_MINUTES;
      }
      const full = end - start;
      start = Math.max(start, bounds.from);
      end = Math.min(end, bounds.to);
      if (end <= start) continue;
      const cut = full - (end - start);
      if (cut > 0) {
        flags.push({
          label: "außerhalb Arbeitsfenster",
          reason: `${hm(cut)} Std. lagen außerhalb ${rules.window} und wurden abgezogen.`,
        });
      }
      let length = end - start;
      if (length > sessionCap) {
        flags.push({
          label: "gekappt",
          reason: `Das Fenster war ${hm(length)} Std. lang und wurde auf ${hm(sessionCap)} Std. gekappt (max. Sitzung).`,
        });
        length = sessionCap;
      }
      total += length;
      if (firstStart === null) firstStart = start;
    }

    if (activity.historyTruncated) {
      flags.push({
        label: "Verlauf unvollständig",
        reason:
          "Dieses Issue hat mehr Statuswechsel, als gelesen wurden. Die aus dem Verlauf berechnete Dauer kann zu niedrig sein.",
      });
    }

    const fromHistory = total;
    const noted = activity.commentMinutes;

    if (rules.timeSource === "comment" && noted > 0) {
      // The history value is discarded, and with it the flags that only
      // described how it came about. What replaces them says where the
      // number now comes from.
      flags.length = 0;
      total = noted;
      flags.push({
        label: "aus Kommentar",
        reason: `Die Dauer stammt aus der Zeitangabe im Kommentar (${noted} min). Der Statusverlauf allein ergäbe ${fromHistory} min.`,
      });
      if (activity.sessions.length) {
        firstStart = activity.sessions[0]!.start;
        if (activity.sessions.length > 1) {
          flags.push({
            label: `${activity.sessions.length} Sitzungen`,
            reason: `Am Tag ${activity.sessions.length}× an diesem Issue gearbeitet (${activity.sessions
              .map((s) => `${clock(s.start)}–${clock(s.start + s.minutes)}`)
              .join(", ")}). Zu einer Buchung zusammengefasst, weil TANSS ein Issue pro Tag nur einmal aufnimmt.`,
          });
        }
      }
    } else if (rules.timeSource === "comment") {
      flags.push({
        label: "ohne Zeitangabe",
        reason:
          "Für dieses Issue gibt es am Tag keine Zeitangabe im Kommentar. Die Dauer stammt aus dem Statusverlauf und ist entsprechend grob.",
      });
    } else if (noted > 0 && Math.abs(noted - fromHistory) > 15) {
      flags.push({
        label: "prüfen",
        reason: `Statusverlauf (${fromHistory} min) und Zeitangabe im Kommentar (${noted} min) weichen um ${Math.abs(noted - fromHistory)} Minuten ab.`,
      });
    }

    const minutes = Math.round(total / grid) * grid;
    if (minutes <= 0) continue;
    suggestions.push({
      issue: activity.issue,
      title: activity.title,
      project: activity.project,
      url: activity.url,
      windows: activity.windows,
      raw: total,
      minutes,
      start: firstStart ?? 8 * 60,
      text: activity.summary || activity.title,
      flags,
    });
  }

  // The day cap is a flag on everything, never a cut: which suggestion is the
  // wrong one is a question only the person can answer.
  const dayTotal = suggestions.reduce((sum, s) => sum + s.minutes, 0);
  const cap = Math.round(rules.dayMaxHours * 60);
  if (dayTotal > cap) {
    for (const suggestion of suggestions) {
      suggestion.flags.push({
        label: "Tagessumme",
        reason: `Alle Vorschläge ergeben ${hm(dayTotal)} Std. und übersteigen das Tagesmaximum von ${hm(cap)} Std.`,
      });
    }
  }
  return suggestions;
}

/** Tolerant reader for stored or posted rules. */
export function parseRules(raw: unknown): ImportRules {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const round = Number(obj.roundMinutes);
  const clampHours = (value: unknown, min: number, max: number, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  };
  return {
    timeSource: obj.timeSource === "history" ? "history" : "comment",
    states: (Array.isArray(obj.states) ? obj.states : [])
      .filter((s): s is string => typeof s === "string" && s.trim() !== "")
      .map((s) => s.trim().slice(0, 100))
      .slice(0, 50),
    sessionHours: clampHours(obj.sessionHours, 0.25, 24, DEFAULT_RULES.sessionHours),
    window: /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(String(obj.window ?? "")) ? String(obj.window) : DEFAULT_RULES.window,
    dayMaxHours: clampHours(obj.dayMaxHours, 1, 24, DEFAULT_RULES.dayMaxHours),
    roundMinutes: (ROUND_CHOICES as readonly number[]).includes(round) ? round : DEFAULT_RULES.roundMinutes,
  };
}

/** "ESK-499|2026-08-25" — one issue is booked once per day. */
export function importKey(issue: string, ymd: string): string {
  return `${issue}|${ymd}`;
}
