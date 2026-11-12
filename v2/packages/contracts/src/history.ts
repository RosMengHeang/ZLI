import { z } from "zod";

import { ProviderDiscovery } from "./provider.js";

/** Agent CLIs whose past sessions tell ZLI which folders the person works in. */
export const HistorySource = z.enum(["claude-code", "codex"]);
export type HistorySource = z.infer<typeof HistorySource>;

/** How many of the newest session files are read when looking for project folders. */
export const MAX_HISTORY_SESSIONS = 300;

/** A folder an agent worked in, newest first. Only folders that still exist are listed. */
export const HistoryFolder = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  lastActiveAt: z.string().datetime({ offset: true }),
  /** The agents that ran there. */
  sources: z.array(HistorySource).min(1),
});
export type HistoryFolder = z.infer<typeof HistoryFolder>;

export const HistoryScanResult = z.object({ folders: z.array(HistoryFolder) });
export type HistoryScanResult = z.infer<typeof HistoryScanResult>;

export const ProvidersDiscoverResult = z.object({ providers: z.array(ProviderDiscovery) });
export type ProvidersDiscoverResult = z.infer<typeof ProvidersDiscoverResult>;

/** Answered by the runtime server. Reading history never writes to the agents' own files. */
export const HistoryCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("history.scan") }),
  /** Looks for agent CLIs again, skipping the cache, for example right after one was installed. */
  z.object({ type: z.literal("providers.discover") }),
]);
export type HistoryCommand = z.infer<typeof HistoryCommand>;
export const HISTORY_COMMAND_TYPES = ["history.scan", "providers.discover"] as const;
