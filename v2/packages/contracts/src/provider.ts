import { z } from "zod";

import { AgentName, StartedBy } from "./agentName.js";
import { AccountId, ProjectId, SessionId, ThreadId, TurnId, WorktreeId } from "./ids.js";

export const ProviderKind = z.enum([
  "codex",
  "claude-code",
  "cursor-agent",
  "droid",
  "opencode",
  "gemini",
  "copilot",
  "kimi",
  "qwen",
  "goose",
]);
export type ProviderKind = z.infer<typeof ProviderKind>;

/** Providers a person can see in discovery. */
export const ListedProviderKind = ProviderKind;
export type ListedProviderKind = z.infer<typeof ListedProviderKind>;

/** How much an agent may do without asking. Full access is the default for every launch. */
/** read-only plans without changing files, supervised edits but asks or refuses before risky commands. */
export const PermissionMode = z.enum(["read-only", "supervised", "full-access"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

/**
 * A reasoning level an agent accepts, such as "low", "xhigh", or "max". Each agent and model has
 * its own set, and Droid passes it on the command line, so it cannot start with a dash.
 */
export const ReasoningEffort = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/u);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

const ReasoningEfforts = z.array(ReasoningEffort).max(20);

export const ProviderModelOption = z.object({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  /** Empty means the model has no reasoning levels. Missing means the agent did not say. */
  reasoningEfforts: ReasoningEfforts.optional(),
  defaultReasoningEffort: ReasoningEffort.optional(),
});
export type ProviderModelOption = z.infer<typeof ProviderModelOption>;

/**
 * Who an installed agent CLI is signed in as, read from its own files. Left out when ZLI cannot tell,
 * for example when the CLI keeps its login in the system keychain.
 */
export const AgentLogin = z.object({
  status: z.enum(["signed-in", "signed-out"]),
  /** How it pays: a subscription sign-in, or an API key from the environment or its auth file. */
  method: z.enum(["subscription", "api-key"]).optional(),
  email: z.string().min(3).max(320).optional(),
  /** The subscription plan the CLI reports, such as "pro". */
  plan: z.string().min(1).max(40).optional(),
});
export type AgentLogin = z.infer<typeof AgentLogin>;

export const ProviderDiscovery = z.discriminatedUnion("status", [
  z.object({
    provider: ListedProviderKind,
    displayName: z.string().min(1),
    status: z.literal("found"),
    path: z.string().min(1),
    version: z.string().min(1).max(80).optional(),
    models: z.array(ProviderModelOption).max(400).optional(),
    /** Levels for models that list none of their own, including the agent's default model. */
    reasoningEfforts: ReasoningEfforts.optional(),
    login: AgentLogin.optional(),
  }),
  z.object({
    provider: ListedProviderKind,
    displayName: z.string().min(1),
    status: z.literal("missing"),
    reason: z.string().min(1),
  }),
]);
export type ProviderDiscovery = z.infer<typeof ProviderDiscovery>;

export const ProviderCapabilities = z.object({
  exactResume: z.boolean().optional(),
  structuredApproval: z.boolean().optional(),
  structuredUserInput: z.boolean().optional(),
  conversationRollback: z.boolean().optional(),
  modelSwitch: z.enum(["in-session", "unsupported"]).optional(),
  /** in-session means a turn can run under a different permission mode than the last one. */
  permissionSwitch: z.enum(["in-session", "unsupported"]).optional(),
  /** Levels this session's agent reported when it started, for agents that report them per session. */
  reasoningEfforts: ReasoningEfforts.optional(),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>;

export const ThreadProjection = z.object({
  threadId: ThreadId,
  worktreeId: WorktreeId,
  provider: z.string().min(1),
  status: z.enum(["starting", "idle", "working", "waiting", "stopped", "failed"]),
  activeTurnId: TurnId.optional(),
  capabilities: ProviderCapabilities,
  errorMessage: z.string().min(1).optional(),
  permissionMode: PermissionMode.optional(),
  model: z.string().min(1).max(200).optional(),
  /** The name the person gave this agent. */
  name: AgentName.optional(),
  startedBy: StartedBy.optional(),
  sessionId: SessionId.optional(),
  /**
   * The agent CLI's own id for this conversation, such as a Claude session or a Codex thread. A new process
   * resumes the chat from it after the old one ended, for example when ZLI restarted.
   */
  providerSessionId: z.string().min(1).max(500).optional(),
  /** The account the agent runs under. Threads from before accounts existed have none. */
  accountId: AccountId.optional(),
  /**
   * The thread this one carries on, when the person moved the chat to another agent or model. The chat
   * shows both as one conversation.
   */
  continues: ThreadId.optional(),
  /**
   * The chat this agent was brought into by the person. Its replies show inside that chat, beside the
   * chat's own agent, and the person talks to it there by name.
   */
  joins: ThreadId.optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
});
export type ThreadProjection = z.infer<typeof ThreadProjection>;

export const ImageMimeType = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export type ImageMimeType = z.infer<typeof ImageMimeType>;

/** Images, plus plain text for long pastes that would bury the message they belong to. */
export const AttachmentMimeType = z.enum([...ImageMimeType.options, "text/plain"]);
export type AttachmentMimeType = z.infer<typeof AttachmentMimeType>;

export function isImageMimeType(value: string): value is ImageMimeType {
  return (ImageMimeType.options as readonly string[]).includes(value);
}

/** File bytes as sent by a client. The runtime stores them on disk before the command is recorded. */
export const ThreadAttachmentUpload = z
  .object({
    name: z.string().min(1).max(255),
    mimeType: AttachmentMimeType,
    dataBase64: z.string().min(1).max(14_000_000).optional(),
    path: z.string().min(1).max(4_000).optional(),
  })
  .refine((value) => (value.dataBase64 === undefined) !== (value.path === undefined), {
    message: "An attachment needs either dataBase64 or path, not both.",
  });
export type ThreadAttachmentUpload = z.infer<typeof ThreadAttachmentUpload>;

/** A stored file the agent can read from disk. */
export const ThreadAttachment = z.object({
  name: z.string().min(1).max(255),
  mimeType: AttachmentMimeType,
  path: z.string().min(1).max(4_000),
});
export type ThreadAttachment = z.infer<typeof ThreadAttachment>;

/**
 * Reads back a file that a message in the thread carried, so the chat can show it. The runtime
 * answers directly, outside the event log, and only for a path one of the thread's messages recorded.
 */
export const ThreadAttachmentReadCommand = z.object({
  type: z.literal("thread.attachment.read"),
  threadId: ThreadId,
  path: z.string().min(1).max(4_000),
});
export type ThreadAttachmentReadCommand = z.infer<typeof ThreadAttachmentReadCommand>;

export const ThreadAttachmentData = z.object({
  name: z.string().min(1).max(255),
  mimeType: AttachmentMimeType,
  size: z.number().int().nonnegative(),
  dataBase64: z.string(),
});
export type ThreadAttachmentData = z.infer<typeof ThreadAttachmentData>;

export const ThreadMessageProjection = z.object({
  messageId: z.string().min(1),
  threadId: ThreadId,
  turnId: z.string().min(1).optional(),
  role: z.enum(["user", "assistant", "system", "agent"]),
  text: z.string(),
  /** Sending thread when role is "agent". The text is untrusted. */
  sourceThreadId: ThreadId.optional(),
  attachments: z.array(ThreadAttachment).max(8).optional(),
});
export type ThreadMessageProjection = z.infer<typeof ThreadMessageProjection>;

export const ThreadRequestProjection = z.object({
  requestId: z.string().min(1),
  threadId: ThreadId,
  kind: z.enum(["approval", "user-input"]),
  payload: z.record(z.string(), z.unknown()),
});
export type ThreadRequestProjection = z.infer<typeof ThreadRequestProjection>;

/** A message waiting for its agent to finish the current turn. Sent in order, oldest first. */
export const ThreadQueuedMessage = z.object({
  queueId: z.string().min(1).max(200),
  threadId: ThreadId,
  text: z.string().min(1),
  model: z.string().min(1).max(200).optional(),
  reasoningEffort: ReasoningEffort.optional(),
  permissionMode: PermissionMode.optional(),
  attachments: z.array(ThreadAttachment).max(8).optional(),
  /**
   * The conversation so far, for an agent that takes over a chat from another one. The agent reads it
   * before the message; the chat shows only the message.
   */
  context: z.string().min(1).max(200_000).optional(),
  queuedAt: z.string().datetime({ offset: true }).optional(),
});
export type ThreadQueuedMessage = z.infer<typeof ThreadQueuedMessage>;

const TokenCount = z.number().int().nonnegative();

/** What a provider reported for one turn. A missing field means the provider did not report it. */
export const TurnUsage = z.object({
  /** Every prompt token, cached or not. */
  inputTokens: TokenCount.optional(),
  /** The part of inputTokens served from the provider's prompt cache. */
  cachedInputTokens: TokenCount.optional(),
  outputTokens: TokenCount.optional(),
  /** The provider's own estimate in US dollars. */
  costUsd: z.number().nonnegative().optional(),
  /** Tokens in the context window at the end of the turn, out of contextWindow. */
  contextTokens: TokenCount.optional(),
  contextWindow: z.number().int().positive().optional(),
});
export type TurnUsage = z.infer<typeof TurnUsage>;

/** One turn's usage. Kept after its session is deleted, so spend history stays complete. */
export const ThreadUsageRecord = z.object({
  usageId: z.string().min(1).max(300),
  threadId: ThreadId,
  turnId: z.string().min(1).max(200),
  provider: z.string().min(1),
  projectId: ProjectId.optional(),
  model: z.string().min(1).max(200).optional(),
  accountId: AccountId.optional(),
  recordedAt: z.string().datetime({ offset: true }).optional(),
  usage: TurnUsage,
});
export type ThreadUsageRecord = z.infer<typeof ThreadUsageRecord>;

export const ThreadActivityKind = z.enum(["command", "file-read", "file-edit", "search", "web", "tool"]);
export type ThreadActivityKind = z.infer<typeof ThreadActivityKind>;

/**
 * A connector a tool call is about. sign-in: the call failed until the person signs in to the server.
 * request: the agent asked the person to connect it. server is a server name or a catalog id.
 */
export const ThreadActivityConnector = z.object({
  server: z.string().min(1).max(100),
  reason: z.enum(["sign-in", "request"]),
});
export type ThreadActivityConnector = z.infer<typeof ThreadActivityConnector>;

/** One step of the plan an agent keeps while it works, such as Claude's todo list or Codex's plan. */
export const ThreadActivityTodo = z.object({
  text: z.string().min(1).max(500),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type ThreadActivityTodo = z.infer<typeof ThreadActivityTodo>;

/** One tool call inside a turn. Updates with the same activityId replace earlier ones. */
export const ThreadActivityProjection = z.object({
  activityId: z.string().min(1).max(200),
  threadId: ThreadId,
  turnId: z.string().min(1).optional(),
  kind: ThreadActivityKind,
  /** Short human summary such as "Read src/app.ts" or "npm test". */
  title: z.string().min(1).max(500),
  /** Tail of the tool output or error text. */
  detail: z.string().max(4_000).optional(),
  status: z.enum(["running", "completed", "failed"]),
  files: z.array(z.string().min(1).max(4_000)).max(100).optional(),
  /** The command line, for a command whose title is the agent's description of it. */
  command: z.string().min(1).max(2_000).optional(),
  /** Lines an edit added and removed, when the agent reported enough to count them. */
  lines: z
    .object({ added: z.number().int().min(0).max(10_000_000), removed: z.number().int().min(0).max(10_000_000) })
    .optional(),
  /** How much of the turn's reply had arrived when the call started, which places it inside the reply. */
  textOffset: z.number().int().min(0).max(100_000_000).optional(),
  connector: ThreadActivityConnector.optional(),
  /** The agent's whole plan as of this call, for a call that writes its todo list or plan. */
  todos: z.array(ThreadActivityTodo).max(100).optional(),
});
export type ThreadActivityProjection = z.infer<typeof ThreadActivityProjection>;
