import { type RuntimeProjection, type WorktreeProjection, worktreeHasLiveThread } from "@zli-v2/contracts";

export type NewAgentWorktreeChoice =
  | { mode: "missing" }
  | { mode: "current" }
  | { mode: "free"; worktree: WorktreeProjection }
  | { mode: "create" };

/**
 * A new agent uses the selected worktree when it is free.
 * Otherwise it takes another ready worktree in the same project, or asks for a new one.
 */
export function defaultWorktreeForNewAgent(
  projection: Pick<RuntimeProjection, "threads" | "worktrees">,
  current: WorktreeProjection | undefined,
): NewAgentWorktreeChoice {
  if (!current) return { mode: "missing" };
  if (!worktreeHasLiveThread(projection.threads, current.worktreeId)) return { mode: "current" };
  const free = projection.worktrees.find(
    (worktree) =>
      worktree.projectId === current.projectId &&
      worktree.worktreeId !== current.worktreeId &&
      worktree.status === "ready" &&
      !worktreeHasLiveThread(projection.threads, worktree.worktreeId),
  );
  return free ? { mode: "free", worktree: free } : { mode: "create" };
}
