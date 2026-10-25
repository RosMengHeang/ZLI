import { z } from "zod";

import { WorktreeId } from "./ids.js";

export const ReviewFileProjection = z.object({
  path: z.string().min(1),
  oldPath: z.string().min(1).optional(),
  kind: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
  /** The index differs from HEAD for this file. */
  staged: z.boolean(),
  /** The working tree differs from the index, or Git does not track the file yet. */
  unstaged: z.boolean().optional(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
});
export type ReviewFileProjection = z.infer<typeof ReviewFileProjection>;

export const ReviewDiffProjection = z.object({
  path: z.string().min(1),
  oldPath: z.string().min(1).optional(),
  binary: z.boolean(),
  patch: z.string().max(200_000),
  truncated: z.boolean(),
  /**
   * For a tracked file with uncommitted changes, the diff split the way Git stages it: HEAD against the index, and
   * the index against the working tree. Hunks of these can be staged one at a time. Absent when either is too long.
   */
  stagedPatch: z.string().max(200_000).optional(),
  unstagedPatch: z.string().max(200_000).optional(),
  generatedAt: z.string().datetime({ offset: true }),
});
export type ReviewDiffProjection = z.infer<typeof ReviewDiffProjection>;

export const ReviewProjection = z.object({
  worktreeId: WorktreeId,
  baseRef: z.string().min(1),
  branch: z.string().min(1),
  state: z.enum(["clean", "changes", "conflicted"]),
  files: z.array(ReviewFileProjection),
  conflictFiles: z.array(z.string().min(1)),
  diff: ReviewDiffProjection.optional(),
  errorMessage: z.string().min(1).optional(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ReviewProjection = z.infer<typeof ReviewProjection>;
