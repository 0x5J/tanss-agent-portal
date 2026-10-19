// Guards the automatic reload after an update: once per target version and
// tab, so a server that keeps reporting another version than the bundle (e.g.
// a cached old bundle) cannot put the page into a reload loop.

export const RELOADED_KEY = "agent-portal.update.reloaded";

type SessionStore = Pick<Storage, "getItem" | "setItem">;

/** The tab's session storage, or null where it is not available. */
export function sessionStore(): SessionStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * True when the page may reload for `version` now, and records that it did.
 * Without a storage to record it in, it never reloads.
 */
export function claimReload(version: string, storage: SessionStore | null): boolean {
  if (!storage) return false;
  try {
    if (storage.getItem(RELOADED_KEY) === version) return false;
    storage.setItem(RELOADED_KEY, version);
    return true;
  } catch {
    return false;
  }
}
