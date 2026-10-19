import { TanssError, type TanssClient, type TanssSession } from "./tanss.ts";
import { generateTotp, type TotpConfig } from "./totp.ts";

export type Credentials = { username: string; password: string };

export type LoginHealth = {
  /** Unix seconds of the last successful login; 0 when there was none. */
  lastSuccessAt: number;
  /** Consecutive failures since the last success. */
  failures: number;
  /** What the last attempt said, empty after a success. */
  lastError: string;
  /** Unix seconds before which nothing is tried; 0 when free to try. */
  retryAfter: number;
  /** The gate gave up: only an operator restarts it. */
  stopped: boolean;
};

/**
 * How long to wait after the 1st, 2nd and 3rd failed login. After that the
 * gate stops for good. Four attempts spread over an hour is the most the
 * automatic login may ever cost a TANSS account.
 */
const BACKOFF_MINUTES = [5, 15, 45];

/**
 * Did TANSS reject the credentials themselves? Then a retry is not just
 * pointless, it is dangerous: repeating a rejected password is what locks an
 * account. TANSS answers this with 401/403 — and, in at least one
 * installation, with 404 plus a LOGIN_ERROR text, so the message counts too.
 */
export function isCredentialRejection(error: unknown): boolean {
  if (!(error instanceof TanssError)) return false;
  if (error.status === 401 || error.status === 403) return true;
  return /LOGIN_ERROR|passwort|benutzername|2fa|token/i.test(error.message);
}

/**
 * The gate refusing without asking TANSS — as opposed to TANSS refusing. A
 * caller must not treat this as "the session died, try a fresh login".
 */
export class LoginBlockedError extends TanssError {
  constructor(message: string) {
    super(message, 401);
    this.name = "LoginBlockedError";
  }
}

export type LoginGate = {
  /** A session from the stored credentials, or a refusal without a request. */
  login(): Promise<TanssSession>;
  health(): LoginHealth;
};

/**
 * The single door through which the *automatic* login goes: the dashboard
 * collector and the self-healing session. Single-flight, so parallel callers
 * share one attempt, and gated, so a failing login is never repeated in a
 * loop. What the user types into the login mask never comes through here —
 * a person trying their own password is always allowed.
 */
export function createLoginGate(opts: {
  tanss: TanssClient;
  credentials: Credentials;
  totp: TotpConfig | null;
  now?: () => number;
  onStop?: (reason: string) => void;
  /** Called after a successful automatic login — otherwise it is invisible. */
  onSuccess?: (info: { employeeId: number; durationMs: number; afterFailures: number }) => void;
}): LoginGate {
  const now = opts.now ?? Date.now;
  let inflight: Promise<TanssSession> | null = null;
  let health: LoginHealth = {
    lastSuccessAt: 0,
    failures: 0,
    lastError: "",
    retryAfter: 0,
    stopped: false,
  };
  let stopReason = "";

  async function attempt(): Promise<TanssSession> {
    const startedAt = now();
    const failedBefore = health.failures;
    try {
      const session = await opts.tanss.login({
        username: opts.credentials.username,
        password: opts.credentials.password,
        token: opts.totp ? generateTotp(opts.totp, now()) : "",
      });
      health = {
        lastSuccessAt: Math.floor(now() / 1000),
        failures: 0,
        lastError: "",
        retryAfter: 0,
        stopped: false,
      };
      stopReason = "";
      opts.onSuccess?.({
        employeeId: session.employeeId,
        durationMs: now() - startedAt,
        afterFailures: failedBefore,
      });
      return session;
    } catch (error) {
      // The pause counts from the moment the attempt failed, not from when it
      // started — a login that hangs for 30 s must not eat 30 s of the pause.
      const seconds = Math.floor(now() / 1000);
      const message = error instanceof Error ? error.message : "Anmeldung fehlgeschlagen";
      const failures = health.failures + 1;
      const rejected = isCredentialRejection(error);
      const wait = BACKOFF_MINUTES[failures - 1];
      const stopped = rejected || wait === undefined;
      if (stopped) {
        stopReason = rejected
          ? `TANSS lehnt die hinterlegten Zugangsdaten ab (${message}). Automatische Anmeldung aus, damit kein Konto gesperrt wird.`
          : `${failures} Anmeldeversuche hintereinander fehlgeschlagen (${message}). Automatische Anmeldung aus.`;
        opts.onStop?.(stopReason);
      }
      health = {
        lastSuccessAt: health.lastSuccessAt,
        failures,
        lastError: message,
        retryAfter: stopped ? 0 : seconds + wait * 60,
        stopped,
      };
      throw error;
    }
  }

  return {
    login() {
      const seconds = Math.floor(now() / 1000);
      if (health.stopped) {
        return Promise.reject(
          new LoginBlockedError(
            `${stopReason} Zum Reaktivieren die Zugangsdaten prüfen und den Container neu starten.`,
          ),
        );
      }
      if (health.retryAfter > seconds) {
        const minutes = Math.ceil((health.retryAfter - seconds) / 60);
        return Promise.reject(
          new LoginBlockedError(
            `Automatische Anmeldung pausiert nach ${health.failures} Fehlversuch${health.failures === 1 ? "" : "en"} (${health.lastError}). Nächster Versuch in ${minutes} min.`,
          ),
        );
      }
      inflight ??= attempt().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    health: () => ({ ...health }),
  };
}
