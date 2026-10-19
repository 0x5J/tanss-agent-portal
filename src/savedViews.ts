import { LISTS } from "../shared/tickets.ts";
import { parseSavedViews, type SavedView } from "../shared/filters.ts";
import { api } from "./api.ts";

const key = (employeeId: number) => `agent-portal:views:${employeeId}`;

function readLocal(employeeId: number): SavedView[] {
  try {
    const raw = localStorage.getItem(key(employeeId));
    return parseSavedViews(raw ? JSON.parse(raw) : [], LISTS.map((l) => l.id));
  } catch {
    return [];
  }
}

function writeLocal(employeeId: number, views: SavedView[]): void {
  try {
    localStorage.setItem(key(employeeId), JSON.stringify(views));
  } catch {
    /* storage unavailable — the server copy is the real one anyway */
  }
}

/**
 * Saved lists live on the server (so the dashboard poller can count them),
 * with this browser's localStorage as offline copy. A browser that still has
 * only local lists pushes them up once.
 */
export async function loadViews(employeeId: number): Promise<SavedView[]> {
  const local = readLocal(employeeId);
  try {
    const remote = (await api.views()).views;
    if (remote.length > 0) {
      writeLocal(employeeId, remote);
      return remote;
    }
    if (local.length > 0) await api.saveViews(local).catch(() => null);
    return local;
  } catch {
    return local;
  }
}

export async function storeViews(employeeId: number, views: SavedView[]): Promise<void> {
  writeLocal(employeeId, views);
  await api.saveViews(views);
}

export function newViewId(): string {
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const tabKey = (employeeId: number) => `agent-portal:tab:${employeeId}`;

/** Which tab was open last — a built-in list id or a saved view id. */
export function loadActiveTab(employeeId: number): string {
  try {
    return localStorage.getItem(tabKey(employeeId)) ?? "";
  } catch {
    return "";
  }
}

export function storeActiveTab(employeeId: number, tab: string): void {
  try {
    localStorage.setItem(tabKey(employeeId), tab);
  } catch {
    /* ignore */
  }
}
