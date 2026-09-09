import assert from "node:assert/strict";
import test from "node:test";

test("keeps the main checkout out and finds ZLI-managed worktrees", async () => {
  const { managedWorktrees } = await import("../src/lib/worktreePresentation.ts");

  const worktrees = managedWorktrees([
    { path: "D:/repo", branch: "main", isMain: true, locked: false, prunable: false, head: "1" },
    { path: "D:/repo.worktrees/claude-a1", branch: "swarm/claude-code-a1", isMain: false, locked: false, prunable: false, head: "2" },
    { path: "D:/repo.worktrees/feature", branch: "feature/keep", isMain: false, locked: false, prunable: false, head: "3" },
    { path: "D:/missing", branch: "swarm/codex-b2", isMain: false, locked: false, prunable: true, head: "4" },
    { path: "D:/orphan", branch: null, isMain: false, locked: false, prunable: false, orphaned: true, head: "" },
  ]);

  assert.deepEqual(worktrees.map((worktree) => worktree.branch), ["swarm/claude-code-a1", "swarm/codex-b2", null]);
});
