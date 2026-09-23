import { lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { type GitProcess, GitProcessError } from "../git/GitProcess.js";
import { applyWorktreeInclude, type WorktreeIncludeReport } from "./WorktreeInclude.js";

export type WorktreeState =
  | "queued"
  | "fetching"
  | "creating"
  | "bootstrapping"
  | "ready"
  | "failed"
  | "cancelling"
  | "cancelled";

export type WorktreeCreateRequest = {
  jobId: string;
  repoPath: string;
  workspaceRoot: string;
  worktreePath: string;
  branch: string;
  baseRef?: string;
  checkoutExistingBranch?: boolean;
  includeFile?: string;
  bootstrap?: (context: { worktreePath: string; signal: AbortSignal }) => Promise<void>;
  onState?: (state: WorktreeState) => void;
};

export type WorktreeCreateResult = {
  jobId: string;
  worktreePath: string;
  branch: string;
  status: "ready";
  includeReport?: WorktreeIncludeReport;
};

export type WorktreeJob = {
  jobId: string;
  promise: Promise<WorktreeCreateResult>;
  cancel: () => boolean;
};

export type WorktreeRemoveRequest = {
  repoPath: string;
  workspaceRoot: string;
  worktreePath: string;
  branch?: string;
  force?: boolean;
  deleteBranch?: boolean;
};

export class WorktreeError extends Error {
  constructor(
    readonly code:
      | "unsafe_worktree_path"
      | "unsafe_git_ref"
      | "target_exists"
      | "not_found"
      | "cancelled"
      | "cleanup_failed"
      | "git_locked"
      | "git_checkout_blocked",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorktreeError";
  }
}

export class WorktreeService {
  private readonly jobs = new Map<string, WorktreeJob>();

  constructor(private readonly git: Pick<GitProcess, "run">) {}

  create(request: WorktreeCreateRequest): WorktreeJob {
    const existing = this.jobs.get(request.jobId);
    if (existing) return existing;

    const controller = new AbortController();
    const notify = request.onState ?? (() => {});
    const promise = this.runCreate(request, controller, notify);
    const job: WorktreeJob = {
      jobId: request.jobId,
      promise,
      cancel: () => {
        if (controller.signal.aborted) return false;
        notify("cancelling");
        controller.abort();
        return true;
      },
    };
    this.jobs.set(request.jobId, job);
    void promise.then(
      () => this.jobs.delete(request.jobId),
      () => this.jobs.delete(request.jobId),
    );
    return job;
  }

  cancel(jobId: string): boolean {
    return this.jobs.get(jobId)?.cancel() ?? false;
  }

  async remove(request: WorktreeRemoveRequest): Promise<{ removed: true; branchDeleted: boolean }> {
    const repoPath = assertAbsolute(request.repoPath, "repoPath");
    const worktreePath = await assertSafeWorktreePath(request.workspaceRoot, request.worktreePath);
    const args = ["worktree", "remove"];
    if (request.force) args.push("--force");
    args.push(worktreePath);
    await this.git.run(args, { cwd: repoPath });

    let branchDeleted = false;
    if (request.deleteBranch && request.branch) {
      assertSafeRef(request.branch);
      try {
        await this.git.run(["branch", "-d", request.branch], { cwd: repoPath });
        branchDeleted = true;
      } catch {
        // A branch with unmerged user work is preserved for review.
      }
    }
    return { removed: true, branchDeleted };
  }

  private async runCreate(
    request: WorktreeCreateRequest,
    controller: AbortController,
    notify: (state: WorktreeState) => void,
  ): Promise<WorktreeCreateResult> {
    notify("queued");
    let created = false;
    const repoPath = assertAbsolute(request.repoPath, "repoPath");
    const worktreePath = await assertSafeWorktreePath(request.workspaceRoot, request.worktreePath);
    assertSafeRef(request.branch);
    if (request.baseRef) assertSafeRef(request.baseRef);
    await assertTargetAvailable(worktreePath);

    try {
      if (controller.signal.aborted) throw new WorktreeError("cancelled", "Worktree creation was cancelled.");
      notify("creating");
      await mkdir(dirname(worktreePath), { recursive: true });
      const args = ["worktree", "add"];
      if (request.checkoutExistingBranch) {
        args.push(worktreePath, request.branch);
      } else {
        args.push("--no-track", "-b", request.branch, worktreePath);
        if (request.baseRef) args.push(request.baseRef);
      }
      await this.git.run(args, { cwd: repoPath, signal: controller.signal });
      created = true;
      const includeReport = await applyWorktreeInclude({
        repoPath,
        worktreePath,
        git: this.git,
        ...(request.includeFile ? { configPath: request.includeFile } : {}),
      });
      if (request.bootstrap) {
        notify("bootstrapping");
        await request.bootstrap({ worktreePath, signal: controller.signal });
      }
      if (controller.signal.aborted) throw new WorktreeError("cancelled", "Worktree creation was cancelled.");
      notify("ready");
      return {
        jobId: request.jobId,
        worktreePath,
        branch: request.branch,
        status: "ready",
        includeReport,
      };
    } catch (error) {
      const cancelled = controller.signal.aborted || isAbortError(error);
      if (created) {
        try {
          await this.git.run(["worktree", "remove", "--force", worktreePath], { cwd: repoPath });
        } catch (cleanupError) {
          notify("failed");
          throw new WorktreeError(
            "cleanup_failed",
            `Worktree creation failed and cleanup could not remove ${worktreePath}.`,
            { cause: cleanupError },
          );
        }
      }
      notify(cancelled ? "cancelled" : "failed");
      if (cancelled && !isWorktreeError(error)) {
        throw new WorktreeError("cancelled", "Worktree creation was cancelled.", { cause: error });
      }
      throw explainWorktreeGitFailure(error);
    }
  }
}

async function assertTargetAvailable(worktreePath: string): Promise<void> {
  try {
    const stats = await lstat(worktreePath);
    if (stats.isDirectory() || stats.isFile() || stats.isSymbolicLink()) {
      throw new WorktreeError("target_exists", `Worktree target already exists: ${worktreePath}`);
    }
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }
}

async function assertSafeWorktreePath(workspaceRootInput: string, worktreePathInput: string): Promise<string> {
  const workspaceRoot = assertAbsolute(workspaceRootInput, "workspaceRoot");
  const worktreePath = assertAbsolute(worktreePathInput, "worktreePath");
  const root = resolve(workspaceRoot);
  const target = resolve(worktreePath);
  const child = relative(root, target);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new WorktreeError("unsafe_worktree_path", `Worktree path must be inside ${root}.`);
  }
  return target;
}

