import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ReviewProjection,
  WorktreeId,
  type ReviewFileProjection,
  type ReviewDiffProjection,
  type ReviewProjection as ReviewProjectionValue,
} from "@zli-v2/contracts";

import { GitProcess } from "../git/GitProcess.js";

export type ReviewServiceInput = {
  worktreeId: WorktreeId;
  worktreePath: string;
  repositoryPath: string;
  branch: string;
  baseRef: string;
};

export class ReviewService {
  constructor(private readonly git: Pick<GitProcess, "run">) {}

  async refresh(input: ReviewServiceInput): Promise<ReviewProjectionValue> {
    assertRef(input.baseRef);
    const [branchResult, statusResult, diffResult] = await Promise.all([
      this.git.run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: input.worktreePath }),
      this.git.run(["status", "--porcelain=v1"], { cwd: input.worktreePath }),
      this.git.run(["diff", "--numstat", "--find-renames", `${input.baseRef}...HEAD`], { cwd: input.worktreePath }),
    ]);
    const statuses = parseStatus(statusResult.stdout);
    const stats = parseNumstat(diffResult.stdout);
    const files = mergeFiles(statuses, stats);
    const conflictFiles = statuses.filter((status) => isConflict(status.xy)).map((status) => status.path);
    return ReviewProjection.parse({
      worktreeId: input.worktreeId,
      baseRef: input.baseRef,
      branch: branchResult.stdout.trim() || input.branch,
      state: conflictFiles.length > 0 ? "conflicted" : files.length > 0 ? "changes" : "clean",
      files,
      conflictFiles,
      updatedAt: new Date().toISOString(),
    });
  }

  async commit(input: ReviewServiceInput & { message: string }): Promise<ReviewProjectionValue> {
    const message = input.message.trim();
    if (!message || message.includes("\0")) throw new Error("Commit message must contain visible text.");
    await this.git.run(["add", "--all", "--", "."], { cwd: input.worktreePath });
    await this.git.run(["commit", "-m", message], { cwd: input.worktreePath });
    return this.refresh(input);
  }

  async diff(input: ReviewServiceInput & { path: string }): Promise<ReviewProjectionValue> {
    assertRelativePath(input.path);
    const review = await this.refresh(input);
    const file = review.files.find((candidate) => candidate.path === input.path);
    if (!file) throw new Error(`The file is not part of the current review: ${input.path}`);

    let patch = "";
    if (file.kind === "untracked") {
      patch = await readUntrackedPatch(input.worktreePath, file);
    } else {
      const workingTreeDiff = await this.git.run(["diff", "--no-ext-diff", "--unified=3", "HEAD", "--", file.path], {
        cwd: input.worktreePath,
      });
      if (workingTreeDiff.stdout) {
        patch = workingTreeDiff.stdout;
      } else {
        const committedDiff = await this.git.run(
          ["diff", "--no-ext-diff", "--unified=3", `${input.baseRef}...HEAD`, "--", file.path],
          { cwd: input.worktreePath },
        );
        patch = committedDiff.stdout;
      }
    }
    const bounded = boundPatch(patch);
    const diff: ReviewDiffProjection = {
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      binary: file.binary,
      patch: bounded.patch,
      truncated: bounded.truncated,
      generatedAt: new Date().toISOString(),
    };
    return ReviewProjection.parse({ ...review, diff });
  }

  async merge(input: ReviewServiceInput & { targetRef: string }): Promise<ReviewProjectionValue> {
    assertRef(input.branch);
    assertRef(input.targetRef);
    const targetStatus = await this.git.run(["status", "--porcelain=v1"], { cwd: input.repositoryPath });
    if (targetStatus.stdout.trim().length > 0) throw new Error("Target repository has uncommitted changes.");
    const targetBranch = await this.git.run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: input.repositoryPath });
    if (targetBranch.stdout.trim() !== input.targetRef) {
      throw new Error(`Target repository must be checked out at ${input.targetRef}.`);
    }
    try {
      await this.git.run(["merge", "--no-edit", "--no-ff", "--", input.branch], { cwd: input.repositoryPath });
    } catch (error) {
      const conflict = await this.targetConflictProjection(input);
      if (!conflict) throw error;
      return conflict;
    }
    return this.refresh(input);
  }

  async abortMerge(input: ReviewServiceInput): Promise<ReviewProjectionValue> {
    await this.git.run(["merge", "--abort"], { cwd: input.repositoryPath });
    return this.refresh(input);
  }

  private async targetConflictProjection(input: ReviewServiceInput): Promise<ReviewProjectionValue | undefined> {
    const result = await this.git.run(["status", "--porcelain=v1"], { cwd: input.repositoryPath });
    const statuses = parseStatus(result.stdout);
    const conflictFiles = statuses.filter((status) => isConflict(status.xy)).map((status) => status.path);
    if (conflictFiles.length === 0) return undefined;
    return ReviewProjection.parse({
      worktreeId: input.worktreeId,
      baseRef: input.baseRef,
      branch: input.branch,
      state: "conflicted",
      files: mergeFiles(statuses, []),
      conflictFiles,
      updatedAt: new Date().toISOString(),
    });
  }
}

