import DOMPurify from "dompurify";
import MarkdownIt, { type MarkdownIt as MarkdownParser, type StateCore } from "markdown-it";
import footnote from "markdown-it-footnote";

import { dirName } from "./filePaths.js";

/** Block tokens that get a `data-source-line` so the preview can map back to the source. */
const SOURCE_LINE_TOKENS = new Set([
  "paragraph_open",
  "heading_open",
  "blockquote_open",
  "bullet_list_open",
  "ordered_list_open",
  "list_item_open",
  "table_open",
  "tr_open",
  "hr",
  "fence",
  "code_block",
]);

const ALLOWED_CLASS =
  /^(?:language-[\w+#.-]+|task-list-item|task-list-item-checkbox|contains-task-list|footnotes?|footnotes-sep|footnotes-list|footnote-item|footnote-ref|footnote-backref)$/u;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|svg\+xml);base64,/iu;
const HAS_SCHEME = /^[a-z][a-z\d+.-]*:/iu;

/** Turns heading text into a GitHub-style anchor. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/gu, "-");
}

function addSourceLines(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.map && SOURCE_LINE_TOKENS.has(token.type)) token.attrSet("data-source-line", token.map[0] + 1);
  }
}

function addHeadingIds(state: StateCore): void {
  const used = new Map<string, number>();
  const tokens = state.tokens;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.type !== "heading_open") continue;
    const base = slugify(tokens[index + 1]?.content ?? "");
    if (!base) continue;
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    token.attrSet("id", count === 0 ? base : `${base}-${count}`);
  }
}

/** GitHub task lists: `- [ ] todo` and `- [x] done` become disabled checkboxes. */
function addTaskLists(state: StateCore): void {
  const tokens = state.tokens;
  for (let index = 2; index < tokens.length; index += 1) {
    const inline = tokens[index];
    if (inline?.type !== "inline") continue;
    if (tokens[index - 1]?.type !== "paragraph_open" || tokens[index - 2]?.type !== "list_item_open") continue;
    const match = /^\[([ xX])\][ \t]/u.exec(inline.content);
    const first = inline.children?.[0];
    if (!match || first?.type !== "text" || !first.content.startsWith(match[0])) continue;
    first.content = first.content.slice(match[0].length);
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input class="task-list-item-checkbox" type="checkbox" disabled${match[1] === " " ? "" : " checked"}> `;
    inline.children?.unshift(box);
    tokens[index - 2]?.attrJoin("class", "task-list-item");
  }
}

let parser: MarkdownParser | undefined;

function markdownParser(): MarkdownParser {
  if (parser) return parser;
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  md.use(footnote);
  md.core.ruler.push("zli_source_lines", addSourceLines);
  md.core.ruler.push("zli_heading_ids", addHeadingIds);
  md.core.ruler.push("zli_task_lists", addTaskLists);
  parser = md;
  return md;
}

let purifier: ReturnType<typeof DOMPurify> | undefined;

function markdownPurifier(): ReturnType<typeof DOMPurify> {
  if (purifier) return purifier;
  const instance = DOMPurify(window);
  // The preview acts on data-zli-* attributes, so only the sanitizer itself may set them.
  instance.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName.startsWith("data-zli-")) data.keepAttr = false;
  });
  instance.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof Element)) return;
    const classes = node.getAttribute("class");
    if (classes !== null) {
      const kept = classes.split(/\s+/u).filter((name) => ALLOWED_CLASS.test(name));
      if (kept.length > 0) node.setAttribute("class", kept.join(" "));
      else node.removeAttribute("class");
    }
    const tag = node.tagName.toLowerCase();
    if (tag === "a") {
      node.removeAttribute("target");
      node.setAttribute("rel", "noopener noreferrer");
    } else if (tag === "img") {
      const src = node.getAttribute("src") ?? "";
      node.setAttribute("loading", "lazy");
      node.setAttribute("referrerpolicy", "no-referrer");
      if (DATA_IMAGE.test(src)) return;
      node.removeAttribute("src");
      // Nothing loads during sanitizing. Worktree images load once the preview is on screen, and web
      // images wait for the reader to allow them because a request can tell a server the file was opened.
      if (/^https:\/\//iu.test(src)) node.setAttribute("data-zli-remote", src);
      else if (src && !HAS_SCHEME.test(src) && !src.startsWith("//")) node.setAttribute("data-zli-src", src);
      else node.setAttribute("data-zli-blocked", src);
    } else if (tag === "input") {
      node.setAttribute("type", "checkbox");
      node.setAttribute("disabled", "");
    }
  });
  purifier = instance;
  return instance;
}

const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    "style",
    "form",
    "button",
    "textarea",
    "select",
    "option",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "link",
    "meta",
    "base",
    "video",
    "audio",
    "source",
    "track",
    "dialog",
  ],
  FORBID_ATTR: ["style", "srcset", "formaction", "action", "ping", "background"],
  // Prefixes ids and names with "user-content-" so a document cannot shadow the app's own elements.
  SANITIZE_NAMED_PROPS: true,
};

/** GitHub-flavoured Markdown as sanitized HTML. Scripts, event handlers, frames, and styles never survive. */
export function renderMarkdown(source: string): string {
  const html = markdownParser().render(source);
  return markdownPurifier().sanitize(html, PURIFY_CONFIG) as string;
}

/** The id an anchor link such as `#install` points to after sanitizing. */
export function anchorId(fragment: string): string {
  return `user-content-${fragment}`;
}

/**
 * Resolves `relative` against the folder `fromDirectory`, both worktree-relative. A leading slash
 * means the worktree root, as on GitHub. Returns undefined when the path climbs out of the worktree.
 */
export function resolveWorktreePath(fromDirectory: string, relative: string): string | undefined {
  const absolute = relative.startsWith("/");
  const parts = absolute || !fromDirectory ? [] : fromDirectory.split("/");
  for (const part of relative.replace(/^\/+/u, "").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : undefined;
}

export type MarkdownLink =
  | { kind: "anchor"; id: string }
  | { kind: "external"; url: string }
  | { kind: "file"; path: string; line?: number }
  | { kind: "unsupported"; href: string };

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** What clicking a link in the preview of `fromPath` should do. */
export function resolveMarkdownLink(href: string, fromPath: string): MarkdownLink {
  const target = href.trim();
  if (target.startsWith("#")) return { kind: "anchor", id: anchorId(safeDecode(target.slice(1))) };
  if (/^https?:\/\//iu.test(target)) return { kind: "external", url: target };
  if (HAS_SCHEME.test(target) || target.startsWith("//") || !target) return { kind: "unsupported", href: target };
  const hash = target.indexOf("#");
  const fragment = hash === -1 ? "" : target.slice(hash + 1);
  const withoutHash = hash === -1 ? target : target.slice(0, hash);
  const query = withoutHash.indexOf("?");
  const relative = safeDecode(query === -1 ? withoutHash : withoutHash.slice(0, query));
  const path = resolveWorktreePath(dirName(fromPath), relative);
  if (!path) return { kind: "unsupported", href: target };
  const line = /^L(\d+)/u.exec(fragment)?.[1];
  return { kind: "file", path, ...(line ? { line: Number(line) } : {}) };
}

/** The headings of a Markdown document, skipping fenced code, for the outline. */
export function markdownHeadings(source: string): { level: number; text: string; line: number }[] {
  const headings: { level: number; text: string; line: number }[] = [];
  let fence: string | undefined;
  source.split(/\r\n?|\n/u).forEach((line, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      return;
    }
    if (fence) return;
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line);
    if (heading?.[1] && heading[2]) headings.push({ level: heading[1].length, text: heading[2], line: index + 1 });
  });
  return headings;
}
