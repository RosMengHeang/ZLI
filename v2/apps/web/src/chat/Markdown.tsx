import { Fragment, type ReactNode } from "react";

import type { FileLinks } from "../files/FileIndex.js";
import { CodeBlock } from "./CodeBlock.js";

type Block =
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "paragraph"; text: string };

const FENCE = /^\s*```\s*([\w+-]*)\s*$/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const BULLET = /^\s*[-*+]\s+(.*)$/u;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/u;
const QUOTE = /^>\s?(.*)$/u;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ kind: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flush();
      const ordered = numbered !== null;
      const pattern = ordered ? NUMBERED : BULLET;
      const items: string[] = [];
      while (index < lines.length) {
        const match = pattern.exec(lines[index] ?? "");
        if (!match) break;
        items.push(match[1] ?? "");
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      blocks.push({ kind: "quote", text: quote[1] ?? "" });
      continue;
    }
    if (line.trim() === "") flush();
    else paragraph.push(line);
  }
  flush();
  return blocks;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\s][^*\n]*\*)/gu;

function fileLink(links: FileLinks, target: string, key: string, children: ReactNode): ReactNode | undefined {
  const location = links.resolve(target);
  if (!location) return undefined;
  const suffix = location.line ? `:${location.line}${location.column ? `:${location.column}` : ""}` : "";
  return (
    <button
      className="md-file-link"
      type="button"
      key={key}
      title={`Open ${location.path}${suffix}`}
      onClick={() => links.open(location)}
    >
      {children}
    </button>
  );
}

function renderText(text: string, keyPrefix: string, links: FileLinks | undefined): ReactNode[] {
  if (!links) return [text];
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const reference of links.find(text)) {
    if (reference.start < last) continue;
    if (reference.start > last) nodes.push(text.slice(last, reference.start));
    const label = text.slice(reference.start, reference.end);
    const { location } = reference;
    nodes.push(
      <button
        className="md-file-link is-plain"
        type="button"
        key={`${keyPrefix}-${reference.start}`}
        title={`Open ${location.path}${location.line ? `:${location.line}` : ""}`}
        onClick={() => links.open(location)}
      >
        {label}
      </button>,
    );
    last = reference.end;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Inline Markdown. With `links`, paths to files in the worktree become buttons that open the file. */
export function renderInline(text: string, links?: FileLinks): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(...renderText(text.slice(last, start), `t${last}`, links));
    const token = match[0];
    const key = `${start}`;
    if (match[1]) {
      const code = token.slice(1, -1);
      const element = <code key={key}>{code}</code>;
      nodes.push((links && fileLink(links, code, key, <code>{code}</code>)) ?? element);
    } else if (match[2]) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (match[3]) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      // Web links stay inert: following one would navigate the app window away from the workbench.
      nodes.push(
        (links && fileLink(links, href, key, label)) ?? (
          <span className="md-link" title={href} key={key}>
            {label}
          </span>
        ),
      );
    } else nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = start + token.length;
  }
  if (last < text.length) nodes.push(...renderText(text.slice(last), `t${last}`, links));
  return nodes;
}

/**
 * Renders agent replies as React elements. No HTML from the agent reaches the app's DOM; HTML and
 * SVG blocks preview inside a sandboxed frame with scripts and network requests off.
 */
export function Markdown({ text, links }: { text: string; links?: FileLinks | undefined }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        switch (block.kind) {
          case "code":
            return <CodeBlock key={key} lang={block.lang} text={block.text} />;
          case "heading":
            return (
              <p className={`md-heading md-h${Math.min(block.level, 3)}`} key={key}>
                {renderInline(block.text, links)}
              </p>
            );
          case "list": {
            const items = block.items.map((item, itemIndex) => (
              <li key={`${key}-${itemIndex.toString()}`}>{renderInline(item, links)}</li>
            ));
            return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
          }
          case "quote":
            return <blockquote key={key}>{renderInline(block.text, links)}</blockquote>;
          default:
            return (
              <p key={key}>
                {block.text.split("\n").map((line, lineIndex) => (
                  <Fragment key={`${key}-${lineIndex.toString()}`}>
                    {lineIndex > 0 ? <br /> : null}
                    {renderInline(line, links)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
