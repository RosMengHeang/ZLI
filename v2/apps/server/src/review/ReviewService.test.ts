import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ReviewService } from "./ReviewService.js";
import { WorktreeId } from "@zli-v2/contracts";
import { GitProcess } from "../git/GitProcess.js";

const WORKTREE_ID = WorktreeId.parse("00000000-0000-4000-8000-000000000001");

async function createRepository(): Promise<{ directory: string; repositoryPath: string; worktreePath: string; git: GitProcess }> {
  const directory = await mkdtemp(join(tmpdir(), "zli-review-real-"));
  const repositoryPath = join(directory, "repo");
  const worktreePath = join(directory, "feature-worktree");
  await mkdir(repositoryPath, { recursive: true });
  const git = new GitProcess();
  await git.run(["init"], { cwd: repositoryPath });
  await git.run(["config", "user.email", "zli-review@example.invalid"], { cwd: repositoryPath });
  await git.run(["config", "user.name", "ZLI Review"], { cwd: repositoryPath });
  await writeFile(join(repositoryPath, "README.md"), "base\n", "utf8");
  await git.run(["add", "README.md"], { cwd: repositoryPath });
  await git.run(["commit", "-m", "base"], { cwd: repositoryPath });
  await git.run(["branch", "-M", "main"], { cwd: repositoryPath });
  await git.run(["worktree", "add", "--no-track", "-b", "feature/ui", worktreePath, "main"], { cwd: repositoryPath });
  return { directory, repositoryPath, worktreePath, git };
}

