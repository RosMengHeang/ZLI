import {
  type ProjectProjection,
  type RuntimeProjection,
  type WorktreeProjection,
  worktreeHasLiveThread,
} from "@zli-v2/contracts";

import { guestBranchName } from "../chat/guestWork.js";
import { type ChatPlace, samePath, worktreeOnBranch } from "./launch.js";

/**
 * Where a chat goes when the person picks a branch or folder for it:
 * - `use`: a folder ZLI already has on that branch.
 * - `project`: the project's own folder, which has the branch but is not in ZLI yet.
 * - `checkout`: a new worktree that checks the branch out, since no folder has it.
 */
export type BranchTarget =
  | { kind: "use"; worktree: WorktreeProjection }
  | { kind: "project" }
  | { kind: "checkout"; branch: string }
  | { kind: "error"; message: string };

export function branchTarget(
  projection: Pick<RuntimeProjection, "worktrees">,
  project: Pick<ProjectProjection, "projectId" | "path">,
  place: ChatPlace,
): BranchTarget {
  if (place.kind === "project") return { kind: "error", message: "A chat that started stays in its project." };
  if (place.kind === "worktree") {
    const worktree = projection.worktrees.find((entry) => entry.worktreeId === place.worktreeId);
    return worktree ? { kind: "use", worktree } : { kind: "error", message: "That folder is gone." };
  }
  const open = worktreeOnBranch(projection, project.projectId, place.branch);
  if (open) return { kind: "use", worktree: open };
  if (!place.path) return { kind: "checkout", branch: place.branch };
  const known = projection.worktrees.find(
    (entry) => entry.projectId === project.projectId && samePath(entry.path, place.path ?? ""),
  );
  if (known) return { kind: "use", worktree: known };
  if (samePath(place.path, project.path)) return { kind: "project" };
  return {
    kind: "error",
    message: `${place.branch} is checked out in ${place.path}, a folder ZLI does not manage. Open that folder as a project to work there.`,
  };
}

/** Another agent works in the folder: a chat or an agent CLI that is still running there. */
export function folderBusy(projection: Pick<RuntimeProjection, "threads" | "terminals">, worktreeId: string): boolean {
  return (
    worktreeHasLiveThread(projection.threads, worktreeId) ||
    projection.terminals.some(
      (terminal) => terminal.worktreeId === worktreeId && terminal.kind === "agent" && terminal.status === "running",
    )
  );
}

/**
 * The new branch for a chat that moves to a folder another agent works in. The chat gets its own worktree
 * on this branch, made from the folder's branch, so the two never change the same files.
 */
export function chatBranchName(from: string, projection: Pick<RuntimeProjection, "worktrees">): string {
  return guestBranchName(
    from,
    "chat",
    projection.worktrees.map((entry) => entry.branch),
  );
}
