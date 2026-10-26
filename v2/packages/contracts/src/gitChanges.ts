import { z } from "zod";

import { WorktreeId } from "./ids.js";

/** A path relative to the worktree, as the Changes list shows it. The server checks it again before Git sees it. */
const ChangePath = z.string().min(1).max(4_096);
const StashIndex = z.number().int().nonnegative().max(10_000);
const CommitSha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);

export const GitHunkAction = z.enum(["stage", "unstage", "discard"]);
export type GitHunkAction = z.infer<typeof GitHunkAction>;

export const GitStashAction = z.enum(["apply", "pop", "drop"]);
export type GitStashAction = z.infer<typeof GitStashAction>;

/** Staging, discarding, and stashing in a worktree. Handled directly by the runtime server, outside the event log. */
export const GitChangesCommand = z.discriminatedUnion("type", [
  /** Stages the files, including deletions and new files; without `paths`, every change in the worktree. */
  z.object({
    type: z.literal("review.git.stage"),
    worktreeId: WorktreeId,
    paths: z.array(ChangePath).min(1).max(500).optional(),
  }),
  /** Moves staged changes back to the working tree; without `paths`, everything staged. */
  z.object({
    type: z.literal("review.git.unstage"),
    worktreeId: WorktreeId,
    paths: z.array(ChangePath).min(1).max(500).optional(),
  }),
  /** Throws away a file's staged and unstaged changes, or deletes it when Git does not track it. */
  z.object({ type: z.literal("review.git.discard"), worktreeId: WorktreeId, path: ChangePath }),
  /**
   * Applies one hunk of a file's diff. Stage and discard take hunks of the unstaged diff, unstage takes hunks of the
   * staged diff. `hunk` is the hunk as shown, from its `@@` line on, so a diff that changed since is refused.
   */
  z.object({
    type: z.literal("review.git.hunk"),
    worktreeId: WorktreeId,
    path: ChangePath,
    action: GitHunkAction,
    index: z.number().int().nonnegative().max(100_000),
    hunk: z.string().min(1).max(200_000),
  }),
  z.object({ type: z.literal("review.git.stashList"), worktreeId: WorktreeId }),
  /** Stashes every change in the worktree, untracked files included. */
  z.object({
    type: z.literal("review.git.stash"),
    worktreeId: WorktreeId,
    message: z.string().max(500).optional(),
  }),
  /** `commit` pins the stash the person saw, because indexes move when another stash is added or dropped. */
  z.object({
    type: z.literal("review.git.stashAction"),
    worktreeId: WorktreeId,
    action: GitStashAction,
    index: StashIndex,
    commit: CommitSha,
  }),
]);
export type GitChangesCommand = z.infer<typeof GitChangesCommand>;
export const GIT_CHANGES_COMMAND_TYPES = [
  "review.git.stage",
  "review.git.unstage",
  "review.git.discard",
  "review.git.hunk",
  "review.git.stashList",
  "review.git.stash",
  "review.git.stashAction",
] as const;

export const GitChangeResult = z.object({ ok: z.literal(true) });
export type GitChangeResult = z.infer<typeof GitChangeResult>;

export const GitStash = z.object({
  index: StashIndex,
  commit: CommitSha,
  /** The branch the stash was made on, when Git recorded one. */
  branch: z.string().min(1).max(255).optional(),
  message: z.string().max(1_000),
  createdAt: z.string().max(40).optional(),
});
export type GitStash = z.infer<typeof GitStash>;

/** Stashes belong to the repository, so every worktree of it sees the same list. */
export const GitStashListResult = z.object({ stashes: z.array(GitStash).max(200) });
export type GitStashListResult = z.infer<typeof GitStashListResult>;

export const GitStashResult = z.object({
  stashes: z.array(GitStash).max(200),
  /** False when there was nothing to stash. */
  created: z.boolean().optional(),
  /** True when applying left conflicts in the working tree; a popped stash is then kept. */
  conflicted: z.boolean().optional(),
});
export type GitStashResult = z.infer<typeof GitStashResult>;
