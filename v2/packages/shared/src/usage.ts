/** Token and cost counts for one turn. A missing field means the provider did not report it. */
export type ProviderUsage = {
  /** Every prompt token, cached or not. */
  inputTokens?: number;
  /** The part of inputTokens served from the provider's prompt cache. */
  cachedInputTokens?: number;
  outputTokens?: number;
  /** The provider's own estimate in US dollars. */
  costUsd?: number;
  /** Tokens in the context window at the end of the turn, out of contextWindow. */
  contextTokens?: number;
  contextWindow?: number;
};

/** A whole, non-negative count, or undefined when the value is missing or not a number. */
export function tokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

export function costAmount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** Sums the counts that are present; undefined only when every part is missing. */
export function sumCounts(...values: ReadonlyArray<number | undefined>): number | undefined {
  let total: number | undefined;
  for (const value of values) if (value !== undefined) total = (total ?? 0) + value;
  return total;
}

/** The growth of a running total. A total that went down was reset, so the new total is the growth. */
export function growth(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined) return undefined;
  if (previous === undefined || current < previous) return current;
  return current - previous;
}

/** Drops missing fields so the result fits optional-property types; undefined when nothing is left. */
export function compactUsage(usage: { [K in keyof ProviderUsage]?: number | undefined }): ProviderUsage | undefined {
  const result: ProviderUsage = {};
  for (const key of USAGE_KEYS) {
    const value = usage[key];
    if (value !== undefined) result[key] = value;
  }
  if (result.contextWindow === 0) delete result.contextWindow;
  return Object.keys(result).length > 0 ? result : undefined;
}

const USAGE_KEYS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "costUsd",
  "contextTokens",
  "contextWindow",
] as const satisfies ReadonlyArray<keyof ProviderUsage>;
