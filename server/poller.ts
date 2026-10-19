import {
  SAMPLE_INTERVAL_MINUTES,
  claimsFromDays,
  createdOnDay,
  dayCurve,
  intakeByHour,
  listMembers,
  listsOfDay,
  mergeClaimEntries,
  recordSample,
  type CollectorHealth,
  type ListKey,
} from "../shared/dashboard.ts";
import { renderDayReport, reportName } from "../shared/report.ts";
import type { TicketRow } from "../shared/tickets.ts";
import { berlinYmd } from "../shared/days.ts";
import { loadBoard } from "./board.ts";
import { LoginBlockedError, type LoginGate } from "./login.ts";
import type { SharedSession } from "./shared-session.ts";
import type { Store } from "./store.ts";
import { TanssError, type TanssClient, type TanssSession } from "./tanss.ts";

export type Poller = {
  start(): void;
  stop(): void;
  /** One measurement, awaited — exported for tests and the first run. */
  tick(): Promise<void>;
  health(): CollectorHealth;
};

/**
 * Counts the board lists every few minutes and stores the numbers as
 * dashboard samples. Reads only; never writes to TANSS. A failed measurement
 * leaves a gap in the curve — exactly what happened — and the login gate makes
 * sure a broken login is not retried in a loop.
 */
export function createPoller(opts: {
  tanss: TanssClient;
  store: Store;
  /** The session seeded by a login at the mask — the normal way in. */
  shared?: SharedSession;
  /** Optional fallback from stored credentials; off by default. */
  gate?: LoginGate;
  intervalMs?: number;
  now?: () => number;
  onError?: (message: string) => void;
  /** Called with the file name whenever a day report was archived. */
  onReport?: (name: string) => void;
}): Poller {
  const intervalMs = opts.intervalMs ?? SAMPLE_INTERVAL_MINUTES * 60_000;
  const now = opts.now ?? Date.now;
  let session: TanssSession | null = null;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let lastSampleAt = 0;
  let lastError = "";
  let failures = 0;

  /** One measurement with whatever session it is given. */
  async function sample(active: TanssSession): Promise<void> {
    const board = await loadBoard(opts.tanss, active);
    const views = opts.store.views(active.employeeId);
    const members = listMembers(board.rows, views, {
      id: active.employeeId,
      name: board.employeeName,
    });
    const seconds = Math.floor(now() / 1000);
    const stored = opts.store.dashboard(active.employeeId);
    const day = berlinYmd(seconds);
    const before = stored.find((d) => d.day === day)?.claims.length ?? 0;
    const days = recordSample(stored, seconds, members, board.rows);
    opts.store.setDashboard(active.employeeId, days);

    // Whatever this measurement newly found goes into the running history —
    // the measurement file forgets after two weeks, the log does not. The
    // lists come from the day's membership set, not from where the ticket
    // lies now: a takeover moves it out of the list it was taken from.
    const today = days.find((d) => d.day === day);
    const fresh = (today?.claims ?? []).slice(before);
    if (fresh.length) {
      opts.store.appendClaims(
        active.employeeId,
        fresh.map((claim) => ({ ...claim, day, lists: listsOfDay(today, claim.id) })),
      );
    }
    lastSampleAt = seconds;
    writeDueReports(active.employeeId, day, members);
  }

  /**
   * Once a day has ended, its report is written — at the first measurement of
   * the following day, because that is when the day is provably complete.
   * Only lists the user asked for, and never twice.
   */
  function writeDueReports(
    employeeId: number,
    today: string,
    members: { key: ListKey; label: string; rows: TicketRow[] }[],
  ): void {
    const wanted = opts.store.reportLists(employeeId);
    if (wanted.length === 0) return;
    const days = opts.store.dashboard(employeeId);
    const history = opts.store.claimHistory(employeeId, "2000-01-01");
    for (const entry of days) {
      if (entry.day >= today) continue;
      for (const key of wanted) {
        const name = reportName(entry.day, key);
        if (opts.store.hasReport(employeeId, name)) continue;
        const claims = mergeClaimEntries(
          history.filter((c) => c.day === entry.day),
          claimsFromDays([entry], entry.day),
        ).filter((c) => c.lists.includes(key));
        opts.store.saveReport(
          employeeId,
          name,
          renderDayReport({
            day: entry.day,
            listLabel: members.find((m) => m.key === key)?.label ?? key,
            curve: dayCurve(entry, key),
            intake: intakeByHour(createdOnDay(entry, key, [], entry.day).values()),
            claims,
            createdAt: Math.floor(now() / 1000),
            intervalMinutes: SAMPLE_INTERVAL_MINUTES,
          }),
        );
        opts.onReport?.(name);
      }
    }
  }

  async function measure(): Promise<void> {
    // The shared session is the normal way: it was seeded by a login at the
    // mask, so nothing here needs a password.
    if (opts.shared) {
      await opts.shared.run(sample);
      return;
    }
    if (!opts.gate) throw new TanssError("Keine Sitzung für den Sammler", 401);
    session ??= await opts.gate.login();
    await sample(session);
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      try {
        await measure();
      } catch (error) {
        // A dead token pair gets one fresh session within the same tick. A
        // refusal by the gate itself is not that — asking it twice would only
        // repeat the same "no". Without stored credentials there is nothing
        // to retry with: the session has to be renewed at the login mask.
        if (error instanceof LoginBlockedError || !opts.gate) throw error;
        if (!(error instanceof TanssError) || error.status !== 401) throw error;
        const fresh = await opts.gate.login();
        // The fresh pair belongs in the shared session, not in a local
        // variable: `measure` reads from there, and the browser profits too.
        if (opts.shared) opts.shared.adopt(fresh, Math.floor(now() / 1000));
        else session = fresh;
        await measure();
      }
      lastError = "";
      failures = 0;
    } catch (error) {
      session = null;
      const message = error instanceof Error ? error.message : "Messung fehlgeschlagen";
      failures++;
      // Say it once, not every five minutes: the dashboard shows the state.
      if (message !== lastError) opts.onError?.(message);
      lastError = message;
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      // Node keeps the process alive for active timers; the poller is a
      // sidecar, not a reason to run.
      timer.unref?.();
      void tick();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    health() {
      const login = opts.gate?.health() ?? {
        lastSuccessAt: 0,
        failures: 0,
        lastError: "",
        retryAfter: 0,
        stopped: false,
      };
      return {
        lastSampleAt,
        lastError,
        failures,
        loginFailures: login.failures,
        lastLoginAt: login.lastSuccessAt,
        retryAfter: login.retryAfter,
        stopped: login.stopped,
      };
    },
  };
}
