import { sortRows, toTicketRow, type TicketRow } from "../shared/tickets.ts";
import { TanssError, type LinkedEntities, type TanssClient, type TanssSession } from "./tanss.ts";

export type Board = {
  rows: TicketRow[];
  employeeId: number;
  employeeName: string;
  missing: string[];
};

/**
 * Every open ticket the lists can show, in one answer: own, unassigned and
 * the other technicians'. The board tabs are filter presets over this set.
 *
 * `withProjects` adds the project list on top. The browser asks for it — the
 * board has a tab for them — the poller does not: projects run for months, so
 * counting them every five minutes would say nothing about the day's load and
 * would change what the existing charts and day reports mean. Both still see
 * the same daily set, which is what those numbers are about.
 */
export async function loadBoard(
  tanss: TanssClient,
  session: TanssSession,
  withProjects = false,
): Promise<Board> {
  const kinds = withProjects
    ? (["own", "general", "technician", "projects"] as const)
    : (["own", "general", "technician"] as const);
  const results = await Promise.all(
    kinds.map((kind) =>
      tanss.ticketList(session, kind).then(
        (r) => ({ kind, ...r, ok: true }),
        (error: unknown) => ({
          kind,
          items: [] as Record<string, unknown>[],
          linked: {} as LinkedEntities,
          waitingStates: [] as number[],
          ok: false,
          error,
        }),
      ),
    ),
  );
  if (results.every((r) => !r.ok)) {
    const failed = (results.find((r) => !r.ok) as { error?: unknown } | undefined)?.error;
    // Keep the original status: a 401 must stay a 401 so the session heals.
    if (failed instanceof TanssError) throw failed;
    throw new TanssError(failed instanceof Error ? failed.message : "Ticketlisten nicht lesbar", 502);
  }
  const waiting = [...new Set(results.flatMap((r) => r.waitingStates))];
  const seen = new Set<number>();
  const rows: TicketRow[] = [];
  let employeeName = "";
  for (const result of results) {
    const me = result.linked.employees?.[String(session.employeeId)]?.name;
    if (typeof me === "string" && me) employeeName = me;
    for (const item of result.items) {
      const row = toTicketRow(item, result.linked, waiting);
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  return {
    rows: sortRows(rows),
    employeeId: session.employeeId,
    employeeName,
    missing: results.filter((r) => !r.ok).map((r) => r.kind),
  };
}
