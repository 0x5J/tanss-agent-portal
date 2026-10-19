import { useState } from "react";
import { ApiError, api } from "./api.ts";
import { updateBanner, type UpdateOverview } from "../shared/update.ts";

const DISMISSED_KEY = "agent-portal.update.dismissed";

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

type StartHandlers = {
  onOverview: (next: UpdateOverview) => void;
  onToast: (text: string) => void;
  onError: (error: unknown) => void;
};

/**
 * Asks before anything happens, then hands the version to the updater. The
 * banner button and the version line in the navigation both come here.
 * Returns once the request is answered, whatever the outcome.
 */
export async function confirmAndStartUpdate(version: string, handlers: StartHandlers): Promise<void> {
  const ok = window.confirm(
    `Das Portal startet dabei neu und ist etwa eine Minute nicht erreichbar. Jetzt auf ${version} aktualisieren?`,
  );
  if (!ok) return;
  try {
    handlers.onOverview(await api.startUpdate(version));
  } catch (error) {
    // 409 / 503 carry a sentence for the user; report() would mistake 503 for TANSS being down.
    if (error instanceof ApiError && (error.status === 409 || error.status === 503)) handlers.onToast(error.message);
    else handlers.onError(error);
  }
}

type Props = {
  /** From useUpdateOverview; null shows nothing. */
  overview: UpdateOverview | null;
  now: number;
  onOverview: (next: UpdateOverview) => void;
  onToast: (text: string) => void;
  onError: (error: unknown) => void;
};

/** The update notice above all views. */
export function UpdateBanner(props: Props) {
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const [starting, setStarting] = useState(false);
  const { overview, now, onOverview, onToast, onError } = props;

  if (!overview) return null;
  const banner = updateBanner(overview, now);
  if (!banner) return null;
  const statusId = overview.status?.id ?? null;
  if (banner.tone === "error" && statusId !== null && statusId === dismissed) return null;

  const latest = overview.latest;

  async function start() {
    if (!latest) return;
    setStarting(true);
    await confirmAndStartUpdate(latest.version, { onOverview, onToast, onError });
    setStarting(false);
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
