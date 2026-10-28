import { z } from "zod";
import { BrowserTabProjection } from "./browser.js";
import { ThreadCheckpoint } from "./checkpoints.js";
import { DevServerProjection } from "./devServers.js";
import { DesktopAppInfo, DiagnosticLog } from "./diagnostics.js";
import {
  BrowserTabId,
  EventId,
  ProjectId,
  SessionId,
  TerminalId,
  ThreadId,
  TurnId,
  WorkspaceId,
  WorktreeId,
} from "./ids.js";
import { LegacyImportPreview } from "./import.js";
import { SetupDecision, WorktreeSetupProjection } from "./projectConfig.js";
import { ProjectProjection, SupportBundleProjection, WorktreeProjection } from "./projections.js";
import {
  PermissionMode,
  ProviderCapabilities,
  ReasoningEffort,
  ThreadActivityProjection,
  ThreadAttachment,
  ThreadMessageProjection,
  ThreadProjection,
  ThreadQueuedMessage,
  ThreadRequestProjection,
  ThreadUsageRecord,
} from "./provider.js";
import { ReviewProjection } from "./review.js";
import { TerminalProjection, TerminalStatus } from "./terminal.js";

export const RuntimeEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runtime.ready") }),
  z.object({ type: z.literal("project.registered"), project: ProjectProjection }),
  z.object({ type: z.literal("project.archive.requested"), projectId: ProjectId }),
  z.object({ type: z.literal("project.archived"), projectId: ProjectId }),
  z.object({ type: z.literal("project.git.changed"), projectId: ProjectId, git: z.boolean() }),
  z.object({ type: z.literal("project.agents.changed"), projectId: ProjectId, trusted: z.boolean() }),
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
  z.object({ type: z.literal("worktree.imported"), worktree: WorktreeProjection }),
  z.object({
    type: z.literal("worktree.status.changed"),
    worktreeId: WorktreeId,
    status: WorktreeProjection.shape.status,
    errorMessage: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("worktree.branch.changed"), worktreeId: WorktreeId, branch: z.string().min(1) }),
  z.object({ type: z.literal("worktree.removed"), worktreeId: WorktreeId }),
  z.object({ type: z.literal("worktree.archived"), worktreeId: WorktreeId }),
  z.object({
    type: z.literal("worktree.remove.requested"),
    worktreeId: WorktreeId,
    force: z.boolean(),
    deleteBranch: z.boolean().optional(),
  }),
  z.object({ type: z.literal("worktree.archive.requested"), worktreeId: WorktreeId }),
  z.object({
    type: z.literal("terminal.create.requested"),
    terminal: TerminalProjection,
    cwd: z.string().min(1),
    worktreePath: z.string().min(1).optional(),
    shell: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    args: z.array(z.string().max(8_000)).max(16).optional(),
  }),
  z.object({ type: z.literal("terminal.write.requested"), terminalId: TerminalId, data: z.string() }),
  z.object({
    type: z.literal("terminal.resize.requested"),
    terminalId: TerminalId,
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({ type: z.literal("terminal.stop.requested"), terminalId: TerminalId }),
  z.object({
    type: z.literal("thread.start.requested"),
    thread: ThreadProjection,
    cwd: z.string().min(1),
    /** Present only when the caller confirmed sharing a worktree that already has a live agent. */
    shareWorktree: z.literal(true).optional(),
  }),
  z.object({
    type: z.literal("thread.send.requested"),
    threadId: ThreadId,
    text: z.string(),
    model: z.string().min(1).optional(),
    reasoningEffort: ReasoningEffort.optional(),
    permissionMode: PermissionMode.optional(),
    attachments: z.array(ThreadAttachment).max(8).optional(),
  }),
  z.object({ type: z.literal("thread.queued"), message: ThreadQueuedMessage }),
  z.object({ type: z.literal("thread.usage.recorded"), record: ThreadUsageRecord }),
  z.object({ type: z.literal("thread.checkpoint.recorded"), checkpoint: ThreadCheckpoint }),
  z.object({ type: z.literal("thread.queue.removed"), threadId: ThreadId, queueId: z.string().min(1).max(200) }),
  z.object({ type: z.literal("thread.queue.prioritized"), threadId: ThreadId, queueId: z.string().min(1).max(200) }),
  z.object({
    type: z.literal("thread.a2a.delivered"),
    projectId: ProjectId,
    message: ThreadMessageProjection,
  }),
  z.object({ type: z.literal("thread.interrupt.requested"), threadId: ThreadId, turnId: TurnId.optional() }),
  z.object({ type: z.literal("thread.stop.requested"), threadId: ThreadId }),
  /** A message reached an ended chat that knows its agent's conversation id, so the agent is started again on it. */
  z.object({ type: z.literal("thread.resume.requested"), threadId: ThreadId, cwd: z.string().min(1) }),
  z.object({
    type: z.literal("session.deleted"),
    sessionId: SessionId,
    terminalIds: z.array(TerminalId),
    threadIds: z.array(ThreadId),
  }),
  z.object({
    type: z.literal("thread.status.changed"),
    threadId: ThreadId,
    status: ThreadProjection.shape.status,
    turnId: TurnId.optional(),
    capabilities: ProviderCapabilities.optional(),
    errorMessage: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("thread.message.appended"), message: ThreadMessageProjection }),
  z.object({
    type: z.literal("thread.provider-session.recorded"),
    threadId: ThreadId,
    providerSessionId: ThreadProjection.shape.providerSessionId.unwrap(),
  }),
  z.object({ type: z.literal("thread.request.requested"), request: ThreadRequestProjection }),
  z.object({ type: z.literal("thread.activity.updated"), activity: ThreadActivityProjection }),
  z.object({ type: z.literal("thread.request.resolved"), threadId: ThreadId, requestId: z.string().min(1) }),
  z.object({
    type: z.literal("thread.respond.requested"),
    threadId: ThreadId,
    requestId: z.string().min(1),
    decision: z.unknown(),
  }),
  z.object({
    type: z.literal("thread.user-input.requested"),
    threadId: ThreadId,
    requestId: z.string().min(1),
    answers: z.record(z.string(), z.string()),
  }),
  z.object({ type: z.literal("browser.updated"), tab: BrowserTabProjection }),
  z.object({ type: z.literal("browser.closed"), browserTabId: BrowserTabId }),
  z.object({ type: z.literal("review.refresh.requested"), worktreeId: WorktreeId, baseRef: z.string().min(1) }),
  z.object({ type: z.literal("review.diff.requested"), worktreeId: WorktreeId, path: z.string().min(1).max(4_000) }),
  z.object({
    type: z.literal("review.commit.requested"),
    worktreeId: WorktreeId,
    message: z.string().min(1).max(10_000),
  }),
  z.object({ type: z.literal("review.merge.requested"), worktreeId: WorktreeId, targetRef: z.string().min(1) }),
  z.object({ type: z.literal("review.abortMerge.requested"), worktreeId: WorktreeId }),
  z.object({ type: z.literal("review.updated"), review: ReviewProjection }),
  z.object({ type: z.literal("review.archived"), worktreeId: WorktreeId }),
  z.object({
    type: z.literal("diagnostics.bundle.requested"),
    destinationPath: z.string().min(1),
    allowedRoot: z.string().min(1).optional(),
    desktopLogs: z.array(DiagnosticLog).optional(),
    desktopApp: DesktopAppInfo.optional(),
  }),
  z.object({ type: z.literal("diagnostics.bundle.created"), bundle: SupportBundleProjection }),
  z.object({ type: z.literal("diagnostics.bundle.failed"), message: z.string().min(1) }),
  z.object({ type: z.literal("legacy.scan.requested"), batchId: z.string().min(1), snapshotPath: z.string().min(1) }),
  z.object({ type: z.literal("legacy.scan.completed"), preview: LegacyImportPreview }),
  z.object({
    type: z.literal("legacy.import.requested"),
    batchId: z.string().min(1),
    selectedRecordIds: z.array(z.string().min(1)),
  }),
  z.object({
    type: z.literal("legacy.import.completed"),
    batchId: z.string().min(1),
    importedProjectIds: z.array(ProjectId),
    importedWorktreeIds: z.array(WorktreeId),
  }),
  z.object({ type: z.literal("legacy.rollback.requested"), batchId: z.string().min(1) }),
  z.object({ type: z.literal("legacy.rollback.completed"), batchId: z.string().min(1) }),
  z.object({ type: z.literal("legacy.operation.failed"), batchId: z.string().min(1), message: z.string().min(1) }),
  z.object({
    type: z.literal("terminal.status.changed"),
    terminalId: TerminalId,
    status: TerminalStatus,
    lastSequence: z.number().int().nonnegative().optional(),
    errorMessage: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("devserver.detected"), devServer: DevServerProjection.omit({ detectedAt: true }) }),
  z.object({
    type: z.literal("devserver.stopped"),
    terminalId: TerminalId,
    port: DevServerProjection.shape.port,
  }),
  z.object({ type: z.literal("worktree.setup.changed"), setup: WorktreeSetupProjection }),
  z.object({
    type: z.literal("worktree.setup.responded"),
    worktreeId: WorktreeId,
    commandsHash: z.string().min(1),
    decision: SetupDecision,
  }),
  z.object({ type: z.literal("project.setup.trusted"), projectId: ProjectId, commandsHash: z.string().min(1) }),
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
