import type { FileSearchMatch, FileSearchResult } from "@zli-v2/contracts";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Icon } from "../ui/Icon.js";
import { searchFiles } from "./fileClient.js";
import { baseName, dirName, type FileLocation } from "./filePaths.js";

export type SearchSettings = { query: string; caseSensitive: boolean; regex: boolean };

const SEARCH_DELAY_MS = 300;

export function FileSearchView({
  worktreeId,
  settings,
  focusKey,
  onSettingsChange,
  onOpen,
}: {
  worktreeId: string;
  settings: SearchSettings;
  /** Changes when the query box should take focus. */
  focusKey: number;
  onSettingsChange(settings: SearchSettings): void;
  onOpen(location: FileLocation): void;
}) {
  const { dispatch } = useRuntime();
  const inputRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<FileSearchResult & { key: string }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const requestRef = useRef(0);
  const query = settings.query.trim();
  const key = `${worktreeId}\n${settings.caseSensitive}\n${settings.regex}\n${query}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a focus request should move focus.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusKey]);

  useEffect(() => {
    if (query.length === 0) {
      setResult(undefined);
      setError(undefined);
      return;
    }
    if (result?.key === key) return;
    const request = ++requestRef.current;
    const timer = setTimeout(() => {
      setBusy(true);
      searchFiles(dispatch, worktreeId, {
        query,
        caseSensitive: settings.caseSensitive,
        regex: settings.regex,
      })
        .then((next) => {
          if (request !== requestRef.current) return;
          setResult({ ...next, key });
          setError(undefined);
          setCollapsed(new Set());
        })
        .catch((cause: unknown) => {
          if (request !== requestRef.current) return;
          setResult(undefined);
          setError(cause instanceof Error ? cause.message : "Search failed.");
        })
        .finally(() => {
          if (request === requestRef.current) setBusy(false);
        });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [dispatch, key, query, result?.key, settings.caseSensitive, settings.regex, worktreeId]);

  const groups = useMemo(() => {
    const byPath = new Map<string, FileSearchMatch[]>();
    for (const match of result?.matches ?? []) {
      const bucket = byPath.get(match.path);
      if (bucket) bucket.push(match);
      else byPath.set(match.path, [match]);
    }
    return [...byPath.entries()];
  }, [result]);
  const highlighter = useMemo(() => makeHighlighter(settings), [settings]);
  const total = result?.matches.length ?? 0;

  return (
    <div className="file-search">
      <form
        className="file-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          setResult(undefined);
        }}
      >
        <input
          ref={inputRef}
          value={settings.query}
          onChange={(event) => onSettingsChange({ ...settings, query: event.target.value })}
          placeholder="Search in files"
          aria-label="Search in files"
          spellCheck={false}
        />
        <button
          className={`search-option${settings.caseSensitive ? " is-active" : ""}`}
          type="button"
          aria-pressed={settings.caseSensitive}
          title="Match case"
          onClick={() => onSettingsChange({ ...settings, caseSensitive: !settings.caseSensitive })}
        >
          Aa
        </button>
        <button
          className={`search-option${settings.regex ? " is-active" : ""}`}
          type="button"
          aria-pressed={settings.regex}
          title="Use regular expression"
          onClick={() => onSettingsChange({ ...settings, regex: !settings.regex })}
        >
          .*
        </button>
      </form>
      <p className="file-search-summary" role="status">
        {error
          ? null
          : query.length === 0
            ? "Searches tracked and untracked files. Ignored files are skipped."
            : busy && result?.key !== key
              ? "Searching"
              : result
                ? total === 0
                  ? "No results."
                  : `${total.toLocaleString()} result${total === 1 ? "" : "s"} in ${groups.length.toLocaleString()} file${groups.length === 1 ? "" : "s"}${result.truncated ? ". Showing the first ones; narrow the search to see the rest." : ""}`
                : null}
      </p>
      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="file-search-results">
        {groups.map(([path, matches]) => {
          const open = !collapsed.has(path);
          return (
            <section className="search-group" key={path}>
              <button
                className="search-group-header"
                type="button"
                aria-expanded={open}
                title={path}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
              >
                <Icon name="chevronRight" size={12} className={`file-row-chevron${open ? " is-open" : ""}`} />
                <span className="search-group-name">{baseName(path)}</span>
                <span className="search-group-dir">{dirName(path)}</span>
                <span className="search-group-count">{matches.length}</span>
              </button>
              {open
                ? matches.map((match) => (
                    <button
                      className="search-match"
                      type="button"
                      key={`${match.line}:${match.column}`}
                      title={`${path}:${match.line}:${match.column}`}
                      onClick={() => onOpen({ path, line: match.line, column: match.column })}
                    >
                      <span className="search-match-line">{match.line}</span>
                      <span className="search-match-preview">{highlighter(match.preview)}</span>
                    </button>
                  ))
                : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function makeHighlighter(settings: SearchSettings): (text: string) => ReactNode[] {
  const query = settings.query.trim();
  let pattern: RegExp | undefined;
  try {
    const source = settings.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    pattern = query ? new RegExp(source, settings.caseSensitive ? "gu" : "giu") : undefined;
  } catch {
    // Git's extended regular expressions accept patterns JavaScript rejects; those previews stay plain.
    pattern = undefined;
  }
  return (text) => {
    if (!pattern) return [text];
    const nodes: ReactNode[] = [];
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0;
      if (match[0].length === 0) continue;
      if (start > last) nodes.push(text.slice(last, start));
      nodes.push(<mark key={start}>{match[0]}</mark>);
      last = start + match[0].length;
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
  };
}
