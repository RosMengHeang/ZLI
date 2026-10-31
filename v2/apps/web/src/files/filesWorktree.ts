import type { RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";

import { checkoutWorktree } from "../sessions/launch.js";

/**
 * The worktree the Files panel shows. That is the focused one when it is ready. A folder without Git
 * has nothing to wait for, so its own checkout stands in. A folder the person picked while the
 * focused worktree was not ready stands in too, if it belongs to the same project.
 */
export function filesWorktreeFor(
  projection: Pick<RuntimeProjection, "projects" | "worktrees"> | undefined,
  focused: WorktreeProjection | undefined,
  pickedId: string | undefined,
): { worktree: WorktreeProjection | undefined; needsCheckout: boolean } {
  if (!projection || !focused || focused.status === "ready") return { worktree: focused, needsCheckout: false };
  const project = projection.projects.find((entry) => entry.projectId === focused.projectId);
  if (project?.git === false) {
    const checkout = checkoutWorktree(projection, project);
    if (checkout?.status === "ready") return { worktree: checkout, needsCheckout: false };
    return { worktree: focused, needsCheckout: !checkout };
  }
  const picked = projection.worktrees.find((entry) => entry.worktreeId === pickedId);
  if (picked?.status === "ready" && picked.projectId === focused.projectId)
    return { worktree: picked, needsCheckout: false };
  return { worktree: focused, needsCheckout: false };
}
