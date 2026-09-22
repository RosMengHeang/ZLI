import { z } from "zod";

import { BrowserTabId, CommandId, EnvironmentId, ProjectId, TerminalId, ThreadId, TurnId, WorktreeId } from "./ids.js";
import { RuntimeEventEnvelope } from "./events.js";
import {
  EnvironmentDescriptor,
  RuntimeProjection,
  WorktreeProjection,
  SupportBundleProjection,
} from "./projections.js";
import { TerminalAttachSnapshot, TerminalProjection, TerminalStreamMessage } from "./terminal.js";
import { ReviewProjection } from "./review.js";
import { BrowserTabProjection } from "./browser.js";
import {
  ProviderCapabilities,
  ProviderKind,
  ThreadMessageProjection,
  ThreadProjection,
  ThreadRequestProjection,
} from "./provider.js";
import { LegacyImportPreview } from "./import.js";
import { DiagnosticLog } from "./diagnostics.js";

export const RUNTIME_PROTOCOL_VERSION = 1 as const;

export const RuntimeCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project.register"), path: z.string().min(1) }),
  z.object({ type: z.literal("project.archive"), projectId: ProjectId }),
  z.object({
    type: z.literal("worktree.create"),
    worktreeId: WorktreeId,
    projectId: ProjectId,
    path: z.string().min(1),
    workspaceRoot: z.string().min(1),
    branch: z.string().min(1),
    baseRef: z.string().min(1).optional(),
    checkoutExistingBranch: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("worktree.import"),
    worktreeId: WorktreeId,
    projectId: ProjectId,
    path: z.string().min(1),
    branch: z.string().min(1),
  }),
  z.object({ type: z.literal("worktree.cancel"), worktreeId: WorktreeId }),
  z.object({ type: z.literal("worktree.retry"), worktreeId: WorktreeId }),
  z.object({ type: z.literal("worktree.remove"), worktreeId: WorktreeId, force: z.boolean().optional() }),
  z.object({ type: z.literal("worktree.archive"), worktreeId: WorktreeId }),
  z.object({ type: z.literal("worktree.removed"), worktreeId: WorktreeId }),
  z.object({ type: z.literal("worktree.archived"), worktreeId: WorktreeId }),
  z.object({
    type: z.literal("worktree.status"),
    worktreeId: WorktreeId,
    status: WorktreeProjection.shape.status,
    errorMessage: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("terminal.create"),
    terminalId: TerminalId,
    worktreeId: WorktreeId,
    cwd: z.string().min(1),
    shell: z.string().min(1),
    title: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({ type: z.literal("terminal.write"), terminalId: TerminalId, data: z.string() }),
  z.object({
    type: z.literal("terminal.resize"),
    terminalId: TerminalId,
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("terminal.attach"),
    terminalId: TerminalId,
    afterSequence: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("terminal.stop"), terminalId: TerminalId }),
  z.object({ type: z.literal("terminal.list") }),
  z.object({ type: z.literal("browser.updated"), tab: BrowserTabProjection }),
  z.object({ type: z.literal("browser.closed"), browserTabId: BrowserTabId }),
  z.object({
    type: z.literal("thread.start"),
    threadId: ThreadId,
    worktreeId: WorktreeId,
    provider: ProviderKind,
    cwd: z.string().min(1),
  }),
  z.object({
    type: z.literal("thread.send"),
    threadId: ThreadId,
    text: z.string(),
    model: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("thread.interrupt"), threadId: ThreadId, turnId: TurnId.optional() }),
  z.object({ type: z.literal("thread.stop"), threadId: ThreadId }),
  z.object({
    type: z.literal("thread.status"),
    threadId: ThreadId,
    status: ThreadProjection.shape.status,
    turnId: TurnId.optional(),
    capabilities: ProviderCapabilities.optional(),
    errorMessage: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("thread.message"), message: ThreadMessageProjection }),
  z.object({ type: z.literal("thread.request"), request: ThreadRequestProjection }),
  z.object({ type: z.literal("thread.request.resolved"), threadId: ThreadId, requestId: z.string().min(1) }),
  z.object({
    type: z.literal("thread.respond"),
    threadId: ThreadId,
    requestId: z.string().min(1),
    decision: z.unknown(),
  }),
  z.object({
    type: z.literal("thread.user-input"),
    threadId: ThreadId,
    requestId: z.string().min(1),
    answers: z.record(z.string(), z.string()),
  }),
  z.object({
    type: z.literal("terminal.status"),
    terminalId: TerminalId,
    status: TerminalProjection.shape.status,
    lastSequence: z.number().int().nonnegative().optional(),
    errorMessage: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("runtime.subscribe"), afterSequence: z.number().int().nonnegative() }),
  z.object({ type: z.literal("runtime.getProjection") }),
  z.object({ type: z.literal("review.refresh"), worktreeId: WorktreeId, baseRef: z.string().min(1) }),
  z.object({ type: z.literal("review.diff"), worktreeId: WorktreeId, path: z.string().min(1).max(4_000) }),
  z.object({ type: z.literal("review.commit"), worktreeId: WorktreeId, message: z.string().min(1).max(10_000) }),
  z.object({ type: z.literal("review.merge"), worktreeId: WorktreeId, targetRef: z.string().min(1) }),
  z.object({ type: z.literal("review.abortMerge"), worktreeId: WorktreeId }),
  z.object({ type: z.literal("review.archive"), worktreeId: WorktreeId }),
  z.object({ type: z.literal("review.updated"), review: ReviewProjection }),
  z.object({
    type: z.literal("diagnostics.createSupportBundle"),
    destinationPath: z.string().min(1),
    desktopLogs: z.array(DiagnosticLog).optional(),
  }),
  z.object({ type: z.literal("diagnostics.bundle.created"), bundle: SupportBundleProjection }),
  z.object({ type: z.literal("diagnostics.bundle.failed"), message: z.string().min(1) }),
  z.object({ type: z.literal("legacy.scan"), batchId: z.string().min(1), snapshotPath: z.string().min(1) }),
  z.object({ type: z.literal("legacy.scan.completed"), preview: LegacyImportPreview }),
  z.object({
    type: z.literal("legacy.import"),
    batchId: z.string().min(1),
    selectedRecordIds: z.array(z.string().min(1)),
  }),
  z.object({
    type: z.literal("legacy.import.completed"),
    batchId: z.string().min(1),
    importedProjectIds: z.array(ProjectId),
    importedWorktreeIds: z.array(WorktreeId),
  }),
  z.object({ type: z.literal("legacy.rollbackImport"), batchId: z.string().min(1) }),
  z.object({ type: z.literal("legacy.rollback.completed"), batchId: z.string().min(1) }),
  z.object({ type: z.literal("legacy.operation.failed"), batchId: z.string().min(1), message: z.string().min(1) }),
]);
export type RuntimeCommand = z.infer<typeof RuntimeCommand>;

