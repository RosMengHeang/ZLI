import type { WorktreeAuditEntry, WorktreeInfo } from "../types/index.ts";

export const ACTIVE_BRANCH_PREFIX = "zli/";
export const LEGACY_BRANCH_PREFIX = "swarm/";

export function isManagedBranch(branch: string | null | undefined): boolean {
  return Boolean(
    branch?.startsWith(ACTIVE_BRANCH_PREFIX) || branch?.startsWith(LEGACY_BRANCH_PREFIX),
  );
}

export function managedWorktrees(worktrees: WorktreeInfo[]): WorktreeInfo[] {
  return worktrees.filter(
    (worktree) =>
      !worktree.isMain &&
      (isManagedBranch(worktree.branch) || worktree.prunable || worktree.orphaned),
  );
}

export function managedAuditEntries(entries: WorktreeAuditEntry[]): WorktreeAuditEntry[] {
  return entries.filter(
    (entry) =>
      entry.state !== "main" &&
      (isManagedBranch(entry.branch) ||
        entry.state.startsWith("orphaned_") ||
        entry.state === "prunable_metadata"),
  );
}