function assertAbsolute(value: string, name: string): string {
  if (!isAbsolute(value)) throw new WorktreeError("unsafe_worktree_path", `${name} must be absolute.`);
  return resolve(value);
}

function assertSafeRef(ref: string): void {
  if (
    !ref ||
    ref.startsWith("-") ||
    ref.includes("\0") ||
    ref.includes("\\") ||
    /(^|\/)\.\.?($|\/)/u.test(ref) ||
    /[~^:?*[]/u.test(ref) ||
    ref.endsWith(".lock") ||
    ref.endsWith(".")
  ) {
    throw new WorktreeError("unsafe_git_ref", `Unsafe Git ref: ${ref}`);
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isWorktreeError(error: unknown): error is WorktreeError {
  return error instanceof WorktreeError;
}

/** Turn a raw git worktree failure into a message a person can act on. Other errors pass through. */
export function explainWorktreeGitFailure(error: unknown): unknown {
  if (!(error instanceof GitProcessError)) return error;
  const detail = `${error.stderr}\n${error.message}`;
  const normalized = detail.toLowerCase();
  const gitLine = firstGitLine(error.stderr);
  if (isGitLockFailure(normalized)) {
    return new WorktreeError(
      "git_locked",
      gitLine
        ? `Git could not create the worktree because a lock is held. Wait for the other Git process to finish, then retry. Git said: ${gitLine}`
        : "Git could not create the worktree because a lock is held. Wait for the other Git process to finish, then retry.",
      { cause: error },
    );
  }
  if (isGitCheckoutBlocked(normalized)) {
    return new WorktreeError(
      "git_checkout_blocked",
      gitLine
        ? `Git could not create the worktree. The branch is already checked out, or local changes would be overwritten. Commit, stash, or pick another branch, then retry. Git said: ${gitLine}`
        : "Git could not create the worktree. The branch is already checked out, or local changes would be overwritten. Commit, stash, or pick another branch, then retry.",
      { cause: error },
    );
  }
  return error;
}

function isGitLockFailure(detail: string): boolean {
  return (
    detail.includes(".lock") ||
    detail.includes("could not lock") ||
    detail.includes("unable to lock") ||
    detail.includes("another git process")
  );
}

function isGitCheckoutBlocked(detail: string): boolean {
  return (
    detail.includes("already checked out") ||
    detail.includes("already used by worktree") ||
    detail.includes("local changes") ||
    detail.includes("would be overwritten") ||
    detail.includes("contains modified or untracked") ||
    detail.includes("please commit or stash")
  );
}

function firstGitLine(stderr: string): string | undefined {
  const line = stderr
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return undefined;
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}
