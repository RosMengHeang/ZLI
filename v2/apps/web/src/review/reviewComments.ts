import { useMemo, useSyncExternalStore } from "react";

import { formatLocation, type LineAnchor } from "./diffLines.js";

export type ReviewComment = {
  id: string;
  worktreeId: string;
  path: string;
  anchor: LineAnchor;
  /** The selected diff lines, with their +, - or space prefix. */
  excerpt: string[];
  body: string;
};

const MAX_EXCERPT_LINES = 12;

// Comments wait in memory until they are sent, so closing the panel or switching files keeps them.
let comments: readonly ReviewComment[] = [];
const listeners = new Set<() => void>();

function update(next: readonly ReviewComment[]): void {
  comments = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useReviewComments(worktreeId: string | undefined): readonly ReviewComment[] {
  const all = useSyncExternalStore(subscribe, () => comments);
  return useMemo(() => all.filter((comment) => comment.worktreeId === worktreeId), [all, worktreeId]);
}

export function addReviewComment(comment: Omit<ReviewComment, "id">): ReviewComment {
  const created = { ...comment, id: crypto.randomUUID() };
  update([...comments, created]);
  return created;
}

export function editReviewComment(id: string, body: string): void {
  update(comments.map((comment) => (comment.id === id ? { ...comment, body } : comment)));
}

export function removeReviewComments(ids: readonly string[]): void {
  update(comments.filter((comment) => !ids.includes(comment.id)));
}

export function commentLocation(comment: Pick<ReviewComment, "path" | "anchor">): string {
  return formatLocation(comment.path, comment.anchor);
}

/** The message an agent receives: each location, the diff lines it points at, then the comment. */
export function formatCommentsMessage(list: readonly ReviewComment[], branch: string | undefined): string {
  const intro = `Please address ${list.length === 1 ? "this review comment" : "these review comments"} on the changes${branch ? ` in ${branch}` : ""}.`;
  const sections = list.map((comment) => {
    const shown = comment.excerpt.slice(0, MAX_EXCERPT_LINES);
    const hidden = comment.excerpt.length - shown.length;
    const fence = fenceFor(shown);
    return [
      commentLocation(comment),
      `${fence}diff`,
      ...shown,
      ...(hidden > 0 ? [`… ${hidden} more line${hidden === 1 ? "" : "s"}`] : []),
      fence,
      comment.body.trim(),
    ].join("\n");
  });
  return [intro, ...sections].join("\n\n");
}

/** A fence longer than any run of backticks in the excerpt, so the excerpt cannot close it early. */
function fenceFor(lines: readonly string[]): string {
  const longest = Math.max(
    0,
    ...lines.map((line) => Math.max(0, ...[...line.matchAll(/`+/gu)].map((m) => m[0].length))),
  );
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Terminal input for a message, without a final Enter so the person can read it before sending.
 * Control characters from the diff are dropped so file contents cannot inject terminal sequences or
 * end the paste early. With bracketed paste the program receives line breaks as part of one paste;
 * without it a line break would submit, so the message is sent as one line.
 */
export function terminalPaste(message: string, bracketedPaste: boolean): string {
  const clean = message
    .replace(/\r\n?/gu, "\n")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
  if (bracketedPaste) return `\x1b[200~${clean.replace(/\n/gu, "\r")}\x1b[201~`;
  return clean.replace(/\s*\n\s*/gu, " ").trim();
}
