import assert from "node:assert/strict";
import test from "node:test";

test("keeps the main checkout out and finds ZLI-managed worktrees", async () => {
  const { managedWorktrees } = await import("../src/lib/worktreePresentation.ts");

  const worktrees = managedWorktrees([
    { path: "D:/repo", branch: "main", isMain: true, locked: false, prunable: false, head: "1" },
    { path: "D:/repo.worktrees/claude-a1", branch: "zli/claude-code-a1", isMain: false, locked: false, prunable: false, head: "2" },
    { path: "D:/repo.worktrees/feature", branch: "feature/keep", isMain: false, locked: false, prunable: false, head: "3" },
    { path: "D:/missing", branch: "swarm/codex-b2", isMain: false, locked: false, prunable: true, head: "4" },
    { path: "D:/orphan", branch: null, isMain: false, locked: false, prunable: false, orphaned: true, head: "" },
  ]);

  assert.deepEqual(worktrees.map((worktree) => worktree.branch), ["zli/claude-code-a1", "swarm/codex-b2", null]);
});

test("audit helper accepts both zli and legacy swarm prefixes", async () => {
  const { managedAuditEntries, isManagedBranch, ACTIVE_BRANCH_PREFIX } = await import(
    "../src/lib/worktreePresentation.ts",
  );

  assert.equal(ACTIVE_BRANCH_PREFIX, "zli/");
  assert.equal(isManagedBranch("zli/codex-1"), true);
  assert.equal(isManagedBranch("swarm/codex-1"), true);
  assert.equal(isManagedBranch("feature/keep"), false);

  const entries = managedAuditEntries([
    { path: "D:/repo", branch: "main", state: "main", clean: true, safeToRemoveWithoutForce: false, safeToPruneMetadata: false, requiresForce: false, note: null },
    { path: "D:/a", branch: "zli/a", state: "registered_clean", clean: true, safeToRemoveWithoutForce: true, safeToPruneMetadata: false, requiresForce: false, note: null },
    { path: "D:/b", branch: "swarm/b", state: "registered_dirty", clean: false, safeToRemoveWithoutForce: false, safeToPruneMetadata: false, requiresForce: true, note: null },
    { path: "D:/c", branch: "feature/c", state: "registered_clean", clean: true, safeToRemoveWithoutForce: true, safeToPruneMetadata: false, requiresForce: false, note: null },
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.branch),
    ["zli/a", "swarm/b"],
  );
});