export const RpcRequest = z.object({
  protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
  commandId: CommandId,
  command: RuntimeCommand,
});
export type RpcRequest = z.infer<typeof RpcRequest>;

export const RuntimeError = z.object({
  code: z.enum([
    "invalid_request",
    "unauthorized",
    "protocol_mismatch",
    "environment_mismatch",
    "unavailable",
    "internal",
  ]),
  message: z.string(),
  retryable: z.boolean(),
});
export type RuntimeError = z.infer<typeof RuntimeError>;

export const RpcResponse = z.discriminatedUnion("accepted", [
  z.object({
    commandId: CommandId,
    accepted: z.literal(true),
    result: z.unknown().optional(),
  }),
  z.object({
    commandId: CommandId,
    accepted: z.literal(false),
    error: RuntimeError,
  }),
]);
export type RpcResponse = z.infer<typeof RpcResponse>;

export const ClientWireMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    token: z.string().min(1),
    environmentId: EnvironmentId,
  }),
  z.object({ type: z.literal("command"), request: RpcRequest }),
  z.object({ type: z.literal("subscribe"), afterSequence: z.number().int().nonnegative() }),
  z.object({ type: z.literal("projection.get") }),
  z.object({
    type: z.literal("terminal.attach"),
    terminalId: TerminalId,
    afterSequence: z.number().int().nonnegative(),
  }),
]);
export type ClientWireMessage = z.infer<typeof ClientWireMessage>;

export const ServerWireMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    environment: EnvironmentDescriptor,
  }),
  z.object({ type: z.literal("response"), response: RpcResponse }),
  z.object({ type: z.literal("event"), envelope: RuntimeEventEnvelope }),
  z.object({ type: z.literal("projection"), projection: RuntimeProjection }),
  z.object({ type: z.literal("terminal.snapshot"), snapshot: TerminalAttachSnapshot }),
  z.object({ type: z.literal("terminal.stream"), message: TerminalStreamMessage }),
  z.object({ type: z.literal("error"), error: RuntimeError }),
]);
export type ServerWireMessage = z.infer<typeof ServerWireMessage>;

export const ProjectRegisterResult = z.object({ projectId: ProjectId });
export type ProjectRegisterResult = z.infer<typeof ProjectRegisterResult>;
