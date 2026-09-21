import { z } from "zod";

export const ThreadStartResponse = z.object({
  thread: z.object({ id: z.string().min(1) }).passthrough(),
});
export type ThreadStartResponse = z.infer<typeof ThreadStartResponse>;

export const TurnStartResponse = z.object({
  turn: z.object({ id: z.string().min(1) }).passthrough(),
});
export type TurnStartResponse = z.infer<typeof TurnStartResponse>;

export const ThreadReadResponse = z.object({
  thread: z.object({ id: z.string().min(1), turns: z.array(z.unknown()).optional() }).passthrough(),
});
export type ThreadReadResponse = z.infer<typeof ThreadReadResponse>;

export const ApprovalDecision = z.object({
  decision: z.enum(["accept", "decline", "cancel"]),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
