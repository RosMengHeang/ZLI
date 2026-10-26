import { z } from "zod";

import { ListedProviderKind } from "./provider.js";

/**
 * Agents whose subscription plans report usage limits that ZLI can read. Copilot, Qwen Code, Droid,
 * and Goose report none a sign-in can read, so they never show.
 */
export const PLAN_LIMIT_PROVIDERS = ["claude-code", "codex", "gemini", "cursor-agent", "kimi", "opencode"] as const;
export type PlanLimitProvider = (typeof PLAN_LIMIT_PROVIDERS)[number];

/** Minutes in the usual window lengths. */
export const FIVE_HOUR_WINDOW = 300;
export const DAILY_WINDOW = 1_440;
export const WEEKLY_WINDOW = 10_080;
export const MONTHLY_WINDOW = 43_200;

export const PlanLimitWindow = z.object({
  /**
   * "usage" is a share of the plan's included use. "spend" is a share of a paid monthly cap, such as
   * Claude's extra usage, which only matters when the plan has no usage windows of its own.
   */
  kind: z.enum(["usage", "spend"]).optional(),
  /**
   * The model or pool a window is limited to, such as "Fable", "2.5 Pro", or Cursor's "API". Missing
   * for the whole plan.
   */
  scope: z.string().min(1).max(60).optional(),
  /**
   * Length of the window, when the provider says. 300 is the 5-hour window, 10080 the weekly one.
   * Gemini says only when each model's quota resets, so its windows have none.
   */
  durationMinutes: z.number().int().positive().optional(),
  usedPercent: z.number().min(0).max(100),
  /** ISO time the window resets, when the provider says. */
  resetsAt: z.string().optional(),
});
export type PlanLimitWindow = z.infer<typeof PlanLimitWindow>;

export const PlanLimitReading = z.object({
  provider: ListedProviderKind,
  /** The saved account, or "usual" for the person's own login. */
  accountId: z.string().min(1).max(100),
  /**
   * "ok" has current windows. Any other state keeps the last windows read, if any, and says why they
   * may be old in `message`.
   */
  state: z.enum(["ok", "signed-out", "expired", "unavailable", "error"]),
  message: z.string().max(300).optional(),
  /** The plan name the provider reports, such as "pro" or "max". */
  plan: z.string().max(60).optional(),
  windows: z.array(PlanLimitWindow).max(8),
  /** ISO time of the last successful read. */
  checkedAt: z.string().optional(),
});
export type PlanLimitReading = z.infer<typeof PlanLimitReading>;

/** Handled directly by the runtime server; never stored in the event log. */
export const LimitsCommand = z.discriminatedUnion("type", [
  /** Without refresh, readings younger than a few minutes come from the runtime's cache. */
  z.object({ type: z.literal("limits.read"), refresh: z.boolean().optional() }),
]);
export type LimitsCommand = z.infer<typeof LimitsCommand>;
export const LIMITS_COMMAND_TYPES = ["limits.read"] as const;

export const PlanLimitsResult = z.object({ readings: z.array(PlanLimitReading) });
export type PlanLimitsResult = z.infer<typeof PlanLimitsResult>;
