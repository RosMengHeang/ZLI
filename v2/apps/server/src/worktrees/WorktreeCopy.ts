import { cp, glob, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { repoPatternProblem } from "@zli-v2/contracts";

export type WorktreeCopyReport = {
  copied: string[];
  skipped: Array<{ entry: string; reason: string }>;
};

/** Upper bound on copied entries, so a broad glob cannot fill the disk or stall worktree creation. */
export const MAX_COPY_ENTRIES = 500;

/** Globs never walk into these; a pattern can still name them literally. */
const GLOB_EXCLUDE = [".git", ".git/**", "**/node_modules", "**/node_modules/**"];

export function isGlobPattern(pattern: string): boolean {
  return /[*?[\]{}]/u.test(pattern);
}

/**
 * Copies files and folders named by zli.json `worktree.copy` from the main checkout into a new worktree.
 * Every match must resolve inside the repository, and every target inside the worktree, after symlinks.
 * Symbolic links are never copied and existing files in the worktree are never overwritten.
 */
export async function copyIntoWorktree(options: {
  repoPath: string;
  worktreePath: string;
  patterns: readonly string[];
}): Promise<WorktreeCopyReport> {
  const report: WorktreeCopyReport = { copied: [], skipped: [] };
  if (options.patterns.length === 0) return report;
  const repoRoot = await realpath(options.repoPath);
  const treeRoot = await realpath(options.worktreePath);
  const seen = new Set<string>();
  for (const pattern of options.patterns) {
    const problem = repoPatternProblem(pattern);
    if (problem) {
      report.skipped.push({ entry: pattern, reason: `Pattern ${problem}.` });
      continue;
    }
    const matches = isGlobPattern(pattern) ? await globMatches(repoRoot, pattern) : [pattern];
    if (matches.length === 0) report.skipped.push({ entry: pattern, reason: "Nothing matches it." });
    for (const match of matches) {
      if (seen.has(match)) continue;
      seen.add(match);
      if (report.copied.length >= MAX_COPY_ENTRIES) {
        report.skipped.push({ entry: pattern, reason: `Stopped after ${MAX_COPY_ENTRIES} entries.` });
        return report;
      }
      const reason = await copyEntry(repoRoot, treeRoot, match);
      if (reason) report.skipped.push({ entry: match, reason });
      else report.copied.push(match);
    }
  }
  return report;
}

async function globMatches(root: string, pattern: string): Promise<string[]> {
  const matches: string[] = [];
  for await (const entry of glob(pattern, { cwd: root, exclude: GLOB_EXCLUDE })) {
    const normalized = entry.split(sep).join("/");
    if (!normalized || normalized === ".") continue;
    matches.push(normalized);
    // A little past the cap so the report can say the copy stopped.
    if (matches.length > MAX_COPY_ENTRIES) break;
  }
  return matches.sort();
}

/** Copies one entry and returns why it was skipped, or undefined when it was copied. */
async function copyEntry(repoRoot: string, treeRoot: string, entry: string): Promise<string | undefined> {
  const source = resolve(repoRoot, entry);
  const target = resolve(treeRoot, entry);
  if (!isWithin(repoRoot, source) || !isWithin(treeRoot, target)) return "It is outside the repository.";
  const stats = await lstatOrUndefined(source);
  if (!stats) return "It does not exist in the main checkout.";
  if (stats.isSymbolicLink()) return "Symbolic links are not copied.";
  if (!stats.isFile() && !stats.isDirectory()) return "Only files and folders are copied.";
  // A symlinked parent folder could point anywhere; the real location is what gets read.
  if (!isWithin(repoRoot, await realpath(source))) return "It resolves outside the repository.";
  if (await lstatOrUndefined(target)) return "It already exists in the worktree.";
  const ancestor = await nearestExistingAncestor(target, treeRoot);
  if (!isWithin(treeRoot, ancestor, true)) return "Its folder in the worktree resolves outside the worktree.";
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async (path) => !(await lstat(path)).isSymbolicLink(),
  });
  return undefined;
}

async function nearestExistingAncestor(path: string, stopAt: string): Promise<string> {
  let current = dirname(path);
  while (current !== stopAt && isWithin(stopAt, current)) {
    if (await lstatOrUndefined(current)) return realpath(current);
    current = dirname(current);
  }
  return stopAt;
}

function isWithin(root: string, target: string, allowRoot = false): boolean {
  const child = relative(root, target);
  if (child === "") return allowRoot;
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
