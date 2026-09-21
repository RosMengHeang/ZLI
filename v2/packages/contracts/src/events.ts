import { z } from "zod";

import { BrowserTabId, EventId, TerminalId, ThreadId, TurnId, WorktreeId, WorkspaceId } from "./ids.js";
import { BrowserTabProjection } from "./browser.js";
import { ProjectProjection, WorktreeProjection } from "./projections.js";
import { ProviderCapabilities, ThreadMessageProjection, ThreadProjection } from "./provider.js";
import { TerminalProjection, TerminalStatus } from "./terminal.js";
import { ReviewProjection } from "./review.js";

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
  z.object({
    type: z.literal("terminal.create.requested"),
    terminal: TerminalProjection,
    cwd: z.string().min(1),
    shell: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({ type: z.literal("terminal.write.requested"), terminalId: TerminalId, data: z.string() }),
  z.object({
    type: z.literal("terminal.resize.requested"),
    terminalId: TerminalId,
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({ type: z.literal("terminal.stop.requested"), terminalId: TerminalId }),
  z.object({ type: z.literal("thread.start.requested"), thread: ThreadProjection, cwd: z.string().min(1) }),
  z.object({ type: z.literal("thread.send.requested"), threadId: ThreadId, text: z.string(), model: z.string().min(1).optional() }),
  z.object({ type: z.literal("thread.interrupt.requested"), threadId: ThreadId, turnId: TurnId.optional() }),
  z.object({ type: z.literal("thread.stop.requested"), threadId: ThreadId }),
  z.object({ type: z.literal("thread.status.changed"), threadId: ThreadId, status: ThreadProjection.shape.status, turnId: TurnId.optional(), capabilities: ProviderCapabilities.optional(), errorMessage: z.string().min(1).optional() }),
  z.object({ type: z.literal("thread.message.appended"), message: ThreadMessageProjection }),
  z.object({ type: z.literal("browser.updated"), tab: BrowserTabProjection }),
  z.object({ type: z.literal("browser.closed"), browserTabId: BrowserTabId }),
  z.object({ type: z.literal("review.refresh.requested"), worktreeId: WorktreeId, baseRef: z.string().min(1) }),
  z.object({ type: z.literal("review.commit.requested"), worktreeId: WorktreeId, message: z.string().min(1).max(10_000) }),
  z.object({ type: z.literal("review.merge.requested"), worktreeId: WorktreeId, targetRef: z.string().min(1) }),
  z.object({ type: z.literal("review.abortMerge.requested"), worktreeId: WorktreeId }),
  z.object({ type: z.literal("review.updated"), review: ReviewProjection }),
  z.object({ type: z.literal("review.archived"), worktreeId: WorktreeId }),
  z.object({
    type: z.literal("terminal.status.changed"),
    terminalId: TerminalId,
    status: TerminalStatus,
    lastSequence: z.number().int().nonnegative().optional(),
    errorMessage: z.string().min(1).optional(),
  }),
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
