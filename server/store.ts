import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { LlmSettings } from "./llm.ts";
import { DEFAULT_CONTEXT_TOKENS, type Proposal } from "../shared/agent.ts";
import { parseDashboardDays, type ClaimEntry, type DashboardDay } from "../shared/dashboard.ts";
import { LIST_IDS, parseSavedViews, type SavedView } from "../shared/filters.ts";
import { parseRoutines, type Routine } from "../shared/routines.ts";
import { DEFAULT_STYLE, parseStyle, type StyleSettings } from "../shared/style.ts";
import { parseMappings, type Mappings } from "../shared/mapping.ts";
import { DEFAULT_RULES, parseRules, type ImportRules } from "../shared/import.ts";

export type { Proposal };

/**
 * The one TANSS session the whole server shares: the browser's requests and
 * the dashboard collector. It has to be one, because TANSS rotates the
 * refresh token on every use — two holders of the same chain log each other
 * out. Seeded by a login at the mask, kept alive by whoever uses it.
 */
export type StoredSession = {
  employeeId: number;
  apiKey: string;
  refresh: string;
  /** Unix seconds the apiKey expires at. */
  expire: number;
  /** Unix seconds the pair was last written — the 5-day refresh window. */
  updatedAt: number;
};

export type Store = {
  session(): StoredSession | null;
  setSession(session: StoredSession | null): void;
  /**
   * Which login cookies still count, per employee: a cookie carries the
   * generation it was issued in, and logging out moves to the next one.
   */
  sessionGeneration(employeeId: number): number;
  bumpSessionGeneration(employeeId: number): number;
  llm(): LlmSettings;
  setLlm(settings: LlmSettings): void;
  proposals(employeeId: number): Proposal[];
  addProposal(proposal: Proposal): void;
  removeProposal(id: string): Proposal | null;
  /** Saved board lists, per employee — server-side so the poller can count them. */
  views(employeeId: number): SavedView[];
  setViews(employeeId: number, views: SavedView[]): void;
  /** How the day import turns Linear activity into durations. */
  importRules(employeeId: number): ImportRules;
  setImportRules(employeeId: number, rules: ImportRules): void;
  /** Where work from an outside source is booked: key -> TANSS target. */
  mappings(employeeId: number): Mappings;
  setMappings(employeeId: number, mappings: Mappings): void;
  /** Which outside items were already booked: "ESK-499|2026-08-25" -> supportId. */
  importBookings(employeeId: number): Record<string, number>;
  markImportBooked(employeeId: number, key: string, supportId: number): void;
  /** How booking texts should read, per employee. */
  style(employeeId: number): StyleSettings;
  setStyle(employeeId: number, style: StyleSettings): void;
  /** Recurring work the user keeps by hand, per employee. */
  routines(employeeId: number): Routine[];
  setRoutines(employeeId: number, routines: Routine[]): void;
  /** Which templates were already booked: "termin:900|2026-08-25" -> supportId. */
  templateBookings(employeeId: number): Record<string, number>;
  markTemplateBooked(employeeId: number, key: string, supportId: number): void;
  /** Which lists get a day report when the day rolls over. */
  reportLists(employeeId: number): string[];
  setReportLists(employeeId: number, keys: string[]): void;
  /** The archive: one HTML file per day and list. */
  saveReport(employeeId: number, name: string, html: string): void;
  hasReport(employeeId: number, name: string): boolean;
  reports(employeeId: number): { name: string; day: string; bytes: number }[];
  report(employeeId: number, name: string): string | null;
  /**
   * The running history of takeovers. Separate from the measurements, which
   * forget after two weeks — this is meant to be kept.
   */
  appendClaims(employeeId: number, entries: ClaimEntry[]): void;
  claimHistory(employeeId: number, sinceDay: string): ClaimEntry[];
  /** Dashboard measurements, per employee. */
  dashboard(employeeId: number): DashboardDay[];
  setDashboard(employeeId: number, days: DashboardDay[]): void;
};

