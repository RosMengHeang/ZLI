import { z } from "zod";

import { WorktreeId } from "./ids.js";

export const ReviewFileProjection = z.object({
  path: z.string().min(1),
  oldPath: z.string().min(1).optional(),
  kind: z.enum(["added", "modified", "deleted", "renamed", "untracked"]),
  staged: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
});
export type ReviewFileProjection = z.infer<typeof ReviewFileProjection>;

export const ReviewProjection = z.object({
  worktreeId: WorktreeId,
  baseRef: z.string().min(1),
  branch: z.string().min(1),
  state: z.enum(["clean", "changes", "conflicted"]),
  files: z.array(ReviewFileProjection),
  conflictFiles: z.array(z.string().min(1)),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ReviewProjection = z.infer<typeof ReviewProjection>;
