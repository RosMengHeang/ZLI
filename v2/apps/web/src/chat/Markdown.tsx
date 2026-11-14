import { Fragment, type ReactNode, useContext } from "react";

import type { FileLinks } from "../files/FileIndex.js";
import { Icon } from "../ui/Icon.js";
import { ChatImage, isImagePath } from "./ChatImage.js";
import { CodeBlock } from "./CodeBlock.js";
import { CitationChip, CitationContext, sourceKey, useOpenWebLink } from "./Sources.js";

export type ListItem = { text: string; checked?: boolean; children: ListBlock[] };
export type ListBlock = { kind: "list"; ordered: boolean; start?: number; items: ListItem[] };
export type TableAlign = "left" | "center" | "right" | undefined;

type Block =
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | ListBlock
  | { kind: "table"; head: string[]; align: TableAlign[]; rows: string[][] }
  | { kind: "rule" }
  | { kind: "quote"; text: string }
  | { kind: "paragraph"; text: string };

const FENCE = /^\s*```\s*([\w+#.-]*)\s*$/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const ITEM = /^(\s*)(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/u;
const TASK = /^\[([ xX])\]\s+(.*)$/u;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u;
const QUOTE = /^>\s?(.*)$/u;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/u;

function indentWidth(space: string): number {
  return space.replaceAll("\t", "    ").length;
}

/** The cells of one table row. A pipe inside inline code or after a backslash stays in its cell. */
export function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  const text = line.trim();
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === "\\" && text[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (char === "`") {
      inCode = !inCode;
      cell += char;
    } else if (char === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else cell += char;
  }
  cells.push(cell.trim());
  if (text.startsWith("|")) cells.shift();
  if (text.endsWith("|") && !text.endsWith("\\|")) cells.pop();
  return cells;
}

/**
 * A list starting at `index`. Items indented two or more spaces past their parent nest under it,
 * and a blank line between two items keeps them in one list, so "1." and "2." do not both show 1.
 */
