import type { TeamDiff } from "@zli-v2/contracts";

import { type GitProcess, GitProcessError } from "../git/GitProcess.js";

/** Used for a commit only when the repository has no name or email set, so the merge can still go through. */
const FALLBACK_IDENTITY = ["-c", "user.name=ZLI", "-c", "user.email=zli@localhost"] as const;

export type MergeOutcome =
  | { kind: "merged" }
  | { kind: "conflict"; files: string[] }
  | { kind: "failed"; message: string };

/**
 * The git steps that put a team's work on one branch: commit what a job left uncommitted, merge a job's branch
 * into the team branch, and measure the result against the base.
 */
export class TeamGit {
  constructor(private readonly git: GitProcess) {}

  /** Commits everything a job left in its worktree. Nothing to commit is fine. */
  async commitLeftovers(cwd: string, message: string): Promise<void> {
    const status = await this.git.run(["status", "--porcelain"], { cwd });
    if (!status.stdout.trim()) return;
    await this.git.run(["add", "-A"], { cwd });
    await this.withIdentity(["commit", "--no-verify", "-m", message], cwd);
  }

  /**
   * Merges a branch into the branch checked out at cwd. A conflict is undone again, so the team branch stays
   * clean, and the conflicting files are named.
   */
  async merge(cwd: string, branch: string, message: string): Promise<MergeOutcome> {
    try {
      await this.withIdentity(["merge", "--no-ff", "--no-edit", "-m", message, branch], cwd);
      return { kind: "merged" };
    } catch (error) {
      const files = await this.conflictedFiles(cwd);
      if (files.length > 0) {
        await this.git.run(["merge", "--abort"], { cwd }).catch(() => undefined);
        return { kind: "conflict", files };
      }
      // A merge stopped part way for another reason is undone too, when there is one to undo.
      await this.git.run(["merge", "--abort"], { cwd }).catch(() => undefined);
      return { kind: "failed", message: messageOf(error) };
    }
  }

  /** What the team branch changes against its base. */
  async diff(cwd: string, base: string | undefined): Promise<TeamDiff> {
    const range = base ? [`${base}...HEAD`] : ["HEAD"];
    const result = await this.git.run(["diff", "--shortstat", ...range], { cwd }).catch(() => undefined);
    return parseShortstat(result?.stdout ?? "");
  }

  private async conflictedFiles(cwd: string): Promise<string[]> {
    const result = await this.git.run(["diff", "--name-only", "--diff-filter=U"], { cwd }).catch(() => undefined);
    return (result?.stdout ?? "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 50);
  }

  private async withIdentity(args: readonly string[], cwd: string): Promise<void> {
    try {
      await this.git.run(args, { cwd });
    } catch (error) {
      if (!(error instanceof GitProcessError) || !/user\.(name|email)|identity/iu.test(error.stderr)) throw error;
      await this.git.run([...FALLBACK_IDENTITY, ...args], { cwd });
    }
  }
}

export function parseShortstat(text: string): TeamDiff {
  const number = (pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? 0);
  return {
    files: number(/(\d+) files? changed/u),
    insertions: number(/(\d+) insertions?\(\+\)/u),
    deletions: number(/(\d+) deletions?\(-\)/u),
  };
}

function messageOf(error: unknown): string {
  const text = error instanceof GitProcessError ? error.stderr.trim() || error.message : String(error);
  return text.split(/\r?\n/u)[0]?.slice(0, 200) || "git could not merge it";
}
