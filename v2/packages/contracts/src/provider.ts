import { z } from "zod";

import { ThreadId, TurnId, WorktreeId } from "./ids.js";

export const ProviderKind = z.enum(["codex", "claude-code", "cursor-agent", "opencode"]);
export type ProviderKind = z.infer<typeof ProviderKind>;

/** Providers a person can see in discovery. OpenCode stays in ProviderKind for stored sessions, and is not listed. */
export const ListedProviderKind = z.enum(["codex", "claude-code", "cursor-agent"]);
export type ListedProviderKind = z.infer<typeof ListedProviderKind>;

export const ProviderDiscovery = z.discriminatedUnion("status", [
  z.object({
    provider: ListedProviderKind,
    displayName: z.string().min(1),
    status: z.literal("found"),
    path: z.string().min(1),
    version: z.string().min(1).max(80).optional(),
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
});
export type ThreadProjection = z.infer<typeof ThreadProjection>;

export const ThreadMessageProjection = z.object({
  messageId: z.string().min(1),
  threadId: ThreadId,
  turnId: z.string().min(1).optional(),
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
});
export type ThreadMessageProjection = z.infer<typeof ThreadMessageProjection>;

export const ThreadRequestProjection = z.object({
  requestId: z.string().min(1),
  threadId: ThreadId,
  kind: z.enum(["approval", "user-input"]),
  payload: z.record(z.string(), z.unknown()),
});
export type ThreadRequestProjection = z.infer<typeof ThreadRequestProjection>;
