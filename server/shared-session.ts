import type { StoredSession, Store } from "./store.ts";
import { TanssError, type TanssSession } from "./tanss.ts";

/** The refresh token dies after five days; renew well before that. */
export const REFRESH_WINDOW_DAYS = 5;
/** Renew the pair once it is this close to the apiToken's four hours. */
export const RENEW_BEFORE_SECONDS = 10 * 60;

export type SharedSessionState = {
  /** Is there a usable session at all? */
  present: boolean;
  employeeId: number;
  /** Unix seconds the apiToken expires at. */
  expire: number;
  /** Unix seconds the pair was last renewed. */
  updatedAt: number;
  /** Unix seconds after which the refresh token is dead beyond saving. */
  deadline: number;
};

/**
 * One TANSS session for the whole process. TANSS hands out a new pair every
 * time the refresh token is used and kills the old one, so two holders of the
 * same chain would log each other out — the browser's requests and the
 * dashboard collector therefore share this one, and every rotation is
 * serialised through `run`.
 */
export type SharedSession = {
  /**
   * Runs `work` with a live session and stores whatever rotation it caused.
   * Calls queue up, so two requests never rotate the same token in parallel.
   */
  run<T>(work: (session: TanssSession) => Promise<T>): Promise<T>;
  /** Seeds the session from a fresh login at the mask. */
  adopt(session: TanssSession, nowSeconds: number): void;
  clear(): void;
  /** What is stored right now — for the settings page and the dashboard. */
  state(nowSeconds?: number): SharedSessionState;
};

export function createSharedSession(opts: { store: Store; now?: () => number }): SharedSession {
  const now = opts.now ?? Date.now;
  const seconds = () => Math.floor(now() / 1000);
  // A promise chain is the whole mutex: every call waits for the previous.
  let queue: Promise<unknown> = Promise.resolve();

  function stored(): StoredSession | null {
    return opts.store.session();
  }

  function save(session: TanssSession, at: number) {
    opts.store.setSession({
      employeeId: session.employeeId,
      apiKey: session.apiKey,
      refresh: session.refresh,
      expire: session.expire,
      updatedAt: at,
    });
  }

  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const mine = queue.then(work, work);
    // The queue must not break on a rejection, or every later call inherits it.
    queue = mine.then(
      () => undefined,
      () => undefined,
    );
    return mine;
  }

  return {
    async run(work) {
      return exclusive(async () => {
        const current = stored();
        if (!current) {
          throw new TanssError("Nicht angemeldet", 401);
        }
        const at = seconds();
        if (current.updatedAt > 0 && at - current.updatedAt > REFRESH_WINDOW_DAYS * 86_400) {
          // Past five days the refresh token is gone; saying so beats a
          // confusing 403 from TANSS.
          opts.store.setSession(null);
          throw new TanssError(
            "Die gespeicherte TANSS-Sitzung ist älter als 5 Tage und damit abgelaufen — bitte einmal neu anmelden",
            401,
          );
        }
        const session: TanssSession = {
          employeeId: current.employeeId,
          apiKey: current.apiKey,
          refresh: current.refresh,
          expire: current.expire,
        };
        try {
          return await work(session);
        } finally {
          // The client mutates the session on a refresh; keep what it got.
          if (session.apiKey !== current.apiKey || session.refresh !== current.refresh) {
            save(session, seconds());
          }
        }
      });
    },
    adopt(session, nowSeconds) {
      save(session, nowSeconds);
    },
    clear() {
      opts.store.setSession(null);
    },
    state() {
      const current = stored();
      if (!current) {
        return { present: false, employeeId: 0, expire: 0, updatedAt: 0, deadline: 0 };
      }
      return {
        present: true,
        employeeId: current.employeeId,
        expire: current.expire,
        updatedAt: current.updatedAt,
        deadline: current.updatedAt > 0 ? current.updatedAt + REFRESH_WINDOW_DAYS * 86_400 : 0,
      };
    },
  };
}

/** True when the pair should be rolled over now rather than at the next 401. */
export function needsRenewal(state: SharedSessionState, nowSeconds: number): boolean {
  if (!state.present) return false;
  return state.expire > 0 && state.expire - nowSeconds < RENEW_BEFORE_SECONDS;
}
