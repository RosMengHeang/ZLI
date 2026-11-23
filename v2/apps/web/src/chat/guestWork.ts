import type { PermissionMode } from "@zli-v2/contracts";

import { safeBranchName } from "../sessions/launch.js";

/**
 * How an agent joins a chat. Ask keeps it in the chat's folder with read-only access, to review and answer.
 * Work gives it its own worktree on a new branch copied from the chat's branch, to merge or discard later.
 */
export type GuestMode = "ask" | "work";

export const guestModeLabel: Record<GuestMode, string> = { ask: "Ask", work: "Work" };

export const guestModeHint: Record<GuestMode, string> = {
  ask: "Reads and answers in this folder. Can't edit files.",
  work: "Works on its own copy of this branch. You merge or discard its changes.",
};

/** The access an agent joins with: read-only to ask, else what was asked for, the chat's own, or full access. */
export function guestPermission(
  mode: GuestMode,
  requested: PermissionMode | undefined,
  host: PermissionMode | undefined,
): PermissionMode {
  if (mode === "ask") return "read-only";
  return requested ?? host ?? "full-access";
}

/** The new branch a Work agent gets: the chat's branch and the agent's name, made unique among `taken`. */
export function guestBranchName(branch: string, name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((entry) => entry.toLowerCase()));
  const slug = safeBranchName(name.toLowerCase().replace(/\s+/gu, "-")) || "agent";
  const base = `${safeBranchName(branch) || "work"}-${slug}`;
  if (!used.has(base.toLowerCase())) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The mode of an agent already in the chat: Work when it runs in another worktree than the chat's, Ask when it
 * runs read-only in the same one. Agents brought in before the modes existed have none.
 */
export function guestModeOf(
  guest: { worktreeId: string; permissionMode?: PermissionMode | undefined },
  hostWorktreeId: string,
): GuestMode | undefined {
  if (guest.worktreeId !== hostWorktreeId) return "work";
  return guest.permissionMode === "read-only" ? "ask" : undefined;
}

/** Merges a Work agent's branch into the chat's branch, committing what it left uncommitted first. */
export function guestMergeCommand(input: { worktreeId: string; targetBranch: string; name: string }) {
  return {
    type: "review.merge",
    worktreeId: input.worktreeId,
    targetRef: input.targetBranch,
    commitMessage: `Work from ${input.name}`,
  } as const;
}

/** Removes a Work agent's worktree and its branch, unmerged commits and all. */
export function guestDiscardCommand(worktreeId: string) {
  return { type: "worktree.remove", worktreeId, force: true, deleteBranch: true } as const;
}
