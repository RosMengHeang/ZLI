import {
  type GitChangeResult,
  type GitChangesCommand,
  type GitHunkAction,
  type GitStash,
  type GitStashAction,
  GitStashListResult,
  GitStashResult,
  type RuntimeProjection,
} from "@zli-v2/contracts";

import { isConflict, parseStatusZ } from "./gitStatus.js";
import { hunkPatch, partDiffArgs } from "./hunkPatch.js";
import { type ProcessResult, type ProcessRunner, redactSecrets, runProcess } from "./PullRequestService.js";

/** A failure the person can act on; the message is shown as is. */
export class GitChangesError extends Error {
  override readonly name = "GitChangesError";
}

const GIT_TIMEOUT_MS = 30_000;
const STASH_TIMEOUT_MS = 120_000;
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_STASHES = 200;
const MAX_STASH_MESSAGE = 500;
const STASH_MOVED = "The stash list changed since it was shown. Look at the list again, then retry.";
const OK: GitChangeResult = { ok: true };

/** Rejects paths that could leave the worktree or read as an option. Git also gets `--` and literal pathspecs. */
export function assertChangePath(value: string): void {
  if (
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((part) => part === "..")
  ) {
    throw new GitChangesError(`ZLI cannot change this path: ${value}`);
  }
}

export class GitChangesService {
  constructor(private readonly runner: ProcessRunner = runProcess) {}

  /** Stages files, deletions and new files included; without paths, every change in the worktree. */
  async stage(cwd: string, paths?: readonly string[]): Promise<GitChangeResult> {
    for (const path of paths ?? []) assertChangePath(path);
    await this.mustRun(
      ["--literal-pathspecs", "add", "--all", "--", ...(paths ?? ["."])],
      cwd,
      "could not stage the changes",
    );
    return OK;
  }

  /** `git reset` rather than `git restore --staged`, because it also works before the first commit. */
  async unstage(cwd: string, paths?: readonly string[]): Promise<GitChangeResult> {
    for (const path of paths ?? []) assertChangePath(path);
    await this.mustRun(
      ["--literal-pathspecs", "reset", "--quiet", "--", ...(paths ?? ["."])],
      cwd,
      "could not unstage the changes",
    );
    return OK;
  }

  async discard(cwd: string, path: string): Promise<GitChangeResult> {
    assertChangePath(path);
    // The whole status, not just this path, so a rename shows with both of its names.
    const status = await this.mustRun(["status", "--porcelain=v1", "-z"], cwd, "could not read the worktree status");
    const entry = parseStatusZ(status.stdout).find((candidate) => candidate.path === path);
    if (!entry) throw new GitChangesError(`${path} has no uncommitted changes to discard.`);
    if (isConflict(entry.xy)) {
      throw new GitChangesError(`${path} has a merge conflict. Resolve it, or abort the merge, instead of discarding.`);
    }
    if (entry.xy === "??") {
      await this.mustRun(
        ["--literal-pathspecs", "clean", "--force", "-d", "--", path],
        cwd,
        `could not delete ${path}`,
      );
      return OK;
    }
    await this.mustRun(
      [
        "--literal-pathspecs",
        "restore",
        "--source=HEAD",
        "--staged",
        "--worktree",
        "--",
        path,
        ...(entry.oldPath ? [entry.oldPath] : []),
      ],
      cwd,
      `could not discard the changes to ${path}`,
    );
    return OK;
  }

