import { cp, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { GitProcess } from "../git/GitProcess.js";

export type WorktreeIncludeSkipReason =
  | "missing"
  | "glob"
  | "negation"
  | "traversal"
  | "tracked"
  | "not_ignored"
  | "target_exists";

export type WorktreeIncludeReport = {
  copied: string[];
  skipped: Array<{ entry: string; reason: WorktreeIncludeSkipReason }>;
};

export async function applyWorktreeInclude(options: {
  repoPath: string;
  worktreePath: string;
  git: Pick<GitProcess, "run">;
  configPath?: string;
}): Promise<WorktreeIncludeReport> {
  const report: WorktreeIncludeReport = { copied: [], skipped: [] };
  const configPath = options.configPath ?? resolve(options.repoPath, ".worktreeinclude");
  let config: string;
  try {
    config = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return report;
    throw error;
  }

  for (const line of config.split(/\r?\n/u)) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#")) continue;
    const skip = validateEntry(entry);
    if (skip) {
      report.skipped.push({ entry, reason: skip });
      continue;
    }
    const sourcePath = resolve(options.repoPath, entry);
    const targetPath = resolve(options.worktreePath, entry);
    if (!isWithin(resolve(options.repoPath), sourcePath) || !isWithin(resolve(options.worktreePath), targetPath)) {
      report.skipped.push({ entry, reason: "traversal" });
      continue;
    }
    if (!(await exists(sourcePath))) {
      report.skipped.push({ entry, reason: "missing" });
      continue;
    }
    if (await isTracked(options.git, options.repoPath, entry)) {
      report.skipped.push({ entry, reason: "tracked" });
      continue;
    }
    if (!(await isIgnored(options.git, options.repoPath, entry))) {
      report.skipped.push({ entry, reason: "not_ignored" });
      continue;
    }
    if (await exists(targetPath)) {
      report.skipped.push({ entry, reason: "target_exists" });
      continue;
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true, errorOnExist: true, force: false });
    report.copied.push(entry);
  }
  return report;
}

function validateEntry(entry: string): WorktreeIncludeSkipReason | undefined {
  if (entry.startsWith("!")) return "negation";
  if (/[?*\[]/u.test(entry)) return "glob";
  if (isAbsolute(entry) || entry.split(/[\\/]/u).some((part) => part === "..")) return "traversal";
  return undefined;
}

async function isTracked(git: Pick<GitProcess, "run">, repoPath: string, entry: string): Promise<boolean> {
  try {
    await git.run(["ls-files", "--error-unmatch", "--", entry], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

async function isIgnored(git: Pick<GitProcess, "run">, repoPath: string, entry: string): Promise<boolean> {
  try {
    await git.run(["check-ignore", "--quiet", "--", entry], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
