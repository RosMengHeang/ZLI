export type DiffLineKind = "add" | "del" | "context" | "hunk" | "meta";

export type DiffLine = {
  index: number;
  text: string;
  kind: DiffLineKind;
  /** Line number in the version before the change, for removed and unchanged lines. */
  oldLine?: number;
  /** Line number in the version after the change, for added and unchanged lines. */
  newLine?: number;
};

/** Where a comment points: lines of the changed file, or of the old version when only removed lines are picked. */
export type LineAnchor = { side: "new" | "old"; start: number; end: number };

/** The lines of a patch from its first hunk on; the path header above the diff already names the file. */
export function patchBody(patch: string): string[] {
  const lines = patch.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  return firstHunk > 0 ? lines.slice(firstHunk) : lines;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;

/**
 * Numbers the lines of a patch. Hunk headers give the starting line and line count on each side,
 * so a hunk ends exactly when both counts run out and anything after it is metadata.
 */
export function parseDiffLines(lines: readonly string[]): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  return lines.map((text, index): DiffLine => {
    const hunk = HUNK_HEADER.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      return { index, text, kind: "hunk" };
    }
    if (oldLeft <= 0 && newLeft <= 0) return { index, text, kind: "meta" };
    if (text.startsWith("+") && newLeft > 0) {
      newLeft -= 1;
      return { index, text, kind: "add", newLine: newLine++ };
    }
    if (text.startsWith("-") && oldLeft > 0) {
      oldLeft -= 1;
      return { index, text, kind: "del", oldLine: oldLine++ };
    }
    if ((text.startsWith(" ") || text === "") && oldLeft > 0 && newLeft > 0) {
      oldLeft -= 1;
      newLeft -= 1;
      return { index, text, kind: "context", oldLine: oldLine++, newLine: newLine++ };
    }
    return { index, text, kind: "meta" };
  });
}

/**
 * Each hunk as Git printed it, from its `@@` line up to the next one, keyed by the index of its `@@` line. The
 * server compares this text with the current diff before it stages or discards the hunk.
 */
export function hunkTexts(lines: readonly DiffLine[]): Map<number, { hunkIndex: number; text: string }> {
  const hunks: Array<{ start: number; lines: string[] }> = [];
  for (const line of lines) {
    if (line.kind === "hunk") hunks.push({ start: line.index, lines: [line.text] });
    else hunks.at(-1)?.lines.push(line.text);
  }
  return new Map(
    hunks.map((hunk, hunkIndex) => [hunk.start, { hunkIndex, text: hunk.lines.join("\n").replace(/\n+$/u, "") }]),
  );
}

export function isCommentable(line: DiffLine): boolean {
  return line.kind === "add" || line.kind === "del" || line.kind === "context";
}

/** The new-file lines a selection covers, or its old-file lines when it holds only removed lines. */
export function anchorFor(lines: readonly DiffLine[]): LineAnchor | undefined {
  const newLines = lines.flatMap((line) => (line.newLine === undefined ? [] : [line.newLine]));
  if (newLines.length > 0) return { side: "new", start: Math.min(...newLines), end: Math.max(...newLines) };
  const oldLines = lines.flatMap((line) => (line.oldLine === undefined ? [] : [line.oldLine]));
  if (oldLines.length > 0) return { side: "old", start: Math.min(...oldLines), end: Math.max(...oldLines) };
  return undefined;
}

export function anchorCovers(anchor: LineAnchor, line: DiffLine): boolean {
  if (anchor.side === "new") {
    if (line.newLine !== undefined) return line.newLine >= anchor.start && line.newLine <= anchor.end;
    return false;
  }
  return (
    line.kind === "del" && line.oldLine !== undefined && line.oldLine >= anchor.start && line.oldLine <= anchor.end
  );
}

/** `path:12` or `path:12-14`; removed lines are numbered in the version before the change. */
export function formatLocation(path: string, anchor: LineAnchor): string {
  const range = anchor.start === anchor.end ? `${anchor.start}` : `${anchor.start}-${anchor.end}`;
  return anchor.side === "new" ? `${path}:${range}` : `${path}:${range} (before this change)`;
}

/** Indexes of the lines that contain `query`, ignoring case. An empty query matches nothing. */
export function findInLines(lines: readonly DiffLine[], query: string): number[] {
  const needle = query.toLowerCase();
  if (!needle) return [];
  return lines.filter((line) => line.text.toLowerCase().includes(needle)).map((line) => line.index);
}

/** `text` cut into plain and matching runs, so every occurrence of `query` can be highlighted. */
export function splitOnMatches(text: string, query: string): Array<{ text: string; match: boolean }> {
  const needle = query.toLowerCase();
  if (!needle) return [{ text, match: false }];
  const haystack = text.toLowerCase();
  const parts: Array<{ text: string; match: boolean }> = [];
  let from = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts;
}
