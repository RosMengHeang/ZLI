import { z } from "zod";

import { ThreadId, TurnId } from "./ids.js";

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
  provider: z.string().min(1),
  status: z.enum(["starting", "idle", "working", "waiting", "stopped", "failed"]),
  activeTurnId: TurnId.optional(),
  capabilities: ProviderCapabilities,
});
export type ThreadProjection = z.infer<typeof ThreadProjection>;