const EMPTY_LLM: LlmSettings = { baseUrl: "", apiKey: "", model: "", contextTokens: DEFAULT_CONTEXT_TOKENS };

/** In-memory store for tests. */
export function createMemoryStore(): Store {
  let llm = { ...EMPTY_LLM };
  let proposals: Proposal[] = [];
  let session: StoredSession | null = null;
  const views = new Map<number, SavedView[]>();
  const templates = new Map<number, Record<string, number>>();
  const routines = new Map<number, Routine[]>();
  const styles = new Map<number, StyleSettings>();
  const mappings = new Map<number, Mappings>();
  const importRules = new Map<number, ImportRules>();
  const imported = new Map<number, Record<string, number>>();
  const dashboards = new Map<number, DashboardDay[]>();
  const claims = new Map<number, ClaimEntry[]>();
  const reportLists = new Map<number, string[]>();
  const reports = new Map<number, Map<string, string>>();
  const generations = new Map<number, number>();
  return {
    session: () => (session ? { ...session } : null),
    setSession: (s) => {
      session = s ? { ...s } : null;
    },
    sessionGeneration: (employeeId) => generations.get(employeeId) ?? 0,
    bumpSessionGeneration: (employeeId) => {
      const next = (generations.get(employeeId) ?? 0) + 1;
      generations.set(employeeId, next);
      return next;
    },
    llm: () => ({ ...llm }),
    setLlm: (s) => {
      llm = { ...s };
    },
    proposals: (employeeId) => proposals.filter((p) => p.employeeId === employeeId),
    addProposal: (p) => {
      proposals = [...proposals, p];
    },
    removeProposal: (id) => {
      const found = proposals.find((p) => p.id === id) ?? null;
      proposals = proposals.filter((p) => p.id !== id);
      return found;
    },
    views: (employeeId) => views.get(employeeId) ?? [],
    setViews: (employeeId, next) => {
      views.set(employeeId, next);
    },
    importRules: (employeeId) => importRules.get(employeeId) ?? { ...DEFAULT_RULES },
    setImportRules: (employeeId, next) => {
      importRules.set(employeeId, next);
    },
    mappings: (employeeId) => ({ ...(mappings.get(employeeId) ?? {}) }),
    setMappings: (employeeId, next) => {
      mappings.set(employeeId, next);
    },
    importBookings: (employeeId) => ({ ...(imported.get(employeeId) ?? {}) }),
    markImportBooked: (employeeId, key, supportId) => {
      imported.set(employeeId, { ...(imported.get(employeeId) ?? {}), [key]: supportId });
    },
    style: (employeeId) => styles.get(employeeId) ?? { ...DEFAULT_STYLE },
    setStyle: (employeeId, next) => {
      styles.set(employeeId, next);
    },
    routines: (employeeId) => routines.get(employeeId) ?? [],
    setRoutines: (employeeId, next) => {
      routines.set(employeeId, next);
    },
    templateBookings: (employeeId) => ({ ...(templates.get(employeeId) ?? {}) }),
    markTemplateBooked: (employeeId, key, supportId) => {
      templates.set(employeeId, { ...(templates.get(employeeId) ?? {}), [key]: supportId });
    },
    reportLists: (employeeId) => reportLists.get(employeeId) ?? [],
    setReportLists: (employeeId, keys) => {
      reportLists.set(employeeId, keys);
    },
    saveReport: (employeeId, name, html) => {
      const own = reports.get(employeeId) ?? new Map<string, string>();
      own.set(name, html);
      reports.set(employeeId, own);
    },
    hasReport: (employeeId, name) => (reports.get(employeeId) ?? new Map()).has(name),
    reports: (employeeId) =>
      [...(reports.get(employeeId) ?? new Map<string, string>()).entries()]
        .map(([name, html]) => ({ name, day: name.slice(0, 10), bytes: html.length }))
        .sort((a, b) => b.name.localeCompare(a.name)),
    report: (employeeId, name) => (reports.get(employeeId) ?? new Map()).get(name) ?? null,
    appendClaims: (employeeId, entries) => {
      claims.set(employeeId, [...(claims.get(employeeId) ?? []), ...entries]);
    },
    claimHistory: (employeeId, sinceDay) =>
      (claims.get(employeeId) ?? []).filter((e) => e.day >= sinceDay),
    dashboard: (employeeId) => dashboards.get(employeeId) ?? [],
    setDashboard: (employeeId, days) => {
      dashboards.set(employeeId, days);
    },
  };
}

