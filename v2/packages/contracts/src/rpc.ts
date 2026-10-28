import { z } from "zod";
import { AccountCommand } from "./accounts.js";
import { AgentName, StartedBy } from "./agentName.js";
import { BrowserTabProjection } from "./browser.js";
import { CheckpointCommand, ThreadCheckpoint } from "./checkpoints.js";
import { DevServerProjection } from "./devServers.js";
import { DesktopAppInfo, DiagnosticLog } from "./diagnostics.js";
import { RuntimeEventEnvelope } from "./events.js";
import { FileCommand } from "./files.js";
import { GitChangesCommand } from "./gitChanges.js";
import {
  AccountId,
  BrowserTabId,
  CommandId,
  EnvironmentId,
  ProjectId,
  SessionId,
  TerminalId,
  ThreadId,
  TurnId,
  WorktreeId,
} from "./ids.js";
import { LegacyImportPreview } from "./import.js";
import { IssueCommand } from "./issues.js";
import { LimitsCommand } from "./limits.js";
import { McpCommand } from "./mcp.js";
import { PluginCommand } from "./plugins.js";
import { SetupDecision, WorktreeSetupProjection } from "./projectConfig.js";
import {
  EnvironmentDescriptor,
  RuntimeProjection,
  SupportBundleProjection,
  WorktreeProjection,
} from "./projections.js";
import {
  PermissionMode,
  ProviderCapabilities,
  ProviderKind,
  ReasoningEffort,
  ThreadActivityProjection,
  ThreadAttachmentUpload,
  ThreadMessageProjection,
  ThreadProjection,
  ThreadRequestProjection,
  TurnUsage,
} from "./provider.js";
import { PullRequestCommand } from "./pullRequest.js";
import { ReviewProjection } from "./review.js";
import { SkillCommand } from "./skills.js";
import { TerminalAgentLaunch, TerminalAttachSnapshot, TerminalProjection, TerminalStreamMessage } from "./terminal.js";

export const RUNTIME_PROTOCOL_VERSION = 1 as const;

