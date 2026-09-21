import { z } from "zod";

import { EventId, WorktreeId, WorkspaceId } from "./ids.js";
import { ProjectProjection, WorktreeProjection } from "./projections.js";

export const RuntimeEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runtime.ready") }),
  z.object({ type: z.literal("project.registered"), project: ProjectProjection }),
  z.object({
    type: z.literal("runtime.reactor.failed"),
    reactor: z.string().min(1),
    message: z.string().min(1),
  }),
  z.object({
    type: z.literal("worktree.create.requested"),
    worktree: WorktreeProjection,
    workspaceRoot: z.string().min(1),
    baseRef: z.string().min(1).optional(),
    checkoutExistingBranch: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("worktree.status.changed"),
    worktreeId: WorktreeId,
    status: WorktreeProjection.shape.status,
    errorMessage: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("worktree.removed"), worktreeId: WorktreeId }),
  z.object({ type: z.literal("worktree.archived"), worktreeId: WorktreeId }),
  z.object({
    type: z.literal("worktree.remove.requested"),
    worktreeId: WorktreeId,
    force: z.boolean(),
  }),
  z.object({ type: z.literal("worktree.archive.requested"), worktreeId: WorktreeId }),
]);
export type RuntimeEvent = z.infer<typeof RuntimeEvent>;

export const RuntimeEventEnvelope = z.object({
  protocolVersion: z.literal(1),
  sequence: z.number().int().positive(),
  eventId: EventId,
  workspaceId: WorkspaceId.optional(),
  occurredAt: z.string().datetime({ offset: true }),
  event: RuntimeEvent,
});
export type RuntimeEventEnvelope = z.infer<typeof RuntimeEventEnvelope>;
