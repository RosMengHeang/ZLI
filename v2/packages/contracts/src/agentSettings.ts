import { z } from "zod";

/** Claude Code accepts an auto-compact window from 100k to 1M tokens. */
export const CLAUDE_AUTO_COMPACT_MIN = 100_000;
export const CLAUDE_AUTO_COMPACT_MAX = 1_000_000;

/** Settings the runtime applies when it starts a chat agent. Kept by the runtime, not the browser, because the runtime launches the agents. */
export const AgentSettings = z.object({
  /**
   * Tokens at which Claude summarizes older context. Lower keeps each message cheaper but forgets
   * detail sooner. Missing keeps Claude Code's own setting.
   */
  claudeAutoCompactTokens: z.number().int().min(CLAUDE_AUTO_COMPACT_MIN).max(CLAUDE_AUTO_COMPACT_MAX).optional(),
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
