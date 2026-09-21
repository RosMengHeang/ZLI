import { z } from "zod";

import { TerminalId, WorktreeId } from "./ids.js";

export const TerminalProjection = z.object({
  terminalId: TerminalId,
  worktreeId: WorktreeId,
  title: z.string(),
  status: z.enum(["starting", "running", "exited", "failed"]),
  lastSequence: z.number().int().nonnegative(),
});
export type TerminalProjection = z.infer<typeof TerminalProjection>;

export const TerminalChunk = z.object({
  terminalId: TerminalId,
  sequence: z.number().int().positive(),
  bytesBase64: z.string(),
});
export type TerminalChunk = z.infer<typeof TerminalChunk>;