  /**
   * Stages, unstages, or discards one hunk by applying a patch of just that hunk: to the index, to the index in
   * reverse, or to the working tree in reverse. The hunk must match the current diff exactly.
   */
  async hunk(
    cwd: string,
    request: { path: string; action: GitHunkAction; index: number; hunk: string },
  ): Promise<GitChangeResult> {
    assertChangePath(request.path);
    const part = request.action === "unstage" ? "staged" : "unstaged";
    const diff = await this.mustRun(
      partDiffArgs(part, request.path),
      cwd,
      `could not read the diff of ${request.path}`,
      {
        maxOutputBytes: MAX_DIFF_BYTES,
      },
    );
    const patch = hunkPatch(diff.stdout, request.index, request.hunk);
    if (!patch) {
      throw new GitChangesError(
        `The diff of ${request.path} changed since it was shown. Open the file again, then retry.`,
      );
    }
    const args =
      request.action === "stage"
        ? ["apply", "--cached", "--whitespace=nowarn", "-"]
        : request.action === "unstage"
          ? ["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"]
          : ["apply", "--reverse", "--whitespace=nowarn", "-"];
    const result = await this.runner("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS, input: patch });
    if (result.code !== 0) throw new GitChangesError(gitFailure(`could not ${request.action} the hunk`, result));
    return OK;
  }

  async stashList(cwd: string): Promise<GitStashListResult> {
    return GitStashListResult.parse({ stashes: await this.stashes(cwd) });
  }

  /** Stashes tracked and untracked changes. Ignored files stay. */
  async stash(cwd: string, message?: string): Promise<GitStashResult> {
    const text = (message ?? "").replace(/\s+/gu, " ").trim().slice(0, MAX_STASH_MESSAGE);
    const before = await this.stashTop(cwd);
    const result = await this.runner(
      "git",
      ["stash", "push", "--include-untracked", ...(text ? ["--message", text] : [])],
      { cwd, timeoutMs: STASH_TIMEOUT_MS },
    );
    if (result.code !== 0) throw new GitChangesError(gitFailure("could not stash the changes", result));
    const after = await this.stashTop(cwd);
    return GitStashResult.parse({ stashes: await this.stashes(cwd), created: !!after && after !== before });
  }

  async stashAction(
    cwd: string,
    request: { action: GitStashAction; index: number; commit: string },
  ): Promise<GitStashResult> {
    const ref = `stash@{${request.index}}`;
    const resolved = await this.git(["rev-parse", "--verify", "--quiet", ref], cwd);
    if (resolved.code !== 0 || resolved.stdout.trim() !== request.commit) throw new GitChangesError(STASH_MOVED);
    const result = await this.runner("git", ["stash", request.action, "--quiet", ref], {
      cwd,
      timeoutMs: STASH_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      // Applying can stop halfway with conflicts in the working tree; Git then keeps a popped stash.
      if (request.action !== "drop" && (await this.hasConflicts(cwd))) {
        return GitStashResult.parse({ stashes: await this.stashes(cwd), conflicted: true });
      }
      throw new GitChangesError(gitFailure(`could not ${request.action} the stash`, result));
    }
    return GitStashResult.parse({ stashes: await this.stashes(cwd) });
  }

  private async stashes(cwd: string): Promise<GitStash[]> {
    const result = await this.mustRun(
      ["stash", "list", `--max-count=${MAX_STASHES}`, "--format=%gd%x1f%H%x1f%gs%x1f%cI"],
      cwd,
      "could not list the stashes",
    );
    return parseStashList(result.stdout);
  }

  private async stashTop(cwd: string): Promise<string | undefined> {
    const result = await this.git(["rev-parse", "--verify", "--quiet", "refs/stash"], cwd);
    return result.code === 0 ? result.stdout.trim() || undefined : undefined;
  }

  private async hasConflicts(cwd: string): Promise<boolean> {
    const status = await this.git(["status", "--porcelain=v1", "-z"], cwd);
    return status.code === 0 && parseStatusZ(status.stdout).some((entry) => isConflict(entry.xy));
  }

  private git(args: readonly string[], cwd: string, maxOutputBytes?: number): Promise<ProcessResult> {
    return this.runner("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS, ...(maxOutputBytes ? { maxOutputBytes } : {}) });
  }

  private async mustRun(
    args: readonly string[],
    cwd: string,
    action: string,
    options: { maxOutputBytes?: number } = {},
  ): Promise<ProcessResult> {
    const result = await this.git(args, cwd, options.maxOutputBytes);
    if (result.code !== 0) throw new GitChangesError(gitFailure(action, result));
    return result;
  }
}

/** Runs one staging or stash command in the worktree it names. */
export async function runGitChangesCommand(
  service: GitChangesService,
  projection: RuntimeProjection,
  command: GitChangesCommand,
): Promise<unknown> {
  const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === command.worktreeId);
  if (!worktree) throw new GitChangesError("Worktree does not exist.");
  if (worktree.status !== "ready") throw new GitChangesError("Worktree is not ready.");
  const project = projection.projects.find((candidate) => candidate.projectId === worktree.projectId);
  if (project?.git === false) {
    throw new GitChangesError("This folder is not a Git repository. Run git init in the folder to stage changes.");
  }
  const cwd = worktree.path;
  switch (command.type) {
    case "review.git.stage":
      return service.stage(cwd, command.paths);
    case "review.git.unstage":
      return service.unstage(cwd, command.paths);
    case "review.git.discard":
      return service.discard(cwd, command.path);
    case "review.git.hunk":
      return service.hunk(cwd, {
        path: command.path,
        action: command.action,
        index: command.index,
        hunk: command.hunk,
      });
    case "review.git.stashList":
      return service.stashList(cwd);
    case "review.git.stash":
      return service.stash(cwd, command.message);
    case "review.git.stashAction":
      return service.stashAction(cwd, { action: command.action, index: command.index, commit: command.commit });
  }
}

/** Parses `git stash list --format=%gd%x1f%H%x1f%gs%x1f%cI`. */
export function parseStashList(stdout: string): GitStash[] {
  const stashes: GitStash[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const [selector, commit, subject, createdAt] = line.split("\x1f");
    const index = /^stash@\{(\d+)\}$/u.exec(selector ?? "")?.[1];
    if (index === undefined || !commit || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(commit)) continue;
    // Git writes "On <branch>: <message>" for a named stash and "WIP on <branch>: <sha> <subject>" otherwise.
    const match = /^(WIP on|On) ([^:]+): (.*)$/su.exec(subject ?? "");
    const branch = match?.[2];
    const message = match ? (match[1] === "WIP on" ? match[3]?.replace(/^[0-9a-f]+ /u, "") : match[3]) : subject;
    stashes.push({
      index: Number(index),
      commit,
      ...(branch && !branch.startsWith("(") ? { branch: branch.slice(0, 255) } : {}),
      message: (match?.[1] === "WIP on" ? `Work in progress: ${message ?? ""}` : (message ?? "")).slice(0, 1_000),
      ...(createdAt ? { createdAt: createdAt.slice(0, 40) } : {}),
    });
  }
  return stashes;
}

function gitFailure(action: string, result: ProcessResult): string {
  const detail = redactSecrets(result.stderr || result.stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" ");
  const bounded = detail.length > 400 ? `${detail.slice(0, 399)}…` : detail;
  return `Git ${action}.${bounded ? ` ${bounded}` : ""}`;
}
