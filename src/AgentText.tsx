import { Fragment, type ReactNode } from "react";
import { parseBlocks, parseInline, type Inline } from "./markdown.ts";

/**
 * An answer of the agent with its Markdown drawn: bold, lists, headings. A
 * single plain paragraph stays inline, so short answers flow on after a title
 * as before. `plain` draws the text between the marks (e.g. "#4711" as a link).
 */
export function AgentText(props: { text: string; plain?: (text: string) => ReactNode }) {
  const plain = props.plain ?? ((text: string) => text);
  const blocks = parseBlocks(props.text);
  const lines = (list: string[]) =>
    list.map((line, i) => (
      <Fragment key={i}>
        {i > 0 ? <br /> : null}
        {inline(parseInline(line), plain)}
      </Fragment>
    ));

  if (blocks.length === 0) return null;
  const only = blocks[0];
  if (blocks.length === 1 && only.kind === "p") return <span className="agent-text-inline">{lines(only.lines)}</span>;

  return (
    <div className="agent-text">
      {blocks.map((block, i) => {
        switch (block.kind) {
          case "p":
            return <p key={i}>{lines(block.lines)}</p>;
          case "h":
            return (
              <p key={i} className="agent-text-h">
                {inline(parseInline(block.text), plain)}
              </p>
            );
          case "ul":
            return (
              <ul key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{inline(parseInline(item), plain)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} start={block.start}>
                {block.items.map((item, j) => (
                  <li key={j}>{inline(parseInline(item), plain)}</li>
                ))}
              </ol>
            );
        }
      })}
    </div>
  );
}

function inline(parts: Inline[], plain: (text: string) => ReactNode): ReactNode[] {
  return parts.map((part, i) => {
    if (typeof part === "string") return <Fragment key={i}>{plain(part)}</Fragment>;
    if ("code" in part) return <code key={i}>{part.code}</code>;
    if ("bold" in part) return <strong key={i}>{inline(part.bold, plain)}</strong>;
    return <em key={i}>{inline(part.italic, plain)}</em>;
  });
}
