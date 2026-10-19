import { api } from "./api.ts";

export type Target = { kind: "ticket" | "company"; id: number; label: string };

/**
 * Tickets and customers for a query. TANSS searches ticket titles, not ticket
 * numbers, so a plain number is looked up directly — otherwise typing "4711"
 * finds nothing, which is exactly the number people have in their head.
 */
export async function findTargets(query: string): Promise<Target[]> {
  const text = query.trim();
  if (text.length < 2) return [];
  const number = /^#?(\d{1,10})$/.exec(text);
  const [byNumber, result] = await Promise.all([
    number
      ? api
          .ticketHead(Number(number[1]))
          .then<Target[]>((t) => [
            {
              kind: "ticket",
              id: t.ticket.id,
              label: `#${t.ticket.id} ${t.ticket.title}${t.ticket.companyName ? ` · ${t.ticket.companyName}` : ""}`,
            },
          ])
          // A number that is no ticket is not an error, just no hit.
          .catch(() => [] as Target[])
      : Promise.resolve([] as Target[]),
    api.search(text).catch(() => ({ tickets: [], companies: [] })),
  ]);
  const found: Target[] = [
    ...byNumber,
    ...result.tickets
      .filter((t) => !byNumber.some((b) => b.id === t.id))
      .map<Target>((t) => ({
        kind: "ticket",
        id: t.id,
        label: `#${t.id} ${t.title}${t.companyName ? ` · ${t.companyName}` : ""}`,
      })),
    ...result.companies.map<Target>((c) => ({ kind: "company", id: c.id, label: c.name })),
  ];
  return found;
}
