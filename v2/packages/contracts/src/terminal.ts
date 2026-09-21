import { z } from "zod";

import { TerminalId, WorktreeId } from "./ids.js";

export const TerminalStatus = z.enum(["starting", "running", "exited", "failed"]);
export type TerminalStatus = z.infer<typeof TerminalStatus>;

export const TerminalProjection = z.object({
  terminalId: TerminalId,
  worktreeId: WorktreeId,
  title: z.string(),
  status: TerminalStatus,
  lastSequence: z.number().int().nonnegative(),
  errorMessage: z.string().min(1).optional(),
});
export type TerminalProjection = z.infer<typeof TerminalProjection>;

export const TerminalChunk = z.object({
  terminalId: TerminalId,
  sequence: z.number().int().positive(),
  bytesBase64: z.string(),
});
export type TerminalChunk = z.infer<typeof TerminalChunk>;

export const TerminalAttachSnapshot = z.object({
  terminalId: TerminalId,
  chunks: z.array(TerminalChunk),
  nextSequence: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type TerminalAttachSnapshot = z.infer<typeof TerminalAttachSnapshot>;

export const TerminalStreamMessage = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chunk"), chunk: TerminalChunk }),
  z.object({
    kind: z.literal("snapshot_required"),
    terminalId: TerminalId,
    nextSequence: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("exit"),
    terminalId: TerminalId,
    code: z.number().int(),
    signal: z.number().int().nullable(),
  }),
]);
export type TerminalStreamMessage = z.infer<typeof TerminalStreamMessage>;
