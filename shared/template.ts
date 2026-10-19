import { berlinMinuteOfDay, berlinYmd } from "./days.ts";
import type { Linked } from "./tickets.ts";

export type TemplateKind = "appointment" | "call";

/**
 * Something TANSS already recorded that probably deserves a booking: a
 * calendar entry or a phone call. A template is never booked time — it counts
 * in no sum. One click turns it into a draft, and a marker keeps it from
 * offering itself twice.
 */
export type BookingTemplate = {
  /** "termin:900" / "anruf:12" — stable across reloads. */
  key: string;
  kind: TemplateKind;
  /** Unix seconds of the start. */
  date: number;
  startMinute: number;
  duration: number;
  title: string;
  detail: string;
  ticketId: number;
  companyId: number;
  companyName: string;
  location: "OFFICE" | "CUSTOMER" | "REMOTE";
  /** Set on a Teams appointment. */
  teamsUrl: string;
};

/** Calls shorter than this are ringing, not work. */
export const MIN_CALL_SECONDS = 60;

export const APPOINTMENT_PLANNING_TYPES = [
  "APPOINTMENT_FIX",
  "APPOINTMENT_PROPOSAL",
  "APPOINTMENT_PRIVATE",
] as const;

export function isAppointment(planningType: unknown): boolean {
  return typeof planningType === "string" && planningType.startsWith("APPOINTMENT");
}

function linkedName(linked: Linked, group: string, id: number): string {
  if (!id) return "";
  const value = linked[group]?.[String(id)]?.name;
  return typeof value === "string" ? value : "";
}

/**
 * A calendar entry as a template. Where it takes place follows from what TANSS
 * knows: a Teams link means remote, a named location means on site.
 */
export function appointmentToTemplate(raw: Record<string, unknown>, linked: Linked): BookingTemplate {
  const date = Number(raw.date ?? 0) || 0;
  const companyId = Number(raw.companyId ?? 0) || 0;
  const teamsUrl = String(raw.teamsUrl ?? "");
  const place = String(raw.outlookLocation ?? "").trim();
  const title = String(raw.outlookTitle ?? "").trim() || String(raw.text ?? "").trim();
  return {
    key: `termin:${Number(raw.id ?? 0) || 0}`,
    kind: "appointment",
    date,
    startMinute: berlinMinuteOfDay(date),
    duration: Number(raw.duration ?? 0) || 0,
    title: title || "Termin",
    detail: place || (teamsUrl ? "Teams" : ""),
    ticketId: Number(raw.ticketId ?? 0) || 0,
    companyId,
    companyName: linkedName(linked, "companies", companyId),
    location: teamsUrl ? "REMOTE" : place ? "CUSTOMER" : "OFFICE",
    teamsUrl,
  };
}

/**
 * A phone call as a template. Only connected calls of at least a minute; the
 * duration is rounded up, because a booking of "0 min" helps nobody.
 */
export function callToTemplate(raw: Record<string, unknown>): BookingTemplate | null {
  if (raw.connectionEstablished === false) return null;
  const seconds = Number(raw.durationCall ?? 0) || 0;
  if (seconds < MIN_CALL_SECONDS) return null;
  const date = Number(raw.date ?? 0) || 0;
  const outgoing = String(raw.direction ?? "") === "OUT";
  const infos = (outgoing ? raw.toPhoneNrInfos : raw.fromPhoneNrInfos) as
    | { result?: Record<string, unknown> }
    | undefined;
  const result = infos?.result ?? {};
  const number = String((outgoing ? raw.toPhoneNumber : raw.fromPhoneNumber) ?? "");
  const name = String(result.name ?? "").trim();
  return {
    key: `anruf:${Number(raw.id ?? 0) || 0}`,
    kind: "call",
    date,
    startMinute: berlinMinuteOfDay(date),
    duration: Math.max(1, Math.ceil(seconds / 60)),
    title: `Telefonat ${outgoing ? "an" : "von"} ${name || number || "unbekannt"}`,
    detail: name && number ? number : "",
    ticketId: 0,
    companyId: Number(result.companyId ?? result.id ?? 0) || 0,
    companyName: name,
    location: "REMOTE",
    teamsUrl: "",
  };
}

/** The marker that a template has been booked: one per template and day. */
export function templateKey(key: string, ymd: string): string {
  return `${key}|${ymd}`;
}

/** Templates of that day that have not been turned into a booking yet. */
export function openTemplates(
  templates: BookingTemplate[],
  booked: Record<string, number>,
  ymd: string,
): BookingTemplate[] {
  return templates
    .filter((t) => berlinYmd(t.date) === ymd)
    .filter((t) => booked[templateKey(t.key, ymd)] === undefined)
    .sort((a, b) => a.startMinute - b.startMinute || a.key.localeCompare(b.key));
}
