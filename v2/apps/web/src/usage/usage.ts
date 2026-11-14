import { type ThreadUsageRecord, USUAL_LOGIN_ACCOUNT_ID } from "@zli-v2/contracts";

export type UsagePeriod = "today" | "week" | "month" | "all";

export const usagePeriods: { id: UsagePeriod; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "7 days" },
  { id: "month", label: "30 days" },
  { id: "all", label: "All time" },
];

export type UsageTotals = {
  turns: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Turns whose provider reported a cost. The cost total covers only these. */
  costedTurns: number;
};

export type UsageGroup = { key: string; provider: string; accountId?: string; lastAt: number; totals: UsageTotals };

const DAY_MS = 86_400_000;

export function periodStart(period: UsagePeriod, now: number): number | undefined {
  if (period === "all") return undefined;
  if (period === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  return now - (period === "week" ? 7 : 30) * DAY_MS;
}

export function filterUsage(
  records: readonly ThreadUsageRecord[],
  filter: { period: UsagePeriod; projectId?: string | undefined; now: number },
): ThreadUsageRecord[] {
  const since = periodStart(filter.period, filter.now);
  return records.filter((record) => {
    if (filter.projectId && record.projectId !== filter.projectId) return false;
    if (since === undefined) return true;
    const at = recordedAt(record);
    return at !== undefined && at >= since;
  });
}

export function sumUsage(records: readonly ThreadUsageRecord[]): UsageTotals {
  const totals: UsageTotals = {
    turns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    costedTurns: 0,
  };
  for (const { usage } of records) {
    totals.turns += 1;
    totals.inputTokens += usage.inputTokens ?? 0;
    totals.cachedInputTokens += usage.cachedInputTokens ?? 0;
    totals.outputTokens += usage.outputTokens ?? 0;
    if (usage.costUsd !== undefined) {
      totals.costUsd += usage.costUsd;
      totals.costedTurns += 1;
    }
  }
  return totals;
}

/**
 * Biggest spenders first, by tokens, since not every provider reports cost. By provider, each saved
 * account gets its own group; the usual login keeps the plain provider key.
 */
export function groupUsage(records: readonly ThreadUsageRecord[], by: "provider" | "thread"): UsageGroup[] {
  const groups = new Map<
    string,
    { provider: string; accountId?: string; lastAt: number; records: ThreadUsageRecord[] }
  >();
  for (const record of records) {
    const accountId =
      by === "provider" && record.accountId && record.accountId !== USUAL_LOGIN_ACCOUNT_ID
        ? record.accountId
        : undefined;
    const key = by === "thread" ? record.threadId : accountId ? `${record.provider}:${accountId}` : record.provider;
    const group = groups.get(key) ?? {
      provider: record.provider,
      ...(accountId ? { accountId } : {}),
      lastAt: 0,
      records: [],
    };
    group.records.push(record);
    group.lastAt = Math.max(group.lastAt, recordedAt(record) ?? 0);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      provider: group.provider,
      ...(group.accountId ? { accountId: group.accountId } : {}),
      lastAt: group.lastAt,
      totals: sumUsage(group.records),
    }))
    .sort((left, right) =>
      by === "thread" ? right.lastAt - left.lastAt : tokenTotal(right.totals) - tokenTotal(left.totals),
    );
}

export function tokenTotal(totals: Pick<UsageTotals, "inputTokens" | "outputTokens">): number {
  return totals.inputTokens + totals.outputTokens;
}

/** How full the context window is, with what the turn that reported it read and wrote when it says so. */
export type ContextUsage = {
  tokens: number;
  window?: number;
  turn?: {
    input?: number;
    cached?: number;
    output?: number;
    /** Most of a large input was resent without the prompt cache. Never set on a thread's first turn, which starts with an empty cache. */
    cacheMissed?: boolean;
  };
  /** When the prompt cache runs out, in epoch milliseconds. Only Claude reports it. */
  cacheExpiresAt?: number;
};

/** What the next message will pay for the thread so far: cache prices until expiry, full price after. */
export function cacheStatus(
  expiresAt: number | undefined,
  now: number,
): { warm: true; minutesLeft: number } | { warm: false } | undefined {
  if (expiresAt === undefined) return undefined;
  const left = expiresAt - now;
  return left > 0 ? { warm: true, minutesLeft: Math.max(1, Math.floor(left / 60_000)) } : { warm: false };
}

/** Below this many input tokens a missed cache costs too little to point out. */
const CACHE_MISS_MIN_INPUT = 20_000;
const CACHE_MISS_SHARE = 0.5;

/** The share of input tokens served from the prompt cache, from 0 to 1. */
export function cachedShare(turn: { input?: number; cached?: number }): number | undefined {
  if (!turn.input) return undefined;
  return Math.min(1, (turn.cached ?? 0) / turn.input);
}

export function latestContext(records: readonly ThreadUsageRecord[]): ContextUsage | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const usage = records[index]?.usage;
    if (usage?.contextTokens === undefined) continue;
    const share = cachedShare({
      ...(usage.inputTokens !== undefined ? { input: usage.inputTokens } : {}),
      ...(usage.cachedInputTokens !== undefined ? { cached: usage.cachedInputTokens } : {}),
    });
    const cacheMissed =
      index > 0 && (usage.inputTokens ?? 0) >= CACHE_MISS_MIN_INPUT && share !== undefined && share < CACHE_MISS_SHARE;
    const turn = {
      ...(usage.inputTokens !== undefined ? { input: usage.inputTokens } : {}),
      ...(usage.cachedInputTokens ? { cached: usage.cachedInputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { output: usage.outputTokens } : {}),
      ...(cacheMissed ? { cacheMissed: true } : {}),
    };
    return {
      tokens: usage.contextTokens,
      ...(usage.contextWindow ? { window: usage.contextWindow } : {}),
      ...(Object.keys(turn).length > 0 ? { turn } : {}),
      ...(usage.promptCacheExpiresAt !== undefined ? { cacheExpiresAt: usage.promptCacheExpiresAt } : {}),
    };
  }
  return undefined;
}

export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${trimZero((count / 1_000).toFixed(count < 10_000 ? 1 : 0))}k`;
  return `${trimZero((count / 1_000_000).toFixed(count < 10_000_000 ? 2 : 1))}M`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "under $0.01";
  return `$${usd.toFixed(2)}`;
}

function trimZero(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/u, "") : value;
}

function recordedAt(record: ThreadUsageRecord): number | undefined {
  if (!record.recordedAt) return undefined;
  const at = Date.parse(record.recordedAt);
  return Number.isNaN(at) ? undefined : at;
}
