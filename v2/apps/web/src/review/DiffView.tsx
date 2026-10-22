import { type KeyboardEvent, type MouseEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import {
  anchorCovers,
  anchorFor,
  type DiffLine,
  findInLines,
  formatLocation,
  isCommentable,
  type LineAnchor,
  parseDiffLines,
  patchBody,
  splitOnMatches,
} from "./diffLines.js";
import { addReviewComment, useReviewComments } from "./reviewComments.js";

type Draft = { anchor: LineAnchor; excerpt: string[]; returnTo: number };

/**
 * A file's diff whose lines can be picked for review comments: click a line, Shift+click or
 * Shift+Arrow for a range, then press C or Enter. Comments wait in the list below until sent.
 */
export function DiffView({
  worktreeId,
  diff,
}: {
  worktreeId: string;
  diff: { path: string; patch?: string | undefined; binary?: boolean | undefined; truncated?: boolean | undefined };
}) {
  const lines = useMemo(() => (diff.patch ? parseDiffLines(patchBody(diff.patch)) : []), [diff.patch]);
  const comments = useReviewComments(worktreeId);
  const fileComments = useMemo(() => comments.filter((comment) => comment.path === diff.path), [comments, diff.path]);
  const [focusIndex, setFocusIndex] = useState<number>();
  const [anchorIndex, setAnchorIndex] = useState<number>();
  const [draft, setDraft] = useState<Draft>();
  const [text, setText] = useState("");
  const lineRefs = useRef(new Map<number, HTMLDivElement>());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerId = useId();
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);
  const activeQuery = findOpen ? query : "";
  const matches = useMemo(() => findInLines(lines, activeQuery), [lines, activeQuery]);
  const currentMatch = matches.length > 0 ? matches[Math.min(matchIndex, matches.length - 1)] : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different file starts with nothing picked.
  useEffect(() => {
    setFocusIndex(undefined);
    setAnchorIndex(undefined);
    setDraft(undefined);
    setText("");
    setMatchIndex(0);
  }, [diff.path]);

  useEffect(() => {
    if (currentMatch !== undefined) lineRefs.current.get(currentMatch)?.scrollIntoView({ block: "nearest" });
  }, [currentMatch]);

  const openFind = () => {
    setFindOpen(true);
    requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
  };

  const closeFind = () => {
    setFindOpen(false);
    const target = currentMatch !== undefined && lines[currentMatch] && isCommentable(lines[currentMatch]);
    if (target) focusLine(currentMatch);
    else lineRefs.current.get(focused ?? firstCommentable ?? -1)?.focus();
  };

  const stepMatch = (direction: 1 | -1) => {
    if (matches.length === 0) return;
    setMatchIndex((current) => (Math.min(current, matches.length - 1) + direction + matches.length) % matches.length);
  };

  useEffect(() => {
    if (draft) textareaRef.current?.focus();
  }, [draft]);

  const focused =
    focusIndex !== undefined && lines[focusIndex] && isCommentable(lines[focusIndex]) ? focusIndex : undefined;
  const range = selectionRange(anchorIndex, focused);
  const firstCommentable = lines.find(isCommentable)?.index;
  const commented = useMemo(() => {
    const covered = new Set<number>();
    for (const line of lines) {
      if (fileComments.some((comment) => anchorCovers(comment.anchor, line))) covered.add(line.index);
    }
    return covered;
  }, [lines, fileComments]);

  const focusLine = (index: number) => {
    setFocusIndex(index);
    lineRefs.current.get(index)?.focus();
  };

  const openComposer = (from: number, to: number) => {
    const picked = lines.slice(from, to + 1).filter(isCommentable);
    const anchor = anchorFor(picked);
    if (!anchor) return;
    setDraft({ anchor, excerpt: picked.map((line) => line.text), returnTo: to });
    setText("");
  };

  const closeComposer = (returnTo: number | undefined) => {
    setDraft(undefined);
    setText("");
    if (returnTo !== undefined) focusLine(returnTo);
  };

  const addComment = () => {
    const body = text.trim();
    if (!draft || !body) return;
    addReviewComment({ worktreeId, path: diff.path, anchor: draft.anchor, excerpt: draft.excerpt, body });
    setAnchorIndex(undefined);
    closeComposer(draft.returnTo);
  };

  const step = (from: number | undefined, direction: 1 | -1): number | undefined => {
    let next = from === undefined ? (direction === 1 ? 0 : lines.length - 1) : from + direction;
    while (next >= 0 && next < lines.length) {
      const line = lines[next];
      if (line && isCommentable(line)) return next;
      next += direction;
    }
    return undefined;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key;
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
      const next =
        key === "Home"
          ? step(undefined, 1)
          : key === "End"
            ? step(undefined, -1)
            : step(focused, key === "ArrowDown" ? 1 : -1);
      if (next === undefined) return;
      event.preventDefault();
      if (event.shiftKey) setAnchorIndex((current) => current ?? focused ?? next);
      else setAnchorIndex(undefined);
      focusLine(next);
    } else if ((key === "c" || key === "C" || key === "Enter") && focused !== undefined) {
      event.preventDefault();
      const [from, to] = range ?? [focused, focused];
      openComposer(from, to);
    } else if (key === "Escape" && anchorIndex !== undefined) {
      setAnchorIndex(undefined);
    }
  };

  const lineFromEvent = (event: MouseEvent<HTMLElement>): DiffLine | undefined => {
    const element = (event.target as HTMLElement).closest<HTMLElement>("[data-line]");
    const line = element ? lines[Number(element.dataset.line)] : undefined;
    return line && isCommentable(line) ? line : undefined;
  };

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const line = lineFromEvent(event);
    if (!line) return;
    // Dragging across the text copies it; only a plain click picks lines.
    if (!event.shiftKey && window.getSelection()?.isCollapsed === false) return;
    const onMark = !!(event.target as HTMLElement).closest(".diff-mark");
    const inRange = range !== undefined && line.index >= range[0] && line.index <= range[1];
    const nextAnchor = event.shiftKey
      ? (anchorIndex ?? focused ?? line.index)
      : onMark && inRange
        ? anchorIndex
        : line.index;
    setAnchorIndex(nextAnchor);
    focusLine(line.index);
    if (onMark) {
      const [from, to] = selectionRange(nextAnchor, line.index) ?? [line.index, line.index];
      openComposer(from, to);
    }
  };

  const location = draft ? formatLocation(diff.path, draft.anchor) : undefined;
  const pickedCount = range
    ? lines.slice(range[0], range[1] + 1).filter(isCommentable).length
    : focused !== undefined
      ? 1
      : 0;

  return (
    <section
      className="review-diff-panel"
      aria-label={`Diff for ${diff.path}`}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
          if (lines.length === 0) return;
          event.preventDefault();
          openFind();
        }
      }}
    >
      <div className="review-diff-header">
        <Icon name="file" size={12} />
        <span className="review-diff-path">{diff.path}</span>
        <span>{diff.binary ? "Binary file" : diff.truncated ? "Output truncated" : ""}</span>
        {lines.length > 0 ? (
          pickedCount > 0 && !draft ? (
            <Button
              size="xs"
              variant="ghost"
              icon="message"
              shortcut="C"
              tooltip={pickedCount === 1 ? "Comment on this line" : `Comment on these ${pickedCount} lines`}
              onClick={() => {
                const [from, to] = range ?? [focused ?? 0, focused ?? 0];
                openComposer(from, to);
              }}
            >
              Comment
            </Button>
          ) : !draft ? (
            <span className="review-diff-hint">Pick lines to comment</span>
          ) : null
        ) : null}
        {lines.length > 0 ? (
          <IconButton
            label="Find in diff"
            icon="search"
            size="xs"
            shortcut="Mod+F"
            pressed={findOpen}
            onClick={() => (findOpen ? closeFind() : openFind())}
          />
        ) : null}
      </div>
      {findOpen ? (
        <search className="diff-find">
          <Icon name="search" size={12} />
          <input
            ref={findRef}
            className="diff-find-input"
            type="search"
            value={query}
            placeholder="Find in this diff"
            aria-label="Find in diff"
            onChange={(event) => {
              setQuery(event.target.value);
              setMatchIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                stepMatch(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeFind();
              }
            }}
          />
          <span className="diff-find-count" aria-live="polite">
            {!query
              ? ""
              : matches.length === 0
                ? "No matches"
                : `${matches.indexOf(currentMatch ?? -1) + 1} of ${matches.length}`}
          </span>
          <IconButton
            label="Previous match"
            icon="chevronUp"
            size="xs"
            shortcut="Shift+Enter"
            disabled={matches.length === 0}
            onClick={() => stepMatch(-1)}
          />
          <IconButton
            label="Next match"
            icon="chevronDown"
            size="xs"
            shortcut="Enter"
            disabled={matches.length === 0}
            onClick={() => stepMatch(1)}
          />
          <IconButton label="Close find" icon="x" size="xs" shortcut="Escape" onClick={closeFind} />
        </search>
      ) : null}
      <div className="review-diff">
        {lines.length > 0 ? (
          <div
            className="diff-lines"
            role="listbox"
            aria-label={`Lines of ${diff.path}`}
            aria-multiselectable="true"
            onKeyDown={onKeyDown}
            onClick={onClick}
            onMouseDown={(event) => {
              // Shift+click picks a range of lines instead of extending the text selection.
              if (event.shiftKey && lineFromEvent(event)) event.preventDefault();
            }}
          >
            {lines.map((line) => {
              const commentable = isCommentable(line);
              const selected =
                commentable &&
                (range
                  ? line.index >= range[0] && line.index <= range[1]
                  : line.index === focused && anchorIndex !== undefined);
              const tabStop = line.index === (focused ?? firstCommentable);
              return (
                <div
                  key={line.index}
                  ref={(element) => {
                    if (element) lineRefs.current.set(line.index, element);
                    else lineRefs.current.delete(line.index);
                  }}
                  className={`${lineClass(line, selected, commented.has(line.index))}${line.index === currentMatch ? " is-find-current" : ""}`}
                  role="option"
                  data-line={line.index}
                  tabIndex={commentable ? (tabStop ? 0 : -1) : undefined}
                  aria-selected={selected}
                  aria-disabled={commentable ? undefined : true}
                  onFocus={() => {
                    if (commentable && focusIndex !== line.index) setFocusIndex(line.index);
                  }}
                >
                  <span className="diff-num" aria-hidden="true">
                    {line.oldLine ?? ""}
                  </span>
                  <span className="diff-num" aria-hidden="true">
                    {line.newLine ?? ""}
                  </span>
                  <span className="diff-mark" aria-hidden="true">
                    {commented.has(line.index) ? (
                      <Icon name="message" size={10} />
                    ) : commentable ? (
                      <Icon name="plus" size={10} />
                    ) : null}
                  </span>
                  <span className="diff-text">
                    {activeQuery && line.text
                      ? splitOnMatches(line.text, activeQuery).map((part, partIndex) =>
                          part.match ? (
                            // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder within one render.
                            <mark className="diff-find-hit" key={partIndex}>
                              {part.text}
                            </mark>
                          ) : (
                            part.text
                          ),
                        )
                      : line.text || " "}
                  </span>
                  {commented.has(line.index) ? <span className="sr-only"> (commented)</span> : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="diff-empty">No textual diff available for this file.</p>
        )}
      </div>
      {draft && location ? (
        <form
          className="diff-composer"
          onSubmit={(event) => {
            event.preventDefault();
            addComment();
          }}
        >
          <label className="diff-composer-label" htmlFor={composerId}>
            <Icon name="message" size={12} />
            <span>
              Comment on <span className="is-mono">{location}</span>
            </span>
          </label>
          <textarea
            id={composerId}
            ref={textareaRef}
            className="textarea diff-composer-input"
            rows={3}
            value={text}
            placeholder="What should change here?"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                addComment();
              } else if (event.key === "Escape") {
                event.preventDefault();
                closeComposer(draft.returnTo);
              }
            }}
          />
          <div className="diff-composer-actions">
            <Button size="sm" variant="ghost" onClick={() => closeComposer(draft.returnTo)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" shortcut="Mod+Enter" disabled={!text.trim()}>
              Add comment
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function selectionRange(anchor: number | undefined, focus: number | undefined): [number, number] | undefined {
  if (anchor === undefined || focus === undefined) return undefined;
  return anchor <= focus ? [anchor, focus] : [focus, anchor];
}

function lineClass(line: DiffLine, selected: boolean, commented: boolean): string {
  const kind =
    line.kind === "add"
      ? " is-add"
      : line.kind === "del"
        ? " is-del"
        : line.kind === "hunk"
          ? " is-hunk"
          : line.kind === "meta"
            ? " is-meta"
            : "";
  return `diff-line${kind}${selected ? " is-selected" : ""}${commented ? " is-commented" : ""}`;
}