describe("ReviewService", () => {
  it("builds bounded file projections from Git status and numstat", async () => {
    const calls: string[][] = [];
    const service = new ReviewService({ run: async (args) => {
      calls.push([...args]);
      if (args[0] === "rev-parse") return { code: 0, stdout: "feature/ui\n", stderr: "" };
      if (args[0] === "status") return { code: 0, stdout: " M src/App.tsx\n?? notes.txt\nUU src/conflict.ts\n", stderr: "" };
      return { code: 0, stdout: "2\t1\tsrc/App.tsx\n-\t-\tassets/logo.png\n", stderr: "" };
    } });
    const review = await service.refresh({ worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000001"), worktreePath: "C:/repo/worktree", repositoryPath: "C:/repo", branch: "feature/ui", baseRef: "main" });
    expect(review.state).toBe("conflicted");
    expect(review.files).toEqual([
      { path: "assets/logo.png", kind: "modified", staged: false, additions: 0, deletions: 0, binary: true },
      { path: "notes.txt", kind: "untracked", staged: false, additions: 0, deletions: 0, binary: false },
      { path: "src/App.tsx", kind: "modified", staged: false, additions: 2, deletions: 1, binary: false },
      { path: "src/conflict.ts", kind: "modified", staged: false, additions: 0, deletions: 0, binary: false },
    ]);
    expect(review.conflictFiles).toEqual(["src/conflict.ts"]);
    expect(calls[2]).toEqual(["diff", "--numstat", "--find-renames", "main...HEAD"]);
  });

  it("stages all files and commits with an argument-safe message", async () => {
    const calls: string[][] = [];
    const service = new ReviewService({ run: async (args) => {
      calls.push([...args]);
      if (args[0] === "rev-parse") return { code: 0, stdout: "main\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    } });
    await service.commit({ worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000001"), worktreePath: "C:/repo/worktree", repositoryPath: "C:/repo", branch: "main", baseRef: "main", message: "ship review" });
    expect(calls.slice(0, 2)).toEqual([["add", "--all", "--", "."], ["commit", "-m", "ship review"]]);
  });

  it("merges the worktree branch into a clean checked-out target", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const service = new ReviewService({ run: async (args, options) => {
      calls.push({ args: [...args], cwd: options.cwd });
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "main\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    } });
    await service.merge({ worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000001"), worktreePath: "C:/repo/worktree", repositoryPath: "C:/repo", branch: "feature/ui", baseRef: "main", targetRef: "main" });
    expect(calls.slice(0, 3)).toEqual([
      { args: ["status", "--porcelain=v1"], cwd: "C:/repo" },
      { args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: "C:/repo" },
      { args: ["merge", "--no-edit", "--no-ff", "--", "feature/ui"], cwd: "C:/repo" },
    ]);
  });

  it("aborts a target checkout merge instead of touching the worktree", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const service = new ReviewService({ run: async (args, options) => {
      calls.push({ args: [...args], cwd: options.cwd });
      if (args[0] === "rev-parse") return { code: 0, stdout: "feature/ui\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    } });
    await service.abortMerge({ worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000001"), worktreePath: "C:/repo/worktree", repositoryPath: "C:/repo", branch: "feature/ui", baseRef: "main" });
    expect(calls[0]).toEqual({ args: ["merge", "--abort"], cwd: "C:/repo" });
  });

  it("merges a real feature worktree into the checked-out target", async () => {
    const fixture = await createRepository();
    try {
      await writeFile(join(fixture.worktreePath, "change.txt"), "feature change\n", "utf8");
      const service = new ReviewService(fixture.git);
      await service.commit({ worktreeId: WORKTREE_ID, worktreePath: fixture.worktreePath, repositoryPath: fixture.repositoryPath, branch: "feature/ui", baseRef: "main", message: "feature change" });
      await service.merge({ worktreeId: WORKTREE_ID, worktreePath: fixture.worktreePath, repositoryPath: fixture.repositoryPath, branch: "feature/ui", baseRef: "main", targetRef: "main" });
      await expect(fixture.git.run(["show", "main:change.txt"], { cwd: fixture.repositoryPath })).resolves.toMatchObject({ stdout: "feature change\n" });
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("refuses a dirty target without changing the feature worktree", async () => {
    const fixture = await createRepository();
    try {
      await writeFile(join(fixture.worktreePath, "change.txt"), "feature change\n", "utf8");
      const service = new ReviewService(fixture.git);
      await service.commit({ worktreeId: WORKTREE_ID, worktreePath: fixture.worktreePath, repositoryPath: fixture.repositoryPath, branch: "feature/ui", baseRef: "main", message: "feature change" });
      await writeFile(join(fixture.repositoryPath, "dirty.txt"), "do not touch\n", "utf8");
      await expect(service.merge({ worktreeId: WORKTREE_ID, worktreePath: fixture.worktreePath, repositoryPath: fixture.repositoryPath, branch: "feature/ui", baseRef: "main", targetRef: "main" })).rejects.toThrow("Target repository has uncommitted changes");
      await expect(fixture.git.run(["status", "--porcelain=v1"], { cwd: fixture.worktreePath })).resolves.toMatchObject({ stdout: "" });
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("leaves a real conflict in the target and aborts it there", async () => {
    const fixture = await createRepository();
    try {
      await writeFile(join(fixture.repositoryPath, "conflict.txt"), "base\n", "utf8");
      await fixture.git.run(["add", "conflict.txt"], { cwd: fixture.repositoryPath });
      await fixture.git.run(["commit", "-m", "add conflict file"], { cwd: fixture.repositoryPath });
      await fixture.git.run(["reset", "--hard", "main"], { cwd: fixture.worktreePath });
      await writeFile(join(fixture.worktreePath, "conflict.txt"), "feature\n", "utf8");
      const service = new ReviewService(fixture.git);
      await service.commit({ worktreeId: WORKTREE_ID, worktreePath: fixture.worktreePath, repositoryPath: fixture.repositoryPath, branch: "feature/ui", baseRef: "main", message: "feature conflict" });
      await writeFile(join(fixture.repositoryPath, "conflict.txt"), "main\n", "utf8");
      await fixture.git.run(["add", "conflict.txt"], { cwd: fixture.repositoryPath });
      await fixture.git.run(["commit", "-m", "main conflict"], { cwd: fixture.repositoryPath });

      await expect(service.merge({ worktreeId: WORKTREE_ID, worktreePath: fixture.worktreePath, repositoryPath: fixture.repositoryPath, branch: "feature/ui", baseRef: "main", targetRef: "main" })).rejects.toThrow();
      await expect(service.abortMerge({ worktreeId: WORKTREE_ID, worktreePath: fixture.worktreePath, repositoryPath: fixture.repositoryPath, branch: "feature/ui", baseRef: "main" })).resolves.toBeDefined();
      await expect(fixture.git.run(["status", "--porcelain=v1"], { cwd: fixture.repositoryPath })).resolves.toMatchObject({ stdout: "" });
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