/**
 * JSON files under `dir`: `llm.json` (holds the API key — mode 600) and
 * `proposals.json`. Written atomically; small enough to rewrite whole.
 */
export function createFileStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });
  const llmPath = path.join(dir, "llm.json");
  const proposalsPath = path.join(dir, "proposals.json");
  const viewsPath = path.join(dir, "views.json");
  const dashboardPath = path.join(dir, "dashboard.json");
  const sessionPath = path.join(dir, "session.json");
  const claimsPath = path.join(dir, "claims.jsonl");
  const reportsDir = path.join(dir, "reports");
  const reportListsPath = path.join(dir, "report-lists.json");
  const reportListsByEmployee = read<Record<string, unknown>>(reportListsPath, {});
  const reportLists = new Map<number, string[]>(
    Object.entries(reportListsByEmployee).map(([id, raw]) => [
      Number(id),
      (Array.isArray(raw) ? raw : []).filter((k): k is string => typeof k === "string").slice(0, 20),
    ]),
  );
  const generationsPath = path.join(dir, "session-generations.json");
  const generations = new Map<number, number>(
    Object.entries(read<Record<string, unknown>>(generationsPath, {}))
      .filter(([, raw]) => Number.isInteger(raw))
      .map(([id, raw]) => [Number(id), raw as number]),
  );
  const reportDir = (employeeId: number) => path.join(reportsDir, String(employeeId));
  // A report name is built by us, but it ends up in a path — never let a
  // crafted name walk out of the archive folder.
  const safeName = (name: string) => /^[A-Za-z0-9._-]+\.html$/.test(name);

  function read<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as T;
    } catch {
      return fallback;
    }
  }
  function write(file: string, value: unknown, mode: number) {
    writeRaw(file, JSON.stringify(value, null, 2), mode);
  }
  /** Atomic, but without JSON in the way — a report is already text. */
  function writeRaw(file: string, text: string, mode: number) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, file);
  }

  let llm: LlmSettings = { ...EMPTY_LLM, ...read<Partial<LlmSettings>>(llmPath, {}) };
  let proposals = read<Proposal[]>(proposalsPath, []);
  const viewsByEmployee = read<Record<string, unknown>>(viewsPath, {});
  const views = new Map<number, SavedView[]>(
    Object.entries(viewsByEmployee).map(([id, raw]) => [Number(id), parseSavedViews(raw, LIST_IDS)]),
  );
  const mappingsPath = path.join(dir, "mappings.json");
  const mappingsByEmployee = read<Record<string, unknown>>(mappingsPath, {});
  const mappings = new Map<number, Mappings>(
    Object.entries(mappingsByEmployee).map(([id, raw]) => [Number(id), parseMappings(raw)]),
  );
  const rulesPath = path.join(dir, "import-rules.json");
  const rulesByEmployee = read<Record<string, unknown>>(rulesPath, {});
  const importRules = new Map<number, ImportRules>(
    Object.entries(rulesByEmployee).map(([id, raw]) => [Number(id), parseRules(raw)]),
  );
  const importedPath = path.join(dir, "imported.json");
  const importedByEmployee = read<Record<string, Record<string, number>>>(importedPath, {});
  const imported = new Map<number, Record<string, number>>(
    Object.entries(importedByEmployee).map(([id, raw]) => [Number(id), raw ?? {}]),
  );
  const stylePath = path.join(dir, "style.json");
  const stylesByEmployee = read<Record<string, unknown>>(stylePath, {});
  const styles = new Map<number, StyleSettings>(
    Object.entries(stylesByEmployee).map(([id, raw]) => [Number(id), parseStyle(raw)]),
  );
  const routinesPath = path.join(dir, "routines.json");
  const routinesByEmployee = read<Record<string, unknown>>(routinesPath, {});
  const routines = new Map<number, Routine[]>(
    Object.entries(routinesByEmployee).map(([id, raw]) => [Number(id), parseRoutines(raw)]),
  );
  const templatesPath = path.join(dir, "templates.json");
  const templatesByEmployee = read<Record<string, Record<string, number>>>(templatesPath, {});
  const templates = new Map<number, Record<string, number>>(
    Object.entries(templatesByEmployee).map(([id, raw]) => [Number(id), raw ?? {}]),
  );
  const dashboardsByEmployee = read<Record<string, unknown>>(dashboardPath, {});
  const dashboards = new Map<number, DashboardDay[]>(
    Object.entries(dashboardsByEmployee).map(([id, raw]) => [Number(id), parseDashboardDays(raw)]),
  );
  const asRecord = <T>(map: Map<number, T>) => Object.fromEntries([...map.entries()].map(([k, v]) => [String(k), v]));
  let session = readSession();

  function readSession(): StoredSession | null {
    const raw = read<Partial<StoredSession> | null>(sessionPath, null);
    if (!raw || !raw.apiKey || !raw.refresh || !raw.employeeId) return null;
    return {
      employeeId: Number(raw.employeeId),
      apiKey: String(raw.apiKey),
      refresh: String(raw.refresh),
      expire: Number(raw.expire ?? 0),
      updatedAt: Number(raw.updatedAt ?? 0),
    };
  }

  return {
    session: () => (session ? { ...session } : null),
    setSession: (s) => {
      session = s ? { ...s } : null;
      // Tokens are as good as the password for the next four hours.
      write(sessionPath, session, 0o600);
    },
    llm: () => ({ ...llm }),
    setLlm: (s) => {
      llm = { ...s };
      write(llmPath, llm, 0o600);
    },
    proposals: (employeeId) => proposals.filter((p) => p.employeeId === employeeId),
    addProposal: (p) => {
      proposals = [...proposals, p];
      write(proposalsPath, proposals, 0o600);
    },
    removeProposal: (id) => {
      const found = proposals.find((p) => p.id === id) ?? null;
      if (found) {
        proposals = proposals.filter((p) => p.id !== id);
        write(proposalsPath, proposals, 0o600);
      }
      return found;
    },
    views: (employeeId) => views.get(employeeId) ?? [],
    setViews: (employeeId, next) => {
      views.set(employeeId, next);
      write(viewsPath, asRecord(views), 0o600);
    },
    importRules: (employeeId) => importRules.get(employeeId) ?? { ...DEFAULT_RULES },
    setImportRules: (employeeId, next) => {
      importRules.set(employeeId, next);
      write(rulesPath, asRecord(importRules), 0o600);
    },
    mappings: (employeeId) => ({ ...(mappings.get(employeeId) ?? {}) }),
    setMappings: (employeeId, next) => {
      mappings.set(employeeId, next);
      write(mappingsPath, asRecord(mappings), 0o600);
    },
    importBookings: (employeeId) => ({ ...(imported.get(employeeId) ?? {}) }),
    markImportBooked: (employeeId, key, supportId) => {
      imported.set(employeeId, { ...(imported.get(employeeId) ?? {}), [key]: supportId });
      write(importedPath, asRecord(imported), 0o600);
    },
    style: (employeeId) => styles.get(employeeId) ?? { ...DEFAULT_STYLE },
    setStyle: (employeeId, next) => {
      styles.set(employeeId, next);
      write(stylePath, asRecord(styles), 0o600);
    },
    routines: (employeeId) => routines.get(employeeId) ?? [],
    setRoutines: (employeeId, next) => {
      routines.set(employeeId, next);
      write(routinesPath, asRecord(routines), 0o600);
    },
    templateBookings: (employeeId) => ({ ...(templates.get(employeeId) ?? {}) }),
    markTemplateBooked: (employeeId, key, supportId) => {
      templates.set(employeeId, { ...(templates.get(employeeId) ?? {}), [key]: supportId });
      write(templatesPath, asRecord(templates), 0o600);
    },
    reportLists: (employeeId) => reportLists.get(employeeId) ?? [],
    setReportLists: (employeeId, keys) => {
      reportLists.set(employeeId, keys);
      write(reportListsPath, asRecord(reportLists), 0o600);
    },
    sessionGeneration: (employeeId) => generations.get(employeeId) ?? 0,
    bumpSessionGeneration: (employeeId) => {
      const next = (generations.get(employeeId) ?? 0) + 1;
      generations.set(employeeId, next);
      write(generationsPath, asRecord(generations), 0o600);
      return next;
    },
    saveReport: (employeeId, name, html) => {
      if (!safeName(name)) return;
      mkdirSync(reportDir(employeeId), { recursive: true });
      writeRaw(path.join(reportDir(employeeId), name), html, 0o600);
    },
    hasReport: (employeeId, name) => safeName(name) && existsSync(path.join(reportDir(employeeId), name)),
    reports: (employeeId) => {
      try {
        return readdirSync(reportDir(employeeId))
          .filter((name) => safeName(name))
          .map((name) => ({
            name,
            day: name.slice(0, 10),
            bytes: statSync(path.join(reportDir(employeeId), name)).size,
          }))
          .sort((a, b) => b.name.localeCompare(a.name));
      } catch {
        return [];
      }
    },
    report: (employeeId, name) => {
      if (!safeName(name)) return null;
      try {
        return readFileSync(path.join(reportDir(employeeId), name), "utf8");
      } catch {
        return null;
      }
    },
    // One line per takeover, appended. A log is the one thing that must not
    // be rewritten whole — losing the file to a crash mid-write would lose
    // the history it exists to keep.
    appendClaims: (employeeId, entries) => {
      if (entries.length === 0) return;
      const lines = entries.map((e) => JSON.stringify({ employeeId, ...e })).join("\n");
      appendFileSync(claimsPath, `${lines}\n`, { mode: 0o600 });
    },
    claimHistory: (employeeId, sinceDay) => {
      let raw = "";
      try {
        raw = readFileSync(claimsPath, "utf8");
      } catch {
        return [];
      }
      const entries: ClaimEntry[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as ClaimEntry & { employeeId?: number };
          if (parsed.employeeId !== employeeId || !parsed.day || parsed.day < sinceDay) continue;
          entries.push({
            day: String(parsed.day),
            id: Number(parsed.id) || 0,
            title: String(parsed.title ?? ""),
            minute: Number(parsed.minute) || 0,
            assigneeId: Number(parsed.assigneeId) || 0,
            assigneeName: String(parsed.assigneeName ?? ""),
            fromId: Number(parsed.fromId) || 0,
            fromName: String(parsed.fromName ?? ""),
            lists: Array.isArray(parsed.lists) ? parsed.lists.filter((l): l is string => typeof l === "string") : [],
          });
        } catch {
          // A broken line is skipped, never fatal: the rest of the history
          // is worth more than a clean parse.
        }
      }
      return entries;
    },
    dashboard: (employeeId) => dashboards.get(employeeId) ?? [],
    setDashboard: (employeeId, days) => {
      dashboards.set(employeeId, days);
      write(dashboardPath, asRecord(dashboards), 0o600);
    },
  };
}
