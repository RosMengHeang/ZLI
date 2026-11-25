import { z } from "zod";

/** Claude Code accepts an auto-compact window from 100k to 1M tokens. */
export const CLAUDE_AUTO_COMPACT_MIN = 100_000;
export const CLAUDE_AUTO_COMPACT_MAX = 1_000_000;

/** The one shorter history a person can pick: a month of the change log. */
export const HISTORY_RETENTION_DAYS = 30;

/**
 * Settings the runtime applies itself, such as when it starts a chat agent. Kept by the runtime, not the
 * browser, because the runtime launches the agents and owns the database.
 */
export const AgentSettings = z.object({
  /**
   * Tokens at which Claude summarizes older context. Lower keeps each message cheaper but forgets
   * detail sooner. Missing keeps Claude Code's own setting.
   */
  claudeAutoCompactTokens: z.number().int().min(CLAUDE_AUTO_COMPACT_MIN).max(CLAUDE_AUTO_COMPACT_MAX).optional(),
  /**
   * Days of the runtime's change log to keep. Older entries are deleted once the saved state covers them;
   * chats and their messages are kept either way. Missing keeps the whole log.
   */
  historyRetentionDays: z.literal(HISTORY_RETENTION_DAYS).optional(),
});
export type AgentSettings = z.infer<typeof AgentSettings>;

/** Handled directly by the runtime server; never stored in the event log. */
export const AgentSettingsCommand = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agentSettings.read") }),
  /** Replaces every setting. Replies with the saved settings. */
  z.object({ type: z.literal("agentSettings.save"), settings: AgentSettings }),
]);
export type AgentSettingsCommand = z.infer<typeof AgentSettingsCommand>;
export const AGENT_SETTINGS_COMMAND_TYPES = ["agentSettings.read", "agentSettings.save"] as const;
