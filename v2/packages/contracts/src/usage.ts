import { z } from "zod";

import { ListedProviderKind } from "./provider.js";

/** How far back the Usage page looks: the last 7 or 30 days counting today, or everything on disk. */
export const USAGE_RANGES = ["7d", "30d", "all"] as const;
export const UsageRange = z.enum(USAGE_RANGES);
export type UsageRange = z.infer<typeof UsageRange>;

const Count = z.number().int().nonnegative();
const Usd = z.number().nonnegative();

/**
 * Tokens split the way they are billed. `input` excludes cached input. `reasoning` is already inside
 * `output`; it is shown on its own but never added again.
 */
export const UsageTokens = z.object({
  input: Count,
  output: Count,
  cacheRead: Count,
  cacheWrite: Count,
  reasoning: Count,
});
export type UsageTokens = z.infer<typeof UsageTokens>;

/** Cost covers only the tokens of models with a known price; `unpricedTokens` counts the rest. */
const Spend = {
  tokens: UsageTokens,
  costUsd: Usd,
  unpricedTokens: Count,
  /** Model requests counted, after copies of the same request were merged. */
  requests: Count,
};

export const UsageProviderSlice = z.object({ provider: ListedProviderKind, tokens: Count, costUsd: Usd });
export type UsageProviderSlice = z.infer<typeof UsageProviderSlice>;

export const UsageDay = z.object({
  /** The local calendar day, YYYY-MM-DD. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  tokens: Count,
  costUsd: Usd,
  providers: z.array(UsageProviderSlice).max(20),
});
export type UsageDay = z.infer<typeof UsageDay>;

export const UsageProviderRow = z.object({ provider: ListedProviderKind, ...Spend });
export type UsageProviderRow = z.infer<typeof UsageProviderRow>;

export const UsageModelRow = z.object({
  provider: ListedProviderKind,
  model: z.string().min(1).max(200),
  ...Spend,
  /** False when ZLI has no price for this model; its cost is then unknown, not zero. */
  priced: z.boolean(),
});
export type UsageModelRow = z.infer<typeof UsageModelRow>;

export const UsageReport = z.object({
  range: UsageRange,
  timeZone: z.string().max(100),
  /** First and last day covered. `from` is missing only for "all" when nothing was found. */
  from: z.string().optional(),
  to: z.string(),
  days: z.array(UsageDay).max(4_000),
  providers: z.array(UsageProviderRow).max(20),
  models: z.array(UsageModelRow).max(300),
  totals: z.object(Spend),
  /** Session log files read for this report. */
  files: Count,
  generatedAt: z.string(),
});
export type UsageReport = z.infer<typeof UsageReport>;

/** Handled directly by the runtime server, which reads the agents' own session logs; never stored. */
export const UsageCommand = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("usage.read"),
    range: UsageRange,
    /** The IANA zone days are counted in. Defaults to the runtime's own. */
    timeZone: z.string().min(1).max(100).optional(),
  }),
]);
export type UsageCommand = z.infer<typeof UsageCommand>;
export const USAGE_COMMAND_TYPES = ["usage.read"] as const;
