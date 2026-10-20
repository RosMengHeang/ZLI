export type FileLocation = { path: string; line?: number | undefined; column?: number | undefined };
export type FileReference = { start: number; end: number; location: FileLocation };

const TRAILING_PUNCTUATION = /[.,;:!?'")\]}>]+$/u;
const LEADING_PUNCTUATION = /^['"(<[{]+/u;
const LOCATION_SUFFIX = /(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s?(\d+))?\)|#L(\d+)(?:C(\d+))?(?:-L?\d+)?)$/u;
/** Path-like tokens: optional drive letter, segments, and a file name with an extension or a known bare name. */
const CANDIDATE =
  /(?:[A-Za-z]:[\\/]|[\\/])?(?:[\w@.~+-]+[\\/])*[\w@.+-]+(?:\.[A-Za-z0-9]{1,10}|(?<=Dockerfile|Makefile|LICENSE))(?::\d+(?::\d+)?|\(\d+(?:,\s?\d+)?\)|#L\d+(?:C\d+)?(?:-L?\d+)?)?/gu;

function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

/** Maps a path an agent printed (absolute, ./-prefixed, or with backslashes) to a worktree-relative one. */
export function toWorktreePath(raw: string, root: string): string {
  const base = normalizeSlashes(root).replace(/\/+$/u, "");
  let target = normalizeSlashes(raw).replace(/^\.\//u, "");
  if (base && target.toLowerCase().startsWith(`${base.toLowerCase()}/`)) target = target.slice(base.length + 1);
  return target.replace(/^\/+/u, "");
}

function positive(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Resolves text such as `src/app.ts:42:7`, `C:\repo\src\app.ts(42,7)`, or `app.ts#L42` to a file in
 * the worktree. A bare file name resolves only when exactly one file has that name.
 */
export function parseFileReference(
  raw: string,
  root: string,
  files: ReadonlySet<string>,
  basenames?: ReadonlyMap<string, readonly string[]>,
): FileLocation | undefined {
  let text = raw.trim().replace(LEADING_PUNCTUATION, "");
  const suffix = LOCATION_SUFFIX.exec(text);
  let line: number | undefined;
  let column: number | undefined;
  if (suffix) {
    line = positive(suffix[1] ?? suffix[3] ?? suffix[5]);
    column = positive(suffix[2] ?? suffix[4] ?? suffix[6]);
    text = text.slice(0, suffix.index);
  } else {
    text = text.replace(TRAILING_PUNCTUATION, "");
  }
  if (!text) return undefined;
  const relative = toWorktreePath(text, root);
  let path: string | undefined = files.has(relative) ? relative : undefined;
  if (!path && !relative.includes("/")) {
    const matches = basenames?.get(relative) ?? [...files].filter((candidate) => baseName(candidate) === relative);
    if (matches.length === 1) path = matches[0];
  }
  if (!path) return undefined;
  return { path, ...(line ? { line } : {}), ...(line && column ? { column } : {}) };
}

/** Finds every resolvable file reference in a line of text, for terminal and chat links. */
export function findFileReferences(
  text: string,
  root: string,
  files: ReadonlySet<string>,
  basenames?: ReadonlyMap<string, readonly string[]>,
): FileReference[] {
  const references: FileReference[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const token = match[0];
    const start = match.index ?? 0;
    const trimmed = token.replace(TRAILING_PUNCTUATION, (tail) => (LOCATION_SUFFIX.test(token) ? "" : tail));
    const location = parseFileReference(trimmed, root, files, basenames);
    if (!location) continue;
    const visible = LOCATION_SUFFIX.test(token) ? token : trimmed;
    references.push({ start, end: start + visible.length, location });
  }
  return references;
}

export function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

export function dirName(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

export function indexBasenames(paths: Iterable<string>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const path of paths) {
    const name = baseName(path);
    const bucket = index.get(name);
    if (bucket) bucket.push(path);
    else index.set(name, [path]);
  }
  return index;
}