type StatusEntry = { xy: string; path: string; oldPath?: string };
type NumstatEntry = { path: string; oldPath?: string; additions: number; deletions: number; binary: boolean };

function parseStatus(stdout: string): StatusEntry[] {
  return stdout
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line) => {
      if (line.length < 4) return [];
      const xy = line.slice(0, 2);
      const rename = parseRenamePath(line.slice(3).trim());
      const entry: StatusEntry = { xy, path: rename.path };
      if (rename.oldPath) entry.oldPath = rename.oldPath;
      return [entry];
    });
}

function parseNumstat(stdout: string): NumstatEntry[] {
  return stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      const match = /^(\d+|-)\s+(\d+|-)\s+(.+)$/u.exec(line);
      if (!match) return [];
      const additions = match[1] === "-" ? 0 : Number(match[1]);
      const deletions = match[2] === "-" ? 0 : Number(match[2]);
      const rename = parseRenamePath(match[3]!);
      const entry: NumstatEntry = {
        path: rename.path,
        additions,
        deletions,
        binary: match[1] === "-" || match[2] === "-",
      };
      if (rename.oldPath) entry.oldPath = rename.oldPath;
      return [entry];
    });
}

function mergeFiles(statuses: StatusEntry[], stats: NumstatEntry[]): ReviewFileProjection[] {
  const byPath = new Map(stats.map((entry) => [entry.path, entry]));
  const paths = new Set([...statuses.map((entry) => entry.path), ...stats.map((entry) => entry.path)]);
  return [...paths].sort().map((path) => {
    const status = statuses.find((entry) => entry.path === path);
    const stat = byPath.get(path);
    const xy = status?.xy ?? "  ";
    const kind =
      stat?.oldPath || status?.oldPath || xy.includes("R") || xy.includes("C")
        ? "renamed"
        : xy.includes("?")
          ? "untracked"
          : xy.includes("D")
            ? "deleted"
            : xy.includes("A")
              ? "added"
              : "modified";
    const file: ReviewFileProjection = {
      path,
      kind,
      staged: xy[0] !== undefined && "AMDRCT".includes(xy[0]),
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      binary: stat?.binary ?? false,
    };
    const oldPath = stat?.oldPath ?? status?.oldPath;
    if (oldPath) file.oldPath = oldPath;
    return file;
  });
}

function parseRenamePath(value: string): { path: string; oldPath?: string } {
  const separator = " => ";
  const index = value.lastIndexOf(separator);
  if (index <= 0 || index + separator.length >= value.length) return { path: value };
  return { oldPath: value.slice(0, index), path: value.slice(index + separator.length) };
}

function isConflict(xy: string): boolean {
  return xy.includes("U") || xy === "AA" || xy === "DD";
}

function assertRef(value: string): void {
  if (
    !value ||
    value.startsWith("-") ||
    value.includes("\0") ||
    value.includes("\\") ||
    /(^|\/)\.\.?($|\/)/u.test(value) ||
    /[~^:?*\[]/u.test(value) ||
    value.endsWith(".lock") ||
    value.endsWith(".")
  ) {
    throw new Error(`Unsafe Git ref: ${value}`);
  }
}

function assertRelativePath(value: string): void {
  if (
    !value ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.split(/[\\/]/u).some((part) => part === "..")
  ) {
    throw new Error(`Unsafe review path: ${value}`);
  }
}

function boundPatch(value: string): { patch: string; truncated: boolean } {
  const maxChars = 200_000;
  return value.length <= maxChars
    ? { patch: value, truncated: false }
    : { patch: value.slice(0, maxChars), truncated: true };
}

async function readUntrackedPatch(worktreePath: string, file: ReviewFileProjection): Promise<string> {
  if (file.binary) return `Untracked binary file: ${file.path}`;
  try {
    const content = await readFile(join(worktreePath, file.path), "utf8");
    return `Untracked file: ${file.path}\n\n${content}`;
  } catch {
    return `Untracked file: ${file.path}`;
  }
}
