import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitProcess, GitProcessError } from "../git/GitProcess.js";
import { WorktreeService } from "./WorktreeService.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "zli-v2-worktree-"));
  roots.push(root);
  const repoPath = join(root, "repo");
  const worktreesPath = join(root, "worktrees");
  await mkdir(repoPath);
  await mkdir(worktreesPath);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "zli-tests@example.invalid"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "ZLI Tests"], { cwd: repoPath });
  await writeFile(join(repoPath, "README.md"), "initial\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoPath });
  return { root, repoPath, worktreesPath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Orca-style worktree lifecycle", () => {
  it("creates a worktree through argument-safe git and reports lifecycle states", async () => {
    const { repoPath, worktreesPath } = await createRepository();
    const states: string[] = [];
    const service = new WorktreeService(new GitProcess());
    const target = join(worktreesPath, "feature-one");

    const job = service.create({
      jobId: "job-1",
      repoPath,
      workspaceRoot: worktreesPath,
      worktreePath: target,
      branch: "feature/one",
      baseRef: "main",
      onState: (state) => states.push(state),
    });
    const result = await job.promise;

    expect(result.status).toBe("ready");
    expect(states).toEqual(["queued", "creating", "ready"]);
    await expect(execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: target })).resolves.toMatchObject({
      stdout: "feature/one\n",
    });
  });

  it("deduplicates concurrent creates for the same job id", async () => {
    const { repoPath, worktreesPath } = await createRepository();
    const service = new WorktreeService(new GitProcess());
    const input = {
      jobId: "job-duplicate",
      repoPath,
      workspaceRoot: worktreesPath,
      worktreePath: join(worktreesPath, "feature-duplicate"),
      branch: "feature/duplicate",
    };

    const first = service.create(input);
    const second = service.create(input);
    expect(second).toBe(first);
    await expect(first.promise).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects traversal and unsafe refs before invoking git", async () => {
    const { repoPath, worktreesPath } = await createRepository();
    const service = new WorktreeService(new GitProcess());

    await expect(
      service.create({
        jobId: "job-traversal",
        repoPath,
        workspaceRoot: worktreesPath,
        worktreePath: join(worktreesPath, "..", "outside"),
        branch: "feature/safe",
      }).promise,
    ).rejects.toMatchObject({ code: "unsafe_worktree_path" });
    await expect(
      service.create({
        jobId: "job-ref",
        repoPath,
        workspaceRoot: worktreesPath,
        worktreePath: join(worktreesPath, "safe"),
        branch: "--upload-pack=evil",
      }).promise,
    ).rejects.toMatchObject({ code: "unsafe_git_ref" });
  });

  it("preserves a stale partial directory instead of deleting user files", async () => {
    const { repoPath, worktreesPath } = await createRepository();
    const target = join(worktreesPath, "partial");
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "user data");
    const service = new WorktreeService(new GitProcess());

    await expect(
      service.create({
        jobId: "job-partial",
        repoPath,
        workspaceRoot: worktreesPath,
        worktreePath: target,
        branch: "feature/partial",
      }).promise,
    ).rejects.toMatchObject({ code: "target_exists" });
    await expect(execFileAsync("git", ["status", "--short"], { cwd: repoPath })).resolves.toBeDefined();
  });

  it("removes only a registered worktree and preserves its branch by default", async () => {
    const { repoPath, worktreesPath } = await createRepository();
    const service = new WorktreeService(new GitProcess());
    const target = join(worktreesPath, "remove-me");
    await service.create({
      jobId: "job-remove-create",
      repoPath,
      workspaceRoot: worktreesPath,
      worktreePath: target,
      branch: "feature/preserve",
    }).promise;

    await service.remove({ repoPath, workspaceRoot: worktreesPath, worktreePath: target });

    await expect(
      execFileAsync("git", ["show-ref", "--verify", "refs/heads/feature/preserve"], { cwd: repoPath }),
    ).resolves.toBeDefined();
  });

  it("cancels an in-flight Git operation and reports the cancelled terminal state", async () => {
    const { repoPath, worktreesPath } = await createRepository();
    const states: string[] = [];
    const run = vi.fn(async (_args: readonly string[], options: { signal?: AbortSignal }) => {
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), {
          once: true,
        });
        if (options.signal?.aborted) reject(new DOMException("cancelled", "AbortError"));
      });
      return { code: 0, stdout: "", stderr: "" };
    });
    const service = new WorktreeService({ run });
    const job = service.create({
      jobId: "job-cancel",
      repoPath,
      workspaceRoot: worktreesPath,
      worktreePath: join(worktreesPath, "cancelled"),
      branch: "feature/cancelled",
      onState: (state) => states.push(state),
    });

    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    expect(service.cancel("job-cancel")).toBe(true);
    await expect(job.promise).rejects.toMatchObject({ code: "cancelled" });
    expect(states).toContain("cancelling");
    expect(states).toContain("cancelled");
  });

  it("surfaces a lock and a blocked checkout as distinct worktree errors", async () => {
    const { repoPath, worktreesPath } = await createRepository();
    const lock = new WorktreeService({
      run: async () => {
        throw new GitProcessError(
          "git worktree add exited with code 128.",
          128,
          ["worktree", "add"],
          "",
          "fatal: Unable to create '/repo/.git/index.lock': File exists.\n",
        );
      },
    });
    await expect(
      lock.create({
        jobId: "job-lock",
        repoPath,
        workspaceRoot: worktreesPath,
        worktreePath: join(worktreesPath, "locked"),
        branch: "feature/locked",
      }).promise,
    ).rejects.toMatchObject({
      code: "git_locked",
      message: expect.stringContaining("index.lock"),
    });

    const blocked = new WorktreeService({
      run: async () => {
        throw new GitProcessError(
          "git worktree add exited with code 128.",
          128,
          ["worktree", "add"],
          "",
          "fatal: 'feature/dirty' is already checked out at '/repo'\n",
        );
      },
    });
    await expect(
      blocked.create({
        jobId: "job-dirty",
        repoPath,
        workspaceRoot: worktreesPath,
        worktreePath: join(worktreesPath, "dirty"),
        branch: "feature/dirty",
      }).promise,
    ).rejects.toMatchObject({
      code: "git_checkout_blocked",
      message: expect.stringContaining("already checked out"),
    });
  });
});
