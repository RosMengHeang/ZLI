import type { PullRequestCheck, PullRequestInfo, ThreadActivityProjection, ThreadUsageRecord } from "@zli-v2/contracts";

import { checksSummary } from "../chat/ChatExtras.js";
import { sumUsage } from "../usage/usage.js";

/** The cards of the chat's computer column, in the order they stack. */
export type OverviewCardId = "environment" | "running" | "changes" | "checks" | "context" | "mcps";

const COLLAPSED_KEY = "zli.overview.collapsed";

/** The cards the person folded, kept per browser profile. Storage can be missing or blocked, so it never throws. */
export function readCollapsedCards(): ReadonlySet<OverviewCardId> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((id): id is OverviewCardId => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeCollapsedCards(cards: ReadonlySet<OverviewCardId>): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...cards]));
  } catch {
    // Folding still works for this window; it just is not remembered.
  }
}

export type TokenRow = { id: "cached" | "uncached" | "output"; label: string; tokens: number; share: number };

/**
 * What the chat's turns read and wrote, split the way providers report it. Input counts every prompt token, so
 * the cached part is taken out of it to leave the uncached input. Undefined when no turn reported tokens.
 */
export function sessionTokens(records: readonly ThreadUsageRecord[]): { total: number; rows: TokenRow[] } | undefined {
  const reported = records.filter(
    (record) => record.usage.inputTokens !== undefined || record.usage.outputTokens !== undefined,
  );
  if (reported.length === 0) return undefined;
  const totals = sumUsage(reported);
  const cached = Math.min(totals.cachedInputTokens, totals.inputTokens);
  const parts: Omit<TokenRow, "share">[] = [
    { id: "cached", label: "Cache read", tokens: cached },
    { id: "uncached", label: "Uncached input", tokens: totals.inputTokens - cached },
    { id: "output", label: "Output", tokens: totals.outputTokens },
  ];
  const total = parts.reduce((sum, part) => sum + part.tokens, 0);
  if (total === 0) return undefined;
  // A provider that never reports a cache shows no cache row rather than a row of zeros.
  const rows = parts
    .filter((part) => part.id !== "cached" || totals.cachedInputTokens > 0)
    .map((part) => ({ ...part, share: part.tokens / total }));
  return { total, rows };
}

/** Whole percent, but never "0%" for a share that is there, and never "100%" for one that is not all. */
export function percent(share: number): string {
  if (share <= 0) return "0%";
  if (share < 0.01) return "<1%";
  if (share < 1 && share > 0.99) return "99%";
  return `${Math.round(share * 100)}%`;
}

/**
 * The MCP server a tool call went to, from the ways agents name them: `mcp__server__tool` (Claude),
 * `server.tool` (Codex), and `tool (server MCP Server)` (Gemini). Undefined for the agent's own tools.
 */
export function mcpServerOf(activity: Pick<ThreadActivityProjection, "kind" | "title">): string | undefined {
  if (activity.kind !== "tool") return undefined;
  const title = activity.title.trim();
  const claude = /^mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*?)__.+$/u.exec(title);
  if (claude?.[1]) return claude[1];
  const gemini = /^[\w-]+\s*\(([\w-]+) MCP Server\)$/u.exec(title);
  if (gemini?.[1]) return gemini[1];
  const codex = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/u.exec(title);
  if (codex?.[1]) return codex[1];
  return undefined;
}

export type McpUse = { server: string; calls: number; failed: number };

/** The MCP servers the chat called, most called first. */
export function mcpUsage(activities: readonly ThreadActivityProjection[]): McpUse[] {
  const byServer = new Map<string, McpUse>();
  for (const activity of activities) {
    const server = mcpServerOf(activity);
    if (!server) continue;
    const use = byServer.get(server) ?? { server, calls: 0, failed: 0 };
    use.calls += 1;
    if (activity.status === "failed") use.failed += 1;
    byServer.set(server, use);
  }
  return [...byServer.values()].sort(
    (left, right) => right.calls - left.calls || left.server.localeCompare(right.server),
  );
}

export type ChecksView = {
  /** Checks passed out of all of them, such as "0/4" while they run, "3/4" with one failed, "4/4" when done. */
  count: string;
  /** "4/4 passed", "3/4 passed, 1 failed", "1/4 passed, 3 running". */
  headline: string;
  tone: "passed" | "failed" | "pending";
  /** Failing first, then running, then the rest, so the ones that matter sit on top. */
  checks: PullRequestCheck[];
};

const CHECK_ORDER: Record<PullRequestCheck["state"], number> = { failed: 0, pending: 1, passed: 2, skipped: 3 };

export function checksView(pullRequest: PullRequestInfo | undefined): ChecksView | undefined {
  if (!pullRequest?.checks || pullRequest.checks.length === 0) return undefined;
  const summary = checksSummary(pullRequest);
  if (summary.state === "none") return undefined;
  const passed = pullRequest.checks.filter((check) => check.state === "passed").length;
  const pending = pullRequest.checks.filter((check) => check.state === "pending").length;
  const checks = [...pullRequest.checks].sort((left, right) => CHECK_ORDER[left.state] - CHECK_ORDER[right.state]);
  const count = `${passed}/${summary.total}`;
  if (summary.state === "failed") {
    return { count, headline: `${count} passed, ${summary.failed} failed`, tone: "failed", checks };
  }
  if (summary.state === "pending")
    return { count, headline: `${count} passed, ${pending} running`, tone: "pending", checks };
  return { count, headline: `${count} passed`, tone: "passed", checks };
}

export type PullRequestTone = "open" | "draft" | "merged" | "closed";

export function pullRequestTone(pullRequest: Pick<PullRequestInfo, "state" | "isDraft">): PullRequestTone {
  if (pullRequest.state === "MERGED") return "merged";
  if (pullRequest.state === "CLOSED") return "closed";
  return pullRequest.isDraft ? "draft" : "open";
}

export const pullRequestStateLabel: Record<PullRequestTone, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

/** "2,218" in the person's locale, for counts that sit in a row of numbers. */
export function count(value: number): string {
  return value.toLocaleString();
}
