import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "../ui/Icon.js";
import { useFileIndex } from "./FileIndex.js";
import { FileStatusMark } from "./FileTreeView.js";
import { baseName, dirName, type FileLocation } from "./filePaths.js";
import { rankFiles } from "./fuzzy.js";

const LIMIT = 50;
const LOCATION = /:(\d+)(?::(\d+))?$/u;

/** Splits `app.ts:42:7` into the name to match and the position to jump to. */
export function parseQuickOpenQuery(query: string): { text: string; line?: number; column?: number } {
  const trimmed = query.trim();
  const match = LOCATION.exec(trimmed);
  if (!match) return { text: trimmed };
  const line = Number.parseInt(match[1] ?? "", 10);
  const column = match[2] ? Number.parseInt(match[2], 10) : undefined;
  return {
    text: trimmed.slice(0, match.index),
    ...(line > 0 ? { line } : {}),
    ...(line > 0 && column && column > 0 ? { column } : {}),
  };
}

export function QuickOpen({
  worktreeId,
  branch,
  onOpen,
  onClose,
}: {
  worktreeId: string;
  branch: string;
  onOpen(location: FileLocation): void;
  onClose(): void;
}) {
  const index = useFileIndex(worktreeId, { maxAgeMs: 5_000 });
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const parsed = parseQuickOpenQuery(query);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    const entries = index?.entries ?? [];
    const present = entries.filter((entry) => entry.status !== "deleted");
    if (!parsed.text) {
      // With no query, files with uncommitted changes come first: those are what agents just touched.
      const changed = present.filter((entry) => entry.status);
      const rest = present.filter((entry) => !entry.status);
      return [...changed, ...rest].slice(0, LIMIT).map((entry) => ({ path: entry.path, indices: [] as number[] }));
    }
    return rankFiles(
      parsed.text,
      present.map((entry) => entry.path),
      LIMIT,
    );
  }, [index, parsed.text]);
  const statuses = useMemo(
    () => new Map((index?.entries ?? []).flatMap((entry) => (entry.status ? [[entry.path, entry.status]] : []))),
    [index],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the highlighted row follows the keyboard.
  useEffect(() => {
    listRef.current?.querySelector(".is-active")?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const choose = (path: string) =>
    onOpen({
      path,
      ...(parsed.line ? { line: parsed.line } : {}),
      ...(parsed.column ? { column: parsed.column } : {}),
    });

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (results.length === 0 ? 0 : (current + 1) % results.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => (results.length === 0 ? 0 : (current - 1 + results.length) % results.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const result = results[activeIndex];
      if (result) choose(result.path);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="palette-backdrop">
      <button className="dialog-scrim" type="button" aria-label="Close go to file" onClick={onClose} />
      <section
        className="command-palette quick-open"
        role="dialog"
        aria-modal="true"
        aria-label="Go to file"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette-search">
          <Icon name="file" size={15} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={`Go to file in ${branch}. Add :42 to jump to a line.`}
            aria-label="File name"
            spellCheck={false}
          />
        </div>
        <div className="palette-section" ref={listRef}>
          {!index ? (
            <p className="palette-empty">Loading files</p>
          ) : results.length === 0 ? (
            <p className="palette-empty">No matching files.</p>
          ) : (
            results.map((result, position) => (
              <button
                className={`quick-open-row${position === activeIndex ? " is-active" : ""}`}
                type="button"
                key={result.path}
                aria-label={result.path}
                onClick={() => choose(result.path)}
                onMouseMove={() => setActiveIndex(position)}
              >
                <Icon name="file" size={14} />
                <span className="quick-open-name">{highlight(result.path, result.indices, true)}</span>
                <span className="quick-open-dir">{highlight(result.path, result.indices, false)}</span>
                <FileStatusMark status={statuses.get(result.path)} />
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

/** Marks the matched characters in either the file name or its folder. */
function highlight(path: string, indices: readonly number[], name: boolean): ReactNode[] {
  const nameStart = path.length - baseName(path).length;
  const start = name ? nameStart : 0;
  const text = name ? baseName(path) : dirName(path);
  const hits = new Set(
    indices.filter((index) => index >= start && index < start + text.length).map((index) => index - start),
  );
  if (hits.size === 0) return [text];
  const nodes: ReactNode[] = [];
  let run = "";
  let marked = false;
  const flush = (key: number) => {
    if (!run) return;
    nodes.push(marked ? <mark key={key}>{run}</mark> : run);
    run = "";
  };
  for (let index = 0; index < text.length; index += 1) {
    const hit = hits.has(index);
    if (hit !== marked) {
      flush(index);
      marked = hit;
    }
    run += text[index];
  }
  flush(text.length);
  return nodes;
}
