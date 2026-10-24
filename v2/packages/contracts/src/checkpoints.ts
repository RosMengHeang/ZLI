import { z } from "zod";

import { ThreadId, WorktreeId } from "./ids.js";

const TreeId = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/u);
const RelativePath = z.string().min(1).max(4_000);

export const TurnCheckpointFile = z.object({
  path: RelativePath,
  oldPath: RelativePath.optional(),
  kind: z.enum(["added", "modified", "deleted", "renamed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  binary: z.boolean(),
});
export type TurnCheckpointFile = z.infer<typeof TurnCheckpointFile>;

export const MAX_CHECKPOINT_FILES = 300;

/**
 * The worktree's files before and after one agent turn, saved as Git trees. Only turns that
 * changed something are recorded. Other agents in the same worktree can contribute changes too.
 */
export const ThreadCheckpoint = z.object({
  checkpointId: z.string().uuid(),
  threadId: ThreadId,
  worktreeId: WorktreeId,
  turnId: z.string().min(1).max(200),
  startTree: TreeId,
  endTree: TreeId,
  /** The first MAX_CHECKPOINT_FILES changed files; fileCount has the full number. */
  files: z.array(TurnCheckpointFile).max(MAX_CHECKPOINT_FILES),
  fileCount: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  recordedAt: z.string().datetime({ offset: true }).optional(),
});
export type ThreadCheckpoint = z.infer<typeof ThreadCheckpoint>;

/** Handled directly by the runtime server; none of these reach the event log. */
export const CheckpointCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("checkpoint.diff"), checkpointId: z.string().uuid(), path: RelativePath }),
  /** Puts the worktree's files back to how they were when the turn started. */
  z.object({ type: z.literal("checkpoint.restore"), checkpointId: z.string().uuid() }),
  /**
   * Makes a fresh worktree's files match another worktree's current files, or the files as they were
   * before a saved turn. Best-of-N runs use it so every run starts from the same state.
   */
  z.object({
    type: z.literal("checkpoint.fork"),
    worktreeId: WorktreeId,
    from: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("worktree"), worktreeId: WorktreeId }),
      z.object({ kind: z.literal("checkpoint"), checkpointId: z.string().uuid() }),
    ]),
  }),
]);
export type CheckpointCommand = z.infer<typeof CheckpointCommand>;
export const CHECKPOINT_COMMAND_TYPES = ["checkpoint.diff", "checkpoint.restore", "checkpoint.fork"] as const;

export const CheckpointDiffResult = z.object({
  path: RelativePath,
  oldPath: RelativePath.optional(),
  binary: z.boolean(),
  patch: z.string().max(200_000),
  truncated: z.boolean(),
});
export type CheckpointDiffResult = z.infer<typeof CheckpointDiffResult>;

export const CheckpointRestoreResult = z.object({
  /** Files written or deleted to match the turn's starting point. */
  changedFiles: z.number().int().nonnegative(),
});
export type CheckpointRestoreResult = z.infer<typeof CheckpointRestoreResult>;

export const CheckpointForkResult = z.object({
  /** Files written or deleted in the new worktree. */
  changedFiles: z.number().int().nonnegative(),
});
export type CheckpointForkResult = z.infer<typeof CheckpointForkResult>;
