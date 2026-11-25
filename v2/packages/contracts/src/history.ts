import { z } from "zod";

import { ListedProviderKind, ProviderDiscovery } from "./provider.js";

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

/**
 * How an installed agent CLI gets a new version: through the package manager that put it there, through
 * its own update command, or by hand when ZLI cannot tell who owns it.
 */
export const ProviderUpdateMethod = z.enum(["npm", "pnpm", "bun", "yarn", "volta", "self", "manual"]);
export type ProviderUpdateMethod = z.infer<typeof ProviderUpdateMethod>;

export const ProviderUpdateInfo = z.object({
  provider: ListedProviderKind,
  displayName: z.string().min(1),
  /** The installed version, as x.y.z when the CLI printed one. */
  current: z.string().min(1).max(80).optional(),
  /** The newest published version, when the registry answered. */
  latest: z.string().min(1).max(80).optional(),
  /** behind: a newer version is out. unknown: no published version to compare with. */
  status: z.enum(["current", "behind", "unknown"]),
  method: ProviderUpdateMethod,
  /** False for a manual install: the command is only shown, to run by hand. */
  canUpdate: z.boolean(),
  /** The command ZLI runs, or would suggest, written the way a person would type it. */
  command: z.string().min(1).max(400).optional(),
});
export type ProviderUpdateInfo = z.infer<typeof ProviderUpdateInfo>;

export const ProviderUpdatesResult = z.object({ updates: z.array(ProviderUpdateInfo) });
export type ProviderUpdatesResult = z.infer<typeof ProviderUpdatesResult>;

export const ProviderUpdateResult = z.object({
  provider: ListedProviderKind,
  /** updated: the version moved. unchanged: the command ran but the version did not move. */
  outcome: z.enum(["updated", "unchanged", "failed"]),
  message: z.string().min(1).max(400),
  /** The last lines the command printed, for a failure. */
  output: z.string().max(4_000).optional(),
  updates: z.array(ProviderUpdateInfo),
});
export type ProviderUpdateResult = z.infer<typeof ProviderUpdateResult>;

/** Answered by the runtime server. Reading history never writes to the agents' own files. */
export const HistoryCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("history.scan") }),
  /** Looks for agent CLIs again, skipping the cache, for example right after one was installed. */
  z.object({
    type: z.literal("providers.discover"),
    /** Forgets the failed run recorded for this agent first, so the person can try it again. */
    clearProblem: ListedProviderKind.optional(),
  }),
  /** Compares each installed agent CLI with its newest published version. Installs nothing. */
  z.object({ type: z.literal("providers.checkUpdates") }),
  /** Updates one agent CLI with the command its install method needs, then looks for agents again. */
  z.object({ type: z.literal("providers.update"), provider: ListedProviderKind }),
]);
export type HistoryCommand = z.infer<typeof HistoryCommand>;
export const HISTORY_COMMAND_TYPES = [
  "history.scan",
  "providers.discover",
  "providers.checkUpdates",
  "providers.update",
] as const;