export const RuntimeCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project.register"), path: z.string().min(1) }),
  z.object({ type: z.literal("project.archive"), projectId: ProjectId }),
  z.object({ type: z.literal("project.git"), projectId: ProjectId, git: z.boolean() }),
  z.object({ type: z.literal("project.rename"), projectId: ProjectId, name: z.string().trim().min(1) }),
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
    kind: WorktreeProjection.shape.kind,
  }),
  z.object({ type: z.literal("worktree.cancel"), worktreeId: WorktreeId }),
  z.object({ type: z.literal("worktree.retry"), worktreeId: WorktreeId }),
  z.object({
    type: z.literal("worktree.remove"),
    worktreeId: WorktreeId,
    force: z.boolean().optional(),
    /** Also deletes the worktree's branch. With `force`, a branch with unmerged commits is deleted too. */
    deleteBranch: z.boolean().optional(),
  }),
  z.object({ type: z.literal("worktree.archive"), worktreeId: WorktreeId }),
  z.object({ type: z.literal("worktree.removed"), worktreeId: WorktreeId }),
  z.object({ type: z.literal("worktree.archived"), worktreeId: WorktreeId }),
  z.object({
    type: z.literal("worktree.status"),
    worktreeId: WorktreeId,
    status: WorktreeProjection.shape.status,
    errorMessage: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  }),
  /** Records the branch now checked out in the worktree, after it was switched or renamed. */
  z.object({ type: z.literal("worktree.branch"), worktreeId: WorktreeId, branch: z.string().min(1).max(255) }),
  z.object({
    type: z.literal("terminal.create"),
    terminalId: TerminalId,
    worktreeId: WorktreeId,
    cwd: z.string().min(1),
    shell: z.string().min(1),
    title: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
    /** Start this agent CLI instead of an interactive shell. The runtime resolves the executable. */
    agent: TerminalAgentLaunch.optional(),
    /** A name for the agent. Rejected when another agent in the project has it. */
    name: AgentName.optional(),
    /** The agent starting this one as its sub-agent. It must be an agent in the same project. */
    startedBy: StartedBy.optional(),
    sessionId: SessionId.optional(),
    /** Arguments for `shell`, so the terminal runs one command instead of an interactive shell. */
    args: z.array(z.string().max(8_000)).max(16).optional(),
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
  /** Recent output for agent tools. Answered by the server; never stored in the event log. */
  z.object({
    type: z.literal("terminal.read"),
    terminalId: TerminalId,
    maxBytes: z.number().int().min(1).max(262_144).optional(),
  }),
  z.object({ type: z.literal("terminal.stop"), terminalId: TerminalId }),
  /** Names a terminal agent, or clears its name with null. */
  z.object({ type: z.literal("terminal.rename"), terminalId: TerminalId, name: AgentName.nullable() }),
  z.object({ type: z.literal("terminal.list") }),
  z.object({ type: z.literal("browser.updated"), tab: BrowserTabProjection }),
  z.object({ type: z.literal("browser.closed"), browserTabId: BrowserTabId }),
  z.object({
    type: z.literal("thread.start"),
    threadId: ThreadId,
    worktreeId: WorktreeId,
    provider: ProviderKind,
    cwd: z.string().min(1),
    /** Explicit confirm to bind another live agent onto a worktree that already has one. */
    shareWorktree: z.boolean().optional(),
    permissionMode: PermissionMode.optional(),
    model: z.string().min(1).max(200).optional(),
    /** A name for the agent. Rejected when another agent in the project has it. */
    name: AgentName.optional(),
    /** The agent starting this one as its sub-agent. It must be an agent in the same project. */
    startedBy: StartedBy.optional(),
    sessionId: SessionId.optional(),
    /** Omitted runs the provider's default account. */
    accountId: AccountId.optional(),
  }),
  z.object({
    type: z.literal("thread.send"),
    threadId: ThreadId,
    text: z.string(),
    model: z.string().min(1).optional(),
    /** Omitted runs the turn at the agent's default level. */
    reasoningEffort: ReasoningEffort.optional(),
    /** Applies from this turn on. Only providers with permissionSwitch "in-session" accept a change. */
    permissionMode: PermissionMode.optional(),
    attachments: z.array(ThreadAttachmentUpload).max(8).optional(),
  }),
  /** Sends when the agent finishes its turn and has no open request. Sent right away when it is idle. */
  z.object({
    type: z.literal("thread.queue"),
    threadId: ThreadId,
    queueId: z.string().min(1).max(200),
    text: z.string().min(1),
    model: z.string().min(1).optional(),
    reasoningEffort: ReasoningEffort.optional(),
    permissionMode: PermissionMode.optional(),
    attachments: z.array(ThreadAttachmentUpload).max(8).optional(),
  }),
  z.object({ type: z.literal("thread.queue.remove"), threadId: ThreadId, queueId: z.string().min(1).max(200) }),
  /** Moves a queued message to the front and interrupts the running turn so it goes next. */
  z.object({ type: z.literal("thread.steer"), threadId: ThreadId, queueId: z.string().min(1).max(200) }),
  /** Internal: sends the oldest queued message if the agent is idle. */
  z.object({ type: z.literal("thread.queue.flush"), threadId: ThreadId }),
  z.object({
    type: z.literal("thread.a2a"),
    messageId: z.string().min(1).max(200),
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    text: z.string().min(1).max(8_000),
  }),
  z.object({ type: z.literal("thread.interrupt"), threadId: ThreadId, turnId: TurnId.optional() }),
  z.object({ type: z.literal("thread.stop"), threadId: ThreadId }),
  /** Names a chat agent, or clears its name with null. */
  z.object({ type: z.literal("thread.rename"), threadId: ThreadId, name: AgentName.nullable() }),
  /** Stops every terminal and thread in the session and removes them, with their history, for good. */
  z.object({ type: z.literal("session.delete"), sessionId: SessionId }),
  z.object({
    type: z.literal("thread.status"),
    threadId: ThreadId,
    status: ThreadProjection.shape.status,
    turnId: TurnId.optional(),
    capabilities: ProviderCapabilities.optional(),
    errorMessage: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal("thread.message"), message: ThreadMessageProjection }),
  /** Reported by the runtime once the agent CLI names its own session, so a later process can resume it. */
  z.object({
    type: z.literal("thread.provider-session"),
    threadId: ThreadId,
    providerSessionId: ThreadProjection.shape.providerSessionId.unwrap(),
  }),
  /** Reported by the runtime as a provider counts a turn's tokens. */
  z.object({
    type: z.literal("thread.usage"),
    threadId: ThreadId,
    turnId: z.string().min(1).max(200),
    usage: TurnUsage,
  }),
  /** Reported by the runtime when a turn that changed files ends. */
  z.object({ type: z.literal("thread.checkpoint"), checkpoint: ThreadCheckpoint.omit({ recordedAt: true }) }),
  z.object({ type: z.literal("thread.request"), request: ThreadRequestProjection }),
  z.object({ type: z.literal("thread.activity"), activity: ThreadActivityProjection }),
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
    allowedRoot: z.string().min(1).optional(),
    desktopLogs: z.array(DiagnosticLog).optional(),
    desktopApp: DesktopAppInfo.optional(),
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
  /** A shell printed a local server address. The runtime records it for the terminal's worktree. */
  z.object({ type: z.literal("devserver.detected"), terminalId: TerminalId, url: z.string().min(1).max(2_000) }),
  z.object({ type: z.literal("devserver.stopped"), terminalId: TerminalId, port: DevServerProjection.shape.port }),
  ...FileCommand.options,
  ...PullRequestCommand.options,
  ...GitChangesCommand.options,
  ...CheckpointCommand.options,
  ...McpCommand.options,
  ...IssueCommand.options,
  ...SkillCommand.options,
  ...PluginCommand.options,
  ...AccountCommand.options,
  ...LimitsCommand.options,
  /** Reported by the runtime while it copies files and runs zli.json setup in a new worktree. */
  z.object({ type: z.literal("worktree.setup"), setup: WorktreeSetupProjection }),
  /** The person's answer to running zli.json setup commands; the hash pins the exact list they saw. */
  z.object({
    type: z.literal("worktree.setup.respond"),
    worktreeId: WorktreeId,
    commandsHash: z.string().min(1).max(200),
    decision: SetupDecision,
  }),
  /** Reads zli.json from the project folder. Answered by the server; never stored in the event log. */
  z.object({ type: z.literal("project.config"), projectId: ProjectId }),
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
