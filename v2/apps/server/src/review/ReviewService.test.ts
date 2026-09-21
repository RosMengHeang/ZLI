import { describe, expect, it } from "vitest";

import { ReviewService } from "./ReviewService.js";
import { WorktreeId } from "@zli-v2/contracts";

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
});
