import { useEffect, useState } from "react";
import { api, ApiError } from "./api.ts";
import { isBusy, updateBanner, type UpdateOverview } from "../shared/update.ts";

const IDLE_POLL_MS = 30 * 60_000;
const BUSY_POLL_MS = 3_000;
const DISMISSED_KEY = "agent-portal.update.dismissed";

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

type Props = {
  onToast: (text: string) => void;
  onError: (error: unknown) => void;
};

/**
 * The update notice above all views. It polls the overview itself — slowly
 * while idle, quickly while an update runs — and reloads the page once the
 * server reports another version than this bundle.
 */
export function UpdateBanner(props: Props) {
  const [overview, setOverview] = useState<UpdateOverview | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { onToast, onError } = props;
  const busy = overview !== null && isBusy(overview, now);

  // Poll right away and again on an interval: slow while idle, fast while an
  // update runs. The effect restarts whenever `busy` flips.
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const next = await api.update();
        if (cancelled) return;
        if (next.current !== __APP_VERSION__) {
          // The new version is live; this bundle is stale.
          location.reload();
          return;
        }
        setOverview(next);
        setNow(Date.now());
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
  }, [busy, onError]);

  if (!overview) return null;
  const banner = updateBanner(overview, now);
  if (!banner) return null;
  const statusId = overview.status?.id ?? null;
  if (banner.tone === "error" && statusId !== null && statusId === dismissed) return null;

  const latest = overview.latest;

  async function start() {
    if (!latest) return;
    const ok = window.confirm(
      `Das Portal startet dabei neu und ist etwa eine Minute nicht erreichbar. Jetzt auf ${latest.version} aktualisieren?`,
    );
    if (!ok) return;
    setStarting(true);
    try {
      setOverview(await api.startUpdate(latest.version));
      setNow(Date.now());
    } catch (error) {
      // 409 / 503 carry a sentence for the user; report() would mistake 503 for TANSS being down.
      if (error instanceof ApiError && (error.status === 409 || error.status === 503)) onToast(error.message);
      else onError(error);
    } finally {
      setStarting(false);
    }
  }

  function dismiss() {
    if (statusId === null) return;
    try {
      localStorage.setItem(DISMISSED_KEY, statusId);
    } catch {
      // Private mode: the hint just comes back after a reload.
    }
    setDismissed(statusId);
  }

  return (
    <div className={banner.tone === "error" ? "banner danger" : "banner"} role="status">
      <span className={`dot sm ${banner.tone === "error" ? "danger" : banner.tone === "progress" ? "agent" : "ok"}`} />
      <span>{banner.text}</span>
      <span className="row" style={{ marginLeft: "auto", gap: 8 }}>
        {banner.tone === "info" && latest?.url ? (
          <a href={latest.url} target="_blank" rel="noreferrer">
            Versionshinweise
          </a>
        ) : null}
        {banner.action === "update" && latest ? (
          <button className="btn primary" disabled={starting} onClick={() => void start()}>
            Jetzt aktualisieren
          </button>
        ) : null}
        {banner.tone === "error" ? (
          <button className="btn ghost" onClick={dismiss}>
            Ausblenden
          </button>
        ) : null}
      </span>
    </div>
  );
}
