/**
 * Where work from an outside source is booked in TANSS. The key is a plain
 * string — today it is a Linear project name, tomorrow it could be a customer
 * or a ticket type. In the tool this was ported from, this table was the only
 * place a support type was ever remembered, and it hung on Linear projects;
 * keeping the key opaque is what stops that from happening again.
 */
export type Target = {
  /** A ticket brings its own customer, so only one of the two is ever set. */
  ticketId: number | null;
  ticketLabel: string;
  companyId: number | null;
  companyLabel: string;
  /** Remembered support type; null means "ask each time". */
  typeId: number | null;
};

export type Mappings = Record<string, Target>;

export const MAX_MAPPINGS = 200;

export const EMPTY_TARGET: Target = {
  ticketId: null,
  ticketLabel: "",
  companyId: null,
  companyLabel: "",
  typeId: null,
};

/** One target, never both — the same rule the booking itself follows. */
export function parseTarget(raw: unknown): Target {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const ticketId = Number(obj.ticketId ?? 0) || 0;
  const companyId = Number(obj.companyId ?? 0) || 0;
  const typeId = Number(obj.typeId ?? 0) || 0;
  return {
    ticketId: ticketId > 0 ? ticketId : null,
    ticketLabel: ticketId > 0 ? String(obj.ticketLabel ?? "").slice(0, 200) : "",
    companyId: ticketId > 0 || companyId <= 0 ? null : companyId,
    companyLabel: ticketId > 0 || companyId <= 0 ? "" : String(obj.companyLabel ?? "").slice(0, 200),
    typeId: typeId > 0 ? typeId : null,
  };
}

export function parseMappings(raw: unknown): Mappings {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Mappings = {};
  for (const [key, value] of Object.entries(raw).slice(0, MAX_MAPPINGS)) {
    const name = key.trim().slice(0, 200);
    if (!name) continue;
    const target = parseTarget(value);
    // A mapping that points nowhere is not worth remembering.
    if (target.ticketId === null && target.companyId === null && target.typeId === null) continue;
    out[name] = target;
  }
  return out;
}

/** True when the mapping is complete enough to book without asking. */
export function isBookable(target: Target | undefined): boolean {
  return Boolean(target && (target.ticketId !== null || target.companyId !== null) && target.typeId !== null);
}
