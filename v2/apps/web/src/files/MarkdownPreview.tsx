import { highlightCode } from "@lezer/highlight";
import { previewMimeType } from "@zli-v2/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { openExternalLink } from "../review/links.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button, IconButton } from "../ui/Button.js";
import { fenceHighlighter, loadFenceParser } from "./codeEditor.js";
import { readFileData } from "./fileClient.js";
import { baseName, dirName, type FileLocation } from "./filePaths.js";
import { renderMarkdown, resolveMarkdownLink, resolveWorktreePath } from "./markdown.js";

/** Typing re-renders the preview after this pause, so long documents do not slow the editor down. */
const RENDER_DELAY_MS = 120;
/** Code blocks longer than this stay plain; highlighting them would stall the preview. */
const MAX_HIGHLIGHT_CHARS = 40_000;

export type PreviewHandle = {
  /** Scrolls so a source line, possibly fractional, sits at the top. */
  scrollToLine(line: number): void;
  /** The source line, possibly fractional, at the top of the preview. */
  topLine(): number | undefined;
};

type Block = { line: number; top: number };

function sourceBlocks(scroller: HTMLElement, content: HTMLElement): Block[] {
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const blocks: Block[] = [];
  for (const element of content.querySelectorAll<HTMLElement>("[data-source-line]")) {
    const line = Number(element.dataset.sourceLine);
    if (!Number.isFinite(line)) continue;
    const top = element.getBoundingClientRect().top - base;
    const last = blocks.at(-1);
    // Nested blocks repeat their parent's line; the outermost one marks where the line starts.
    if (last && line <= last.line) continue;
    blocks.push({ line, top });
  }
  return blocks;
}

function lineToOffset(blocks: Block[], line: number): number {
  let index = 0;
  while (index + 1 < blocks.length && (blocks[index + 1]?.line ?? Infinity) <= line) index += 1;
  const current = blocks[index];
  if (!current) return 0;
  const next = blocks[index + 1];
  if (!next || line <= current.line) return current.top;
  return current.top + ((next.top - current.top) * (line - current.line)) / (next.line - current.line);
}

function offsetToLine(blocks: Block[], offset: number): number | undefined {
  let index = 0;
  while (index + 1 < blocks.length && (blocks[index + 1]?.top ?? Infinity) <= offset) index += 1;
  const current = blocks[index];
  if (!current) return undefined;
  const next = blocks[index + 1];
  if (!next || offset <= current.top || next.top <= current.top) return current.line;
  return current.line + ((next.line - current.line) * (offset - current.top)) / (next.top - current.top);
}

const parsers = new Map<string, ReturnType<typeof loadFenceParser>>();

function fenceParser(language: string): ReturnType<typeof loadFenceParser> {
  const key = language.toLowerCase();
  let parser = parsers.get(key);
  if (!parser) {
    parser = loadFenceParser(key).catch(() => undefined);
    parsers.set(key, parser);
  }
  return parser;
}

