import type { View } from "./Shell.tsx";

/**
 * Where the person is, written into the address after the #: the view, the day
 * of the day sheet and the open ticket. So a reload lands in the same place and
 * the browser's back button works. The # never reaches the server.
 */
export type Route = { view: View; ticket: number | null; day: string | null };

const VIEWS: readonly View[] = ["today", "dashboard", "tickets", "times", "analysis", "import", "log", "settings"];

export function parseRoute(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const [name, part] = path.split("/");
  const view = VIEWS.find((v) => v === name) ?? "today";
  return {
    view,
    ticket: parseTicket(new URLSearchParams(query).get("ticket")),
    day: view === "times" && isDay(part) ? part : null,
  };
}

export function formatRoute(route: Route): string {
  const day = route.view === "times" && route.day ? `/${route.day}` : "";
  const ticket = route.ticket ? `?ticket=${route.ticket}` : "";
  return `#/${route.view}${day}${ticket}`;
}

function parseTicket(raw: string | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isDay(raw: string | undefined): raw is string {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  // 2026-02-30 parses and rolls over to March; only a real day reads back the same.
  const parsed = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw;
}
