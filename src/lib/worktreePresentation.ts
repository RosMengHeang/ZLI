import type { WorktreeInfo } from "../types";

const ZLI_BRANCH_PREFIX = "swarm/";

export function managedWorktrees(worktrees: WorktreeInfo[]): WorktreeInfo[] {
  return worktrees.filter(
    (worktree) =>
      !worktree.isMain &&
      (worktree.branch?.startsWith(ZLI_BRANCH_PREFIX) || worktree.prunable),
  );
}
