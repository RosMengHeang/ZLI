import {
  ReviewProjection,
  WorktreeId,
  type ReviewFileProjection,
  type ReviewProjection as ReviewProjectionValue,
} from "@zli-v2/contracts";

import { GitProcess, type GitResult } from "../git/GitProcess.js";

export type ReviewServiceInput = {
  worktreeId: WorktreeId;
  worktreePath: string;
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

  async merge(input: ReviewServiceInput & { targetRef: string }): Promise<ReviewProjectionValue> {
    assertRef(input.targetRef);
    try {
      await this.git.run(["merge", "--no-edit", "--", input.targetRef], { cwd: input.worktreePath });
    } catch (error) {
      const current = await this.refresh(input);
      if (current.conflictFiles.length === 0) throw error;
      return current;
    }
    return this.refresh(input);
  }

  async abortMerge(input: ReviewServiceInput): Promise<ReviewProjectionValue> {
    await this.git.run(["merge", "--abort"], { cwd: input.worktreePath });
    return this.refresh(input);
  }
}

type StatusEntry = { xy: string; path: string };
type NumstatEntry = { path: string; additions: number; deletions: number; binary: boolean };

function parseStatus(stdout: string): StatusEntry[] {
  return stdout.split(/\r?\n/u).map((line) => line.trimEnd()).filter(Boolean).flatMap((line) => {
    if (line.length < 4) return [];
    return [{ xy: line.slice(0, 2), path: line.slice(3).trim() }];
  });
}

function parseNumstat(stdout: string): NumstatEntry[] {
  return stdout.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    const match = /^(\d+|-)\s+(\d+|-)\s+(.+)$/u.exec(line);
    if (!match) return [];
    const additions = match[1] === "-" ? 0 : Number(match[1]);
    const deletions = match[2] === "-" ? 0 : Number(match[2]);
    return [{ path: match[3]!, additions, deletions, binary: match[1] === "-" || match[2] === "-" }];
  });
}

function mergeFiles(statuses: StatusEntry[], stats: NumstatEntry[]): ReviewFileProjection[] {
  const byPath = new Map(stats.map((entry) => [entry.path, entry]));
  const paths = new Set([...statuses.map((entry) => entry.path), ...stats.map((entry) => entry.path)]);
  return [...paths].sort().map((path) => {
    const status = statuses.find((entry) => entry.path === path);
    const stat = byPath.get(path);
    const xy = status?.xy ?? "  ";
    const kind = xy.includes("?") ? "untracked" : xy.includes("D") ? "deleted" : xy.includes("A") ? "added" : xy.includes("R") ? "renamed" : "modified";
    return {
      path,
      kind,
      staged: xy[0] !== undefined && "AMDRCT".includes(xy[0]),
      additions: stat?.additions ?? 0,
      deletions: stat?.deletions ?? 0,
      binary: stat?.binary ?? false,
    };
  });
}

function isConflict(xy: string): boolean {
  return xy.includes("U") || xy === "AA" || xy === "DD";
}

function assertRef(value: string): void {
  if (!value || value.startsWith("-") || value.includes("\0") || value.includes("\\") || /(^|\/)\.\.?($|\/)/u.test(value) || /[~^:?*\[]/u.test(value) || value.endsWith(".lock") || value.endsWith(".")) {
    throw new Error(`Unsafe Git ref: ${value}`);
  }
}
