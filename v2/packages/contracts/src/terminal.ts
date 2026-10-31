import { z } from "zod";

import { AgentName, StartedBy } from "./agentName.js";
import { AccountId, SessionId, TerminalId, WorktreeId } from "./ids.js";
import { ListedProviderKind, PermissionMode } from "./provider.js";

/**
 * The terminal daemon outlives the app, so a newer app would otherwise adopt an older daemon that
 * rejects requests it does not understand. Bump this whenever daemon request handling changes.
 */
export const TERMINAL_DAEMON_VERSION = "zli-v2-daemon/6";

export const TerminalStatus = z.enum(["starting", "running", "exited", "failed"]);
export type TerminalStatus = z.infer<typeof TerminalStatus>;

/** An agent CLI started inside the terminal instead of a plain shell. */
export const TerminalAgentLaunch = z.object({
  provider: ListedProviderKind,
  model: z.string().min(1).max(200).optional(),
  permissionMode: PermissionMode.optional(),
  accountId: AccountId.optional(),
  /** Runs the CLI's sign-in command for the account instead of the agent. */
  login: z.boolean().optional(),
});
export type TerminalAgentLaunch = z.infer<typeof TerminalAgentLaunch>;

export const TerminalProjection = z.object({
  terminalId: TerminalId,
  worktreeId: WorktreeId,
  title: z.string(),
  status: TerminalStatus,
  lastSequence: z.number().int().nonnegative(),
  errorMessage: z.string().min(1).optional(),
  kind: z.enum(["shell", "agent"]).optional(),
  agent: TerminalAgentLaunch.optional(),
  /** The name the person gave this terminal's agent. Only agent terminals have one. */
  name: AgentName.optional(),
  startedBy: StartedBy.optional(),
  sessionId: SessionId.optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
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

export const TerminalReadResult = z.object({
  terminalId: TerminalId,
  /** Recent output with color and cursor codes removed. */
  text: z.string(),
  /** True when older output was left out. */
  truncated: z.boolean(),
});
export type TerminalReadResult = z.infer<typeof TerminalReadResult>;

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

/**
 * Terminal input for a message, without a final Enter. Control characters are dropped so the text
 * cannot inject terminal sequences or end a bracketed paste early with its own ESC [201~. With bracketed
 * paste the program receives line breaks as part of one paste; without it a line break would submit,
 * so the message is sent as one line.
 */
export function terminalPaste(message: string, bracketedPaste: boolean): string {
  const clean = message
    .replace(/\r\n?/gu, "\n")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
  if (bracketedPaste) return `\x1b[200~${clean.replace(/\n/gu, "\r")}\x1b[201~`;
  return clean.replace(/\s*\n\s*/gu, " ").trim();
}

/** What ZLI types into an agent CLI for a message: one bracketed paste when it spans lines. */
export function agentTerminalInput(message: string): string {
  return terminalPaste(message, /[\r\n]/u.test(message));
}
