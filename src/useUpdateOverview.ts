import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api.ts";
import { isBusy, type UpdateOverview } from "../shared/update.ts";
import { claimReload, sessionStore } from "./reload.ts";

const IDLE_POLL_MS = 30 * 60_000;
const BUSY_POLL_MS = 3_000;

/**
 * The update overview the banner and the navigation share. It polls itself —
 * slowly while idle, quickly while an update runs — and reloads the page once
 * the server reports another version than this bundle (at most once per
 * version and tab). Null until the first answer, while logged out, and for
 * good without an update service (404).
 */
export function useUpdateOverview(active: boolean, onError: (error: unknown) => void) {
  const [overview, setOverview] = useState<UpdateOverview | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const busy = overview !== null && isBusy(overview, now);

  /** Takes an overview another call returned (start, check) and resets the clock. */
  const replace = useCallback((next: UpdateOverview) => {
    setOverview(next);
    setNow(Date.now());
  }, []);

  // Poll right away and again on an interval: slow while idle, fast while an
  // update runs. The effect restarts whenever `busy` flips.
  useEffect(() => {
    if (!active) {
      setOverview(null);
      return;
    }
    let cancelled = false;

    async function poll() {
      try {
        const next = await api.update();
        if (cancelled) return;
        if (next.current !== __APP_VERSION__ && claimReload(next.current, sessionStore())) {
          // The new version is live; this bundle is stale. Once per version
          // and tab: if the reload brings the same bundle back, it stays.
          location.reload();
          return;
        }
        replace(next);
      } catch (error) {
        if (cancelled) return;
        // 404: no update service here. While busy the portal is restarting,
        // so failures are expected. Otherwise stay quiet too, except for a
        // lost session.
        if (!busy && error instanceof ApiError && error.status === 401) onError(error);
      }
    }

    void poll();
    const id = window.setInterval(() => void poll(), busy ? BUSY_POLL_MS : IDLE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, busy, onError, replace]);

  return { overview, now, replace };
}