function parseList(lines: readonly string[], index: number, indent: number): { block: ListBlock; next: number } {
  const first = ITEM.exec(lines[index] ?? "");
  const ordered = first?.[3] !== undefined;
  const block: ListBlock = { kind: "list", ordered, items: [] };
  if (ordered && first?.[3] !== undefined && Number(first[3]) !== 1) block.start = Number(first[3]);
  let cursor = index;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? "";
    const match = ITEM.exec(line);
    const last = block.items.at(-1);
    if (match) {
      const width = indentWidth(match[1] ?? "");
      if (width < indent) break;
      if (width >= indent + 2 && last) {
        const nested = parseList(lines, cursor, width);
        last.children.push(nested.block);
        cursor = nested.next;
        continue;
      }
      if ((match[3] !== undefined) !== ordered) break;
      const body = match[4] ?? "";
      const task = TASK.exec(body);
      block.items.push(
        task ? { text: task[2] ?? "", checked: task[1] !== " ", children: [] } : { text: body, children: [] },
      );
      cursor += 1;
      continue;
    }
    if (line.trim() === "") {
      const next = ITEM.exec(lines[cursor + 1] ?? "");
      if (next && indentWidth(next[1] ?? "") >= indent) {
        cursor += 1;
        continue;
      }
      break;
    }
    if (last && /^\s{2,}\S/u.test(line) && !FENCE.test(line)) {
      last.text += `\n${line.trim()}`;
      cursor += 1;
      continue;
    }
    break;
  }
  return { block, next: cursor };
}

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
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    if (line.includes("|") && TABLE_RULE.test(lines[index + 1] ?? "") && (lines[index + 1] ?? "").includes("-")) {
      const head = tableCells(line);
      const rule = tableCells(lines[index + 1] ?? "");
      if (head.length > 0 && rule.length === head.length) {
        flush();
        const align = rule.map((cell): TableAlign => {
          const left = cell.startsWith(":");
          const right = cell.endsWith(":");
          return left && right ? "center" : right ? "right" : left ? "left" : undefined;
        });
        const rows: string[][] = [];
        index += 2;
        while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim() !== "") {
          const cells = tableCells(lines[index] ?? "");
          rows.push(head.map((_, column) => cells[column] ?? ""));
          index += 1;
        }
        index -= 1;
        blocks.push({ kind: "table", head, align, rows });
        continue;
      }
    }
    const item = ITEM.exec(line);
    if (item) {
      flush();
      const list = parseList(lines, index, indentWidth(item[1] ?? ""));
      blocks.push(list.block);
      index = list.next - 1;
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      const body = [quote[1] ?? ""];
      while (QUOTE.test(lines[index + 1] ?? "")) {
        index += 1;
        body.push(QUOTE.exec(lines[index] ?? "")?.[1] ?? "");
      }
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") flush();
    else paragraph.push(line);
  }
  flush();
  return blocks;
}

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(\*[^*\s][^*\n]*\*)|(!\[[^\]\n]*\]\([^)\s]+\))|(~~[^~\n]+~~)|(https?:\/\/[^\s<>`]+)/gu;
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=]+$/iu;
const WEB_URL = /^https?:\/\/[^\s]+$/iu;

/** A bare web address without the sentence punctuation that follows it. */
export function trimUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?'"*]+$/u, "");
  while (url.endsWith(")") && url.split("(").length <= url.split(")").length - 1) url = url.slice(0, -1);
  return url.replace(/[.,;:!?'"*]+$/u, "");
}

/** The worktree file a Markdown image points to. Web images stay unloaded, like web links. */
function imagePath(href: string, links: FileLinks | undefined): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(href) && !/^[a-z]:[\\/]/iu.test(href)) return undefined;
  const resolved = links?.resolve(href)?.path ?? href.replace(/^\.\//u, "");
  return isImagePath(resolved) ? resolved : undefined;
}

/**
 * A web link. It opens in the system browser, never in the app window, and its address shows on
 * hover so the label cannot hide where it goes. A link to a page the turn searched becomes a
 * numbered citation after its words; a bare address of one is the number alone.
 */
function WebLink({ href, children }: { href: string; children: ReactNode }) {
  const open = useOpenWebLink();
  const citation = useContext(CitationContext)?.get(sourceKey(href));
  if (!WEB_URL.test(href)) {
    return (
      <span className="md-link is-inert" title={href}>
        {children}
      </span>
    );
  }
  if (citation) {
    return (
      <>
        {children === href ? null : children}
        <CitationChip citation={citation} />
      </>
    );
  }
  return (
    <button className="md-link" type="button" title={`Open ${href} in your browser`} onClick={() => open(href)}>
      {children}
    </button>
  );
}

function renderImage(alt: string, href: string, key: string, links: FileLinks | undefined): ReactNode {
  if (DATA_IMAGE.test(href)) return <ChatImage key={key} source={{ url: href, name: alt || "image" }} alt={alt} />;
  const path = imagePath(href, links);
  if (path) return <ChatImage key={key} source={{ path }} alt={alt} />;
  return (
    <WebLink key={key} href={href}>
      {alt || href}
    </WebLink>
  );
}

function fileLink(
  links: FileLinks,
  target: string,
  key: string,
  children: ReactNode,
  chip = false,
): ReactNode | undefined {
  const location = links.resolve(target);
  if (!location) return undefined;
  const suffix = location.line ? `:${location.line}${location.column ? `:${location.column}` : ""}` : "";
  return (
    <button
      className={`md-file-link${chip ? " is-chip" : ""}`}
      type="button"
      key={key}
      title={`Open ${location.path}${suffix}`}
      onClick={() => links.open(location)}
    >
      {chip ? <Icon name={isImagePath(location.path) ? "image" : "file"} size={11} /> : null}
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
    let token = match[0];
    const key = `${start}`;
    if (match[1]) {
      const code = token.slice(1, -1);
      const element = <code key={key}>{code}</code>;
      nodes.push((links && fileLink(links, code, key, <code>{code}</code>, true)) ?? element);
    } else if (match[2]) nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), links)}</strong>);
    else if (match[3]) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      nodes.push(
        (links && fileLink(links, href, key, label)) ?? (
          <WebLink key={key} href={href}>
            {label}
          </WebLink>
        ),
      );
    } else if (match[5]) {
      const split = token.indexOf("](");
      nodes.push(renderImage(token.slice(2, split), token.slice(split + 2, -1), key, links));
    } else if (match[6]) nodes.push(<del key={key}>{renderInline(token.slice(2, -2), links)}</del>);
    else if (match[7]) {
      token = trimUrl(token);
      nodes.push(
        <WebLink key={key} href={token}>
          {token}
        </WebLink>,
      );
    } else nodes.push(<em key={key}>{renderInline(token.slice(1, -1), links)}</em>);
    last = start + token.length;
  }
  if (last < text.length) nodes.push(...renderText(text.slice(last), `t${last}`, links));
  return nodes;
}

function renderLines(text: string, key: string, links: FileLinks | undefined): ReactNode {
  return text.split("\n").map((line, lineIndex) => (
    <Fragment key={`${key}-${lineIndex.toString()}`}>
      {lineIndex > 0 ? <br /> : null}
      {renderInline(line, links)}
    </Fragment>
  ));
}

function renderList(block: ListBlock, key: string, links: FileLinks | undefined): ReactNode {
  const items = block.items.map((item, index) => {
    const itemKey = `${key}-${index.toString()}`;
    return (
      <li key={itemKey} className={item.checked === undefined ? undefined : "md-task"}>
        {item.checked === undefined ? null : (
          <span
            className={`md-task-box${item.checked ? " is-done" : ""}`}
            role="img"
            aria-label={item.checked ? "Done" : "To do"}
          >
            {item.checked ? <Icon name="check" size={10} /> : null}
          </span>
        )}
        {renderLines(item.text, itemKey, links)}
        {item.children.map((child, childIndex) => renderList(child, `${itemKey}-c${childIndex.toString()}`, links))}
      </li>
    );
  });
  return block.ordered ? (
    <ol key={key} start={block.start}>
      {items}
    </ol>
  ) : (
    <ul key={key}>{items}</ul>
  );
}

function listTexts(block: ListBlock): string[] {
  return block.items.flatMap((item) => [item.text, ...item.children.flatMap(listTexts)]);
}

/**
 * Image files a reply names without Markdown image syntax, such as "Saved it to assets/logo.png".
 * Code blocks are skipped, since paths there are usually part of a command or a listing.
 */
function mentionedImages(blocks: readonly Block[], links: FileLinks | undefined): string[] {
  if (!links) return [];
  const embedded = new Set<string>();
  const found: string[] = [];
  for (const block of blocks) {
    if (block.kind === "code" || block.kind === "rule") continue;
    const texts =
      block.kind === "list"
        ? listTexts(block)
        : block.kind === "table"
          ? [...block.head, ...block.rows.flat()]
          : [block.text];
    for (const text of texts) {
      for (const match of text.matchAll(INLINE)) {
        if (match[5]) {
          const href = match[5].slice(match[5].indexOf("](") + 2, -1);
          const path = imagePath(href, links);
          if (path) embedded.add(path);
        } else if (match[1]) {
          const path = links.resolve(match[1].slice(1, -1))?.path;
          if (path && isImagePath(path)) found.push(path);
        }
      }
      for (const reference of links.find(text)) {
        if (isImagePath(reference.location.path)) found.push(reference.location.path);
      }
    }
  }
  return [...new Set(found)].filter((path) => !embedded.has(path)).slice(0, 8);
}

/**
 * Renders agent replies as React elements. No HTML from the agent reaches the app's DOM; HTML and
 * SVG blocks preview inside a sandboxed frame with scripts and network requests off. With
 * `showImages`, image files the reply names show below it.
 */
export function Markdown({
  text,
  links,
  showImages = false,
}: {
  text: string;
  links?: FileLinks | undefined;
  showImages?: boolean;
}) {
  const blocks = parseMarkdown(text);
  const images = showImages ? mentionedImages(blocks, links) : [];
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
          case "list":
            return renderList(block, key, links);
          case "table":
            return (
              <div className="md-table-wrap" key={key}>
                <table className="md-table">
                  <thead>
                    <tr>
                      {block.head.map((cell, column) => (
                        <th key={`${key}-h${column.toString()}`} style={{ textAlign: block.align[column] }}>
                          {renderInline(cell, links)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={`${key}-r${rowIndex.toString()}`}>
                        {row.map((cell, column) => (
                          <td
                            key={`${key}-r${rowIndex.toString()}-${column.toString()}`}
                            style={{ textAlign: block.align[column] }}
                          >
                            {renderInline(cell, links)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "rule":
            return <hr className="md-rule" key={key} />;
          case "quote":
            return <blockquote key={key}>{renderLines(block.text, key, links)}</blockquote>;
          default:
            return <p key={key}>{renderLines(block.text, key, links)}</p>;
        }
      })}
      {images.length > 0 ? (
        <div className="chat-image-gallery">
          {images.map((path) => (
            <ChatImage key={path} source={{ path }} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
