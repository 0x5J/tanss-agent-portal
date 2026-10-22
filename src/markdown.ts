/**
 * Local models answer in Markdown even when asked for plain text. This reads
 * the small part of it they actually use — headings, lists, bold, italic,
 * code — so the views can draw it instead of showing the stars. No
 * HTML is ever built from the text; anything unknown stays as it was written.
 */

export type Inline = string | { bold: Inline[] } | { italic: Inline[] } | { code: string };

export type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; start: number; items: string[] }
  | { kind: "code"; lines: string[] };

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*+•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
// Code between fences is kept exactly as written. "```cmd```" on one line is
// a code block too; a fence that never closes only loses its marks.
const ONE_LINE_FENCE = /^\s*```(.*?)```\s*$/;
const FENCE_START = /^\s*```(.*)$/;
const FENCE_END = /^\s*```\s*$/;
const LANGUAGE_TAG = /^[\w+#.-]+$/;

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let open = null as Block | null;
  const close = () => {
    if (open) blocks.push(open);
    open = null;
  };

  const all = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < all.length; i++) {
    let line = all[i].trimEnd();
    const oneLine = ONE_LINE_FENCE.exec(line);
    if (oneLine) {
      close();
      if (oneLine[1].trim()) blocks.push({ kind: "code", lines: [oneLine[1].trim()] });
      continue;
    }
    const fence = FENCE_START.exec(line);
    if (fence) {
      const rest = fence[1].trim();
      const end = all.findIndex((l, j) => j > i && FENCE_END.test(l));
      if (end === -1) {
        line = rest;
      } else {
        close();
        const body = all.slice(i + 1, end).map((l) => l.trimEnd());
        // "```powershell" names the language; "```hostname" over nothing is the command.
        const lines = rest && (!LANGUAGE_TAG.test(rest) || !body.some((l) => l.trim())) ? [rest, ...body] : body;
        if (lines.some((l) => l.trim())) blocks.push({ kind: "code", lines });
        i = end;
        continue;
      }
    }
    if (!line.trim() || RULE.test(line)) {
      close();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      blocks.push({ kind: "h", text: heading[1] });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      if (open?.kind !== "ul") {
        close();
        open = { kind: "ul", items: [] };
      }
      open.items.push(bullet[1]);
      continue;
    }
    const numbered = NUMBERED.exec(line);
    if (numbered) {
      if (open?.kind !== "ol") {
        close();
        open = { kind: "ol", start: Number(numbered[1]), items: [] };
      }
      open.items.push(numbered[2]);
      continue;
    }
    // An indented line under a list item belongs to that item.
    if ((open?.kind === "ul" || open?.kind === "ol") && /^\s/.test(line)) {
      open.items[open.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    if (open?.kind !== "p") {
      close();
      open = { kind: "p", lines: [] };
    }
    open.lines.push(line.trim());
  }
  close();
  return blocks;
}

// Bold before italic, so "**x**" is never read as two empty italics. Single
// stars and underscores only count at word edges: "file_name" and "2*3*4"
// stay as they are.
const INLINE =
  /\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__|`([^`]+)`|(?<![\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])(.+?)(?<=[^\s_])_(?![\w_])/;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const [, bold, boldU, code, italic, italicU] = m;
    if (bold ?? boldU) out.push({ bold: parseInline(bold ?? boldU) });
    else if (code !== undefined) out.push({ code });
    else out.push({ italic: parseInline(italic ?? italicU) });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function inlineText(parts: Inline[]): string {
  return parts
    .map((p) => (typeof p === "string" ? p : "code" in p ? p.code : inlineText("bold" in p ? p.bold : p.italic)))
    .join("");
}

/**
 * The same answer as plain text, for the clipboard and the comment field:
 * markers gone, lists kept as "- " and "1. " lines.
 */
export function plainAgentText(text: string): string {
  return parseBlocks(text)
    .map((block) => {
      const flat = (s: string) => inlineText(parseInline(s));
      switch (block.kind) {
        case "p":
          return block.lines.map(flat).join("\n");
        case "h":
          return flat(block.text);
        case "ul":
          return block.items.map((item) => `- ${flat(item)}`).join("\n");
        case "ol":
          return block.items.map((item, i) => `${block.start + i}. ${flat(item)}`).join("\n");
        case "code":
          return block.lines.join("\n");
      }
    })
    .join("\n\n");
}
