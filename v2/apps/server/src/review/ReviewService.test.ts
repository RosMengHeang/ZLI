import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ReviewService } from "./ReviewService.js";
import { WorktreeId } from "@zli-v2/contracts";
import { GitProcess } from "../git/GitProcess.js";

const WORKTREE_ID = WorktreeId.parse("00000000-0000-4000-8000-000000000001");

async function createRepository(): Promise<{
  directory: string;
  repositoryPath: string;
  worktreePath: string;
  git: GitProcess;
}> {
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
    const service = new ReviewService({
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "rev-parse") return { code: 0, stdout: "feature/ui\n", stderr: "" };
        if (args[0] === "status")
          return { code: 0, stdout: " M src/App.tsx\n?? notes.txt\nUU src/conflict.ts\n", stderr: "" };
        return { code: 0, stdout: "2\t1\tsrc/App.tsx\n-\t-\tassets/logo.png\n", stderr: "" };
      },
    });
    const review = await service.refresh({
      worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000001"),
      worktreePath: "C:/repo/worktree",
      repositoryPath: "C:/repo",
      branch: "feature/ui",
      baseRef: "main",
    });
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

  it("loads a bounded on-demand patch for a reviewed file", async () => {
    const service = new ReviewService({
      run: async (args) => {
        if (args[0] === "rev-parse") return { code: 0, stdout: "feature/ui\n", stderr: "" };
        if (args[0] === "status") return { code: 0, stdout: " M src/App.tsx\n", stderr: "" };
        if (args[2] === "--numstat") return { code: 0, stdout: "2\t1\tsrc/App.tsx\n", stderr: "" };
        return { code: 0, stdout: "@@ -1,1 +1,2 @@\n-old\n+new\n", stderr: "" };
      },
    });

    const review = await service.diff({
      worktreeId: WORKTREE_ID,
      worktreePath: "C:/repo/worktree",
      repositoryPath: "C:/repo",
      branch: "feature/ui",
      baseRef: "main",
      path: "src/App.tsx",
    });
    expect(review.diff).toMatchObject({
      path: "src/App.tsx",
      patch: "@@ -1,1 +1,2 @@\n-old\n+new\n",
      truncated: false,
      binary: false,
    });
  });

  it("rejects review paths that escape the worktree", async () => {
    const service = new ReviewService({ run: async () => ({ code: 0, stdout: "", stderr: "" }) });
    await expect(
      service.diff({
        worktreeId: WORKTREE_ID,
        worktreePath: "C:/repo/worktree",
        repositoryPath: "C:/repo",
        branch: "feature/ui",
        baseRef: "main",
        path: "../secrets.txt",
      }),
    ).rejects.toThrow("Unsafe review path");
  });

  it("loads the content of an untracked text file on demand", async () => {
    const fixture = await createRepository();
    try {
      await writeFile(join(fixture.worktreePath, "new-file.txt"), "new file content\n", "utf8");
      const review = await new ReviewService(fixture.git).diff({
        worktreeId: WORKTREE_ID,
        worktreePath: fixture.worktreePath,
        repositoryPath: fixture.repositoryPath,
        branch: "feature/ui",
        baseRef: "main",
        path: "new-file.txt",
      });
      expect(review.diff?.patch).toContain("new file content");
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("stages all files and commits with an argument-safe message", async () => {
    const calls: string[][] = [];
    const service = new ReviewService({
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "rev-parse") return { code: 0, stdout: "main\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await service.commit({
      worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000001"),
      worktreePath: "C:/repo/worktree",
      repositoryPath: "C:/repo",
      branch: "main",
      baseRef: "main",
      message: "ship review",
    });
    expect(calls.slice(0, 2)).toEqual([
      ["add", "--all", "--", "."],
      ["commit", "-m", "ship review"],
    ]);
  });

  it("merges the worktree branch into a clean checked-out target", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const service = new ReviewService({
      run: async (args, options) => {
        calls.push({ args: [...args], cwd: options.cwd });
        if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "rev-parse") return { code: 0, stdout: "main\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await service.merge({
      worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000001"),
      worktreePath: "C:/repo/worktree",
      repositoryPath: "C:/repo",
      branch: "feature/ui",
      baseRef: "main",
      targetRef: "main",
    });
    expect(calls.slice(0, 3)).toEqual([
      { args: ["status", "--porcelain=v1"], cwd: "C:/repo" },
      { args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: "C:/repo" },
      { args: ["merge", "--no-edit", "--no-ff", "--", "feature/ui"], cwd: "C:/repo" },
    ]);
  });

  it("aborts a target checkout merge instead of touching the worktree", async () => {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const service = new ReviewService({
      run: async (args, options) => {
        calls.push({ args: [...args], cwd: options.cwd });
        if (args[0] === "rev-parse") return { code: 0, stdout: "feature/ui\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await service.abortMerge({
      worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000001"),
      worktreePath: "C:/repo/worktree",
      repositoryPath: "C:/repo",
      branch: "feature/ui",
      baseRef: "main",
    });
    expect(calls[0]).toEqual({ args: ["merge", "--abort"], cwd: "C:/repo" });
  });

  it("merges a real feature worktree into the checked-out target", async () => {
    const fixture = await createRepository();
    try {
      await writeFile(join(fixture.worktreePath, "change.txt"), "feature change\n", "utf8");
      const service = new ReviewService(fixture.git);
      await service.commit({
        worktreeId: WORKTREE_ID,
        worktreePath: fixture.worktreePath,
        repositoryPath: fixture.repositoryPath,
        branch: "feature/ui",
        baseRef: "main",
        message: "feature change",
      });
      await service.merge({
        worktreeId: WORKTREE_ID,
        worktreePath: fixture.worktreePath,
        repositoryPath: fixture.repositoryPath,
        branch: "feature/ui",
        baseRef: "main",
        targetRef: "main",
      });
      await expect(
        fixture.git.run(["show", "main:change.txt"], { cwd: fixture.repositoryPath }),
      ).resolves.toMatchObject({ stdout: "feature change\n" });
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("refuses a dirty target without changing the feature worktree", async () => {
    const fixture = await createRepository();
    try {
      await writeFile(join(fixture.worktreePath, "change.txt"), "feature change\n", "utf8");
      const service = new ReviewService(fixture.git);
      await service.commit({
        worktreeId: WORKTREE_ID,
        worktreePath: fixture.worktreePath,
        repositoryPath: fixture.repositoryPath,
        branch: "feature/ui",
        baseRef: "main",
        message: "feature change",
      });
      await writeFile(join(fixture.repositoryPath, "dirty.txt"), "do not touch\n", "utf8");
      await expect(
        service.merge({
          worktreeId: WORKTREE_ID,
          worktreePath: fixture.worktreePath,
          repositoryPath: fixture.repositoryPath,
          branch: "feature/ui",
          baseRef: "main",
          targetRef: "main",
        }),
      ).rejects.toThrow("Target repository has uncommitted changes");
      await expect(fixture.git.run(["status", "--porcelain=v1"], { cwd: fixture.worktreePath })).resolves.toMatchObject(
        { stdout: "" },
      );
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
      await service.commit({
        worktreeId: WORKTREE_ID,
        worktreePath: fixture.worktreePath,
        repositoryPath: fixture.repositoryPath,
        branch: "feature/ui",
        baseRef: "main",
        message: "feature conflict",
      });
      await writeFile(join(fixture.repositoryPath, "conflict.txt"), "main\n", "utf8");
      await fixture.git.run(["add", "conflict.txt"], { cwd: fixture.repositoryPath });
      await fixture.git.run(["commit", "-m", "main conflict"], { cwd: fixture.repositoryPath });

      const conflicted = await service.merge({
        worktreeId: WORKTREE_ID,
        worktreePath: fixture.worktreePath,
        repositoryPath: fixture.repositoryPath,
        branch: "feature/ui",
        baseRef: "main",
        targetRef: "main",
      });
      expect(conflicted.state).toBe("conflicted");
      expect(conflicted.conflictFiles).toContain("conflict.txt");
      await expect(fixture.git.run(["status", "--porcelain=v1"], { cwd: fixture.worktreePath })).resolves.toMatchObject(
        { stdout: "" },
      );
      await expect(
        service.abortMerge({
          worktreeId: WORKTREE_ID,
          worktreePath: fixture.worktreePath,
          repositoryPath: fixture.repositoryPath,
          branch: "feature/ui",
          baseRef: "main",
        }),
      ).resolves.toBeDefined();
      await expect(
        fixture.git.run(["status", "--porcelain=v1"], { cwd: fixture.repositoryPath }),
      ).resolves.toMatchObject({ stdout: "" });
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("keeps binary and rename metadata while mixing staged and unstaged changes", async () => {
    const fixture = await createRepository();
    try {
      await writeFile(join(fixture.repositoryPath, "old-name.txt"), "rename me\n", "utf8");
      await fixture.git.run(["add", "old-name.txt"], { cwd: fixture.repositoryPath });
      await fixture.git.run(["commit", "-m", "add rename source"], { cwd: fixture.repositoryPath });
      await fixture.git.run(["merge", "main"], { cwd: fixture.worktreePath });
      await fixture.git.run(["mv", "old-name.txt", "new-name.txt"], { cwd: fixture.worktreePath });
      await writeFile(join(fixture.worktreePath, "logo.bin"), Buffer.from([0, 1, 2, 255]));
      await fixture.git.run(["add", "--all"], { cwd: fixture.worktreePath });
      await fixture.git.run(["commit", "-m", "rename and binary"], { cwd: fixture.worktreePath });
      await writeFile(join(fixture.worktreePath, "staged.txt"), "staged\n", "utf8");
      await fixture.git.run(["add", "staged.txt"], { cwd: fixture.worktreePath });
      await writeFile(join(fixture.worktreePath, "README.md"), "unstaged\n", "utf8");

      const review = await new ReviewService(fixture.git).refresh({
        worktreeId: WORKTREE_ID,
        worktreePath: fixture.worktreePath,
        repositoryPath: fixture.repositoryPath,
        branch: "feature/ui",
        baseRef: "main",
      });
      expect(review.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "new-name.txt", oldPath: "old-name.txt", kind: "renamed" }),
          expect.objectContaining({ path: "logo.bin", binary: true }),
          expect.objectContaining({ path: "staged.txt", staged: true }),
          expect.objectContaining({ path: "README.md", staged: false }),
        ]),
      );
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("rejects an invalid commit message without changing the worktree", async () => {
    const fixture = await createRepository();
    try {
      await writeFile(join(fixture.worktreePath, "pending.txt"), "pending\n", "utf8");
      const service = new ReviewService(fixture.git);
      await expect(
        service.commit({
          worktreeId: WORKTREE_ID,
          worktreePath: fixture.worktreePath,
          repositoryPath: fixture.repositoryPath,
          branch: "feature/ui",
          baseRef: "main",
          message: "   ",
        }),
      ).rejects.toThrow("Commit message must contain visible text");
      await expect(fixture.git.run(["status", "--porcelain=v1"], { cwd: fixture.worktreePath })).resolves.toMatchObject(
        { stdout: "?? pending.txt\n" },
      );
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("preserves changes when a real pre-commit hook rejects the commit", async () => {
    const fixture = await createRepository();
    try {
      const hooksPath = join(fixture.directory, "hooks");
      await mkdir(hooksPath, { recursive: true });
      await writeFile(
        join(hooksPath, "pre-commit"),
        "#!/bin/sh\nprintf '%s\\n' 'blocked by test hook' >&2\nexit 1\n",
        "utf8",
      );
      await chmod(join(hooksPath, "pre-commit"), 0o755);
      await fixture.git.run(["config", "core.hooksPath", hooksPath], { cwd: fixture.repositoryPath });
      await writeFile(join(fixture.worktreePath, "hooked.txt"), "keep me\n", "utf8");

      await expect(
        new ReviewService(fixture.git).commit({
          worktreeId: WORKTREE_ID,
          worktreePath: fixture.worktreePath,
          repositoryPath: fixture.repositoryPath,
          branch: "feature/ui",
          baseRef: "main",
          message: "blocked commit",
        }),
      ).rejects.toThrow();
      await expect(fixture.git.run(["status", "--porcelain=v1"], { cwd: fixture.worktreePath })).resolves.toMatchObject(
        { stdout: "A  hooked.txt\n" },
      );
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it("refreshes a detached worktree base without inventing a branch", async () => {
    const fixture = await createRepository();
    try {
      await fixture.git.run(["checkout", "--detach", "main"], { cwd: fixture.worktreePath });
      await writeFile(join(fixture.worktreePath, "detached.txt"), "detached\n", "utf8");
      const review = await new ReviewService(fixture.git).refresh({
        worktreeId: WORKTREE_ID,
        worktreePath: fixture.worktreePath,
        repositoryPath: fixture.repositoryPath,
        branch: "feature/ui",
        baseRef: "main",
      });
      expect(review.branch).toBe("HEAD");
      expect(review.files).toEqual([expect.objectContaining({ path: "detached.txt", kind: "untracked" })]);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
