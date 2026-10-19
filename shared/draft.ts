import type { BookingIdea } from "./assistant.ts";
import type { Routine } from "./routines.ts";
import type { BookingTemplate } from "./template.ts";
import { berlinMinuteOfDay, berlinYmd } from "./days.ts";
import type { Support } from "./timeline.ts";

/**
 * What the booking form is filled with. Built here rather than in the view,
 * so the rules — which target wins, what stays empty — are testable.
 */
export type BookingDraft = {
  date: string;
  startMinute?: number;
  duration?: number;
  ticketId?: number;
  ticketTitle?: string;
  ticketLabel?: string;
  companyId?: number;
  companyName?: string;
  text?: string;
  typeId?: number;
  location?: "OFFICE" | "CUSTOMER" | "REMOTE";
  supportId?: number;
  lockText?: string;
  fromTemplate?: string;
};

export function draftForGap(day: string, start: number, end: number): BookingDraft {
  return { date: day, startMinute: start, duration: end - start };
}

/** A calendar entry or a phone call, with everything TANSS already knows. */
export function draftFromTemplate(day: string, template: BookingTemplate): BookingDraft {
  return {
    date: day,
    startMinute: template.startMinute,
    duration: template.duration,
    // A ticket brings its own customer; never send both.
    ticketId: template.ticketId || undefined,
    companyId: template.ticketId ? undefined : template.companyId || undefined,
    companyName: template.ticketId ? undefined : template.companyName || undefined,
    text: template.title,
    location: template.location,
    fromTemplate: template.key,
  };
}

/** A routine, shortened to what the gap can hold. */
export function draftFromRoutine(day: string, routine: Routine, start: number, minutes: number): BookingDraft {
  return {
    date: day,
    startMinute: start,
    duration: minutes,
    ticketId: routine.ticketId ?? undefined,
    ticketLabel: routine.ticketId ? routine.ticketLabel : undefined,
    companyId: routine.ticketId ? undefined : (routine.companyId ?? undefined),
    companyName: routine.ticketId ? undefined : routine.companyLabel || undefined,
    text: routine.text,
    typeId: routine.typeId ?? undefined,
  };
}

/**
 * An idea of the day assistant. The customer is deliberately left out: the
 * model only ever saw a *name*, never an id, so the person picks the target.
 * That keeps a suggestion from silently attaching itself to the wrong customer.
 */
export function draftFromIdea(day: string, idea: BookingIdea): BookingDraft {
  return {
    date: day,
    startMinute: idea.startMinute ?? undefined,
    duration: idea.minutes,
    text: idea.text,
  };
}

/** An existing booking, opened for changing. */
export function draftFromSupport(support: Support, lockText: string): BookingDraft {
  return {
    date: berlinYmd(support.date),
    startMinute: berlinMinuteOfDay(support.date),
    duration: support.duration,
    ticketId: support.ticketId || undefined,
    companyId: support.ticketId ? undefined : support.companyId || undefined,
    companyName: support.ticketId ? undefined : support.companyName || undefined,
    text: support.text,
    typeId: support.typeId || undefined,
    location: (support.location as BookingDraft["location"]) || "OFFICE",
    supportId: support.id,
    lockText,
  };
}
