import type { Linked } from "./tickets.ts";

export type ThreadKind =
  | "Beschreibung"
  | "Interne Notiz"
  | "Kommentar"
  | "Mail eingehend"
  | "Mail ausgehend"
  | "Leistung";

export type ThreadEntry = {
  key: string;
  kind: ThreadKind;
  author: string;
  /** Mail address of the sender; empty for everything that is not a mail. */
  from: string;
  /** Unix seconds; 0 for the description when creationDate is missing. */
  at: number;
  title: string;
  text: string;
  /** Minutes, only for a support. */
  duration: number;
};

type Obj = Record<string, unknown>;

function employeeName(linked: Linked, id: number): string {
  const entry = linked.employees?.[String(id)];
  const name = entry?.name;
  return typeof name === "string" ? name : "";
}

function asArray(value: unknown): Obj[] {
  return Array.isArray(value)
    ? value.filter((v): v is Obj => typeof v === "object" && v !== null)
    : [];
}

/** The mail body as text: plain when present, otherwise stripped HTML. */
export function mailText(mail: Obj): string {
  const plain = String(mail.bodyPlain ?? "").trim();
  if (plain) return plain;
  const html = String(mail.bodyHtml ?? "");
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Description, comments, mails and supports of a ticket in one chronological
 * list. Chats are a different thing and stay out.
 */
export function buildThread(
  ticket: Obj,
  history: Obj,
  linked: Linked,
  companyName: string,
): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  const description = String(ticket.content ?? "").trim();
  entries.push({
    key: "description",
    kind: "Beschreibung",
    author:
      employeeName(linked, Number(ticket.createdEmployeeId ?? 0)) || companyName || "Ticket",
    from: "",
    at: Number(ticket.creationDate ?? 0) || 0,
    title: String(ticket.title ?? ""),
    text: description || "(keine Beschreibung)",
    duration: 0,
  });
  for (const comment of asArray(history.comments)) {
    entries.push({
      key: `comment:${comment.id}`,
      kind: comment.internal ? "Interne Notiz" : "Kommentar",
      author: employeeName(linked, Number(comment.employeeId ?? 0)) || "Mitarbeiter",
      from: "",
      at: Number(comment.date ?? 0) || 0,
      title: String(comment.title ?? ""),
      text: String(comment.content ?? "").trim(),
      duration: 0,
    });
  }
  for (const mail of asArray(history.mails)) {
    const receivers = asArray(mail.receivers);
    const sent = receivers
      .map((r) => Number(r.sentDate ?? 0) || 0)
      .reduce((a, b) => Math.max(a, b), 0);
    entries.push({
      key: `mail:${mail.id}`,
      kind: mail.inbound ? "Mail eingehend" : "Mail ausgehend",
      author:
        String(mail.senderName ?? "").trim() || String(mail.senderEmail ?? "").trim() || "Mail",
      from: String(mail.senderEmail ?? "").trim(),
      at: Number(mail.date ?? 0) || sent,
      title: String(mail.subject ?? ""),
      text: mailText(mail),
      duration: 0,
    });
  }
  for (const support of asArray(history.supports)) {
    entries.push({
      key: `support:${support.id}`,
      kind: "Leistung",
      author: employeeName(linked, Number(support.employeeId ?? 0)) || "Mitarbeiter",
      from: "",
      at: Number(support.date ?? 0) || 0,
      title: "",
      text: String(support.text ?? "").trim(),
      duration: Number(support.duration ?? 0) || 0,
    });
  }
  const [head, ...rest] = entries;
  rest.sort((a, b) => a.at - b.at);
  return [head, ...rest];
}