function highlightFences(content: HTMLElement): void {
  for (const code of content.querySelectorAll<HTMLElement>("pre > code[class*='language-']")) {
    const language = /(?:^|\s)language-([\w+#.-]+)/u.exec(code.className)?.[1];
    const text = code.textContent ?? "";
    if (!language || !text || text.length > MAX_HIGHLIGHT_CHARS) continue;
    void fenceParser(language).then((parser) => {
      if (!parser || !code.isConnected || code.textContent !== text) return;
      const fragment = document.createDocumentFragment();
      highlightCode(
        text,
        parser.parse(text),
        fenceHighlighter,
        (chunk, classes) => {
          if (!classes) {
            fragment.append(chunk);
            return;
          }
          const span = document.createElement("span");
          span.className = classes;
          span.textContent = chunk;
          fragment.append(span);
        },
        () => fragment.append("\n"),
      );
      code.replaceChildren(fragment);
    });
  }
}

/** Swaps an image that will not load for a line of text saying why. */
function replaceImage(image: HTMLImageElement, reason: string): void {
  const note = document.createElement("span");
  note.className = "file-md-image-note";
  const alt = image.getAttribute("alt")?.trim();
  note.textContent = alt ? `${alt}: ${reason}` : reason;
  image.replaceWith(note);
}

function stripQueryAndHash(value: string): string {
  return value.replace(/[?#].*$/u, "");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function MarkdownPreview({
  worktreeId,
  path,
  source,
  initialLine,
  reveal,
  onOpenFile,
  onEditLine,
  onReady,
  onUserScroll,
}: {
  worktreeId: string;
  path: string;
  source: string;
  /** Where to start scrolled to, as a source line. */
  initialLine?: number | undefined;
  reveal?: { line: number; nonce: number } | undefined;
  onOpenFile(location: FileLocation): void;
  /** Double-clicking a block asks to edit its source line. */
  onEditLine(line: number): void;
  onReady?(handle: PreviewHandle | undefined): void;
  onUserScroll?(): void;
}) {
  const { bridge, dispatch } = useRuntime();
  const [rendered, setRendered] = useState(source);
  const [remoteCount, setRemoteCount] = useState(0);
  const [allowRemote, setAllowRemote] = useState(false);
  const [notice, setNotice] = useState<string>();
  const scrollerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const images = useRef(new Map<string, Promise<string>>());
  const programmaticScroll = useRef(false);

  useEffect(() => {
    if (source === rendered) return;
    const timer = setTimeout(() => setRendered(source), RENDER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [source, rendered]);

  // React replaces the markup whenever this object changes identity, which would drop loaded images.
  const markup = useMemo(() => ({ __html: renderMarkdown(rendered) }), [rendered]);

  const loadImage = useCallback(
    (target: string) => {
      let pending = images.current.get(target);
      if (!pending) {
        pending = readFileData(dispatch, worktreeId, target).then(
          (data) => `data:${data.mimeType};base64,${data.dataBase64}`,
        );
        images.current.set(target, pending);
        pending.catch(() => images.current.delete(target));
      }
      return pending;
    },
    [dispatch, worktreeId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the markup is replaced whenever html changes.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    highlightFences(content);
    for (const image of content.querySelectorAll<HTMLImageElement>("img[data-zli-src]")) {
      const raw = image.dataset.zliSrc ?? "";
      const target = resolveWorktreePath(dirName(path), safeDecode(stripQueryAndHash(raw)));
      if (!target) {
        replaceImage(image, "the image is outside this worktree");
        continue;
      }
      if (!previewMimeType(target)) {
        replaceImage(image, `${baseName(target)} is not an image ZLI can show`);
        continue;
      }
      loadImage(target).then(
        (url) => {
          if (image.isConnected) image.src = url;
        },
        (cause: unknown) => {
          if (image.isConnected) {
            replaceImage(image, cause instanceof Error ? cause.message : `${target} could not be loaded`);
          }
        },
      );
    }
    for (const image of content.querySelectorAll<HTMLImageElement>("img[data-zli-blocked]")) {
      replaceImage(image, "only images in this worktree or on the web are shown");
    }
    const remote = content.querySelectorAll<HTMLImageElement>("img[data-zli-remote]");
    if (allowRemote) for (const image of remote) image.src = image.dataset.zliRemote ?? "";
    setRemoteCount(remote.length);
  }, [markup, allowRemote, loadImage]);

  const handle = useMemo<PreviewHandle>(
    () => ({
      scrollToLine(line) {
        const scroller = scrollerRef.current;
        const content = contentRef.current;
        if (!scroller || !content) return;
        const top = Math.max(0, Math.round(lineToOffset(sourceBlocks(scroller, content), line)));
        const before = scroller.scrollTop;
        if (Math.abs(before - top) < 1) return;
        scroller.scrollTop = top;
        // A scroll that changes nothing fires no event, so only flag one that moved.
        programmaticScroll.current = scroller.scrollTop !== before;
      },
      topLine() {
        const scroller = scrollerRef.current;
        const content = contentRef.current;
        if (!scroller || !content) return undefined;
        return offsetToLine(sourceBlocks(scroller, content), scroller.scrollTop);
      },
    }),
    [],
  );

  useEffect(() => {
    onReady?.(handle);
    return () => onReady?.(undefined);
  }, [handle, onReady]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only the first render picks the starting point.
  useLayoutEffect(() => {
    if (initialLine && initialLine > 1) handle.scrollToLine(initialLine);
  }, [handle]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new reveal request should scroll.
  useLayoutEffect(() => {
    if (reveal) handle.scrollToLine(reveal.line);
  }, [reveal?.nonce]);

  const latest = useRef({ path, bridge, onOpenFile, onEditLine });
  latest.current = { path, bridge, onOpenFile, onEditLine };

  // Links and double-clicks are routed from the rendered markup, so the listeners sit on its container.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor || !content.contains(anchor)) return;
      event.preventDefault();
      const href = anchor.getAttribute("href") ?? "";
      const current = latest.current;
      const link = resolveMarkdownLink(href, current.path);
      if (link.kind === "anchor") {
        const target = [...content.querySelectorAll<HTMLElement>("[id]")].find((element) => element.id === link.id);
        if (target) target.scrollIntoView({ block: "start" });
        else setNotice(`This document has no heading or note called ${href}.`);
      } else if (link.kind === "external") {
        void openExternalLink(current.bridge, link.url).then(setNotice);
      } else if (link.kind === "file") {
        current.onOpenFile(link);
      } else {
        setNotice(`ZLI opens web links and files in this worktree. It cannot open ${href}.`);
      }
    };
    const onDoubleClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.("a[href]")) return;
      const block = target?.closest?.<HTMLElement>("[data-source-line]");
      const line = Number(block?.dataset.sourceLine);
      if (Number.isFinite(line) && line > 0) latest.current.onEditLine(line);
    };
    content.addEventListener("click", onClick);
    content.addEventListener("dblclick", onDoubleClick);
    return () => {
      content.removeEventListener("click", onClick);
      content.removeEventListener("dblclick", onDoubleClick);
    };
  }, []);

  return (
    <div className="file-md-pane">
      {notice ? (
        <div className="file-md-notice" role="status">
          <span>{notice}</span>
          <IconButton icon="x" size="sm" label="Dismiss" onClick={() => setNotice(undefined)} />
        </div>
      ) : null}
      {remoteCount > 0 && !allowRemote ? (
        <div className="file-md-notice">
          <span>
            {remoteCount === 1
              ? "1 web image is not loaded. Loading it tells its server this file was opened."
              : `${remoteCount} web images are not loaded. Loading them tells their servers this file was opened.`}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setAllowRemote(true)}>
            Load web images
          </Button>
        </div>
      ) : null}
      <section
        className="file-md-scroll"
        ref={scrollerRef}
        aria-label={`Preview of ${baseName(path)}`}
        onScroll={() => {
          if (programmaticScroll.current) {
            programmaticScroll.current = false;
            return;
          }
          onUserScroll?.();
        }}
      >
        <div
          className="file-md"
          ref={contentRef}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown sanitizes with DOMPurify.
          dangerouslySetInnerHTML={markup}
        />
      </section>
    </div>
  );
}
