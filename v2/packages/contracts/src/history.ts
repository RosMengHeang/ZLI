import { z } from "zod";

import { ProviderDiscovery } from "./provider.js";
import { SessionId, ThreadId, WorktreeId } from "./ids.js";

/** Agent CLIs whose past chats ZLI can read from disk and pick up again. */
export const HistorySource = z.enum(["claude-code", "codex"]);
export type HistorySource = z.infer<typeof HistorySource>;

export const MAX_IMPORTED_MESSAGES = 400;
export const MAX_HISTORY_CHATS = 300;

/** One past chat found on disk. Only its summary crosses the wire until it is imported. */
export const HistoryChat = z.object({
  source: HistorySource,
  /** The CLI's own id for the chat, which a resumed process continues. */
  providerSessionId: z.string().min(1).max(500),
  title: z.string().min(1).max(200),
  model: z.string().min(1).max(200).optional(),
  messageCount: z.number().int().nonnegative(),
  lastActiveAt: z.string().datetime({ offset: true }),
  /** Set when a ZLI chat already resumes this conversation. */
  imported: z.boolean().optional(),
});
export type HistoryChat = z.infer<typeof HistoryChat>;

/** The past chats that ran in one folder, newest first. */
export const HistoryFolder = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  /** False when the folder was moved or deleted since the chats ran there. */
  exists: z.boolean(),
  lastActiveAt: z.string().datetime({ offset: true }),
  chats: z.array(HistoryChat),
});
export type HistoryFolder = z.infer<typeof HistoryFolder>;

export const HistoryScanResult = z.object({ folders: z.array(HistoryFolder) });
export type HistoryScanResult = z.infer<typeof HistoryScanResult>;

export const HistoryImportResult = z.object({ threadId: ThreadId, messageCount: z.number().int().nonnegative() });
export type HistoryImportResult = z.infer<typeof HistoryImportResult>;

export const ProvidersDiscoverResult = z.object({ providers: z.array(ProviderDiscovery) });
export type ProvidersDiscoverResult = z.infer<typeof ProvidersDiscoverResult>;

/** Answered by the runtime server. Reading history never writes to the agents' own files. */
export const HistoryCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("history.scan") }),
  /** Adds one past chat to a worktree as a stopped chat that the next message resumes. */
  z.object({
    type: z.literal("history.import"),
    source: HistorySource,
    providerSessionId: z.string().min(1).max(500),
    worktreeId: WorktreeId,
    sessionId: SessionId,
  }),
  /** Looks for agent CLIs again, skipping the cache, for example right after one was installed. */
  z.object({ type: z.literal("providers.discover") }),
]);
export type HistoryCommand = z.infer<typeof HistoryCommand>;
export const HISTORY_COMMAND_TYPES = ["history.scan", "history.import", "providers.discover"] as const;
