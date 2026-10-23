import type { ThreadUsageRecord } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { filterUsage, formatCost, formatTokens, groupUsage, latestContext, sumUsage } from "./usage.js";

const now = Date.parse("2026-09-23T15:00:00.000Z");

function record(
  threadId: string,
  provider: string,
  recordedAt: string,
  usage: ThreadUsageRecord["usage"],
  projectId?: string,
): ThreadUsageRecord {
  return {
    usageId: `${threadId}:${recordedAt}`,
    threadId: threadId as ThreadUsageRecord["threadId"],
    turnId: recordedAt,
    provider,
    recordedAt,
    usage,
    ...(projectId ? { projectId: projectId as ThreadUsageRecord["projectId"] } : {}),
  };
}

const records = [
  record("a", "claude-code", "2026-09-01T10:00:00.000Z", { inputTokens: 500, outputTokens: 50, costUsd: 0.5 }, "p1"),
  record(
    "a",
    "claude-code",
    "2026-09-23T10:00:00.000Z",
    { inputTokens: 1_000, cachedInputTokens: 600, outputTokens: 100, costUsd: 0.25 },
    "p1",
  ),
  record(
    "b",
    "codex",
    "2026-09-22T10:00:00.000Z",
    { inputTokens: 9_000, outputTokens: 300, contextTokens: 9_300, contextWindow: 272_000 },
    "p2",
  ),
];

describe("usage totals", () => {
  it("filters by period and project", () => {
    expect(filterUsage(records, { period: "all", now })).toHaveLength(3);
    expect(filterUsage(records, { period: "week", now }).map((entry) => entry.threadId)).toEqual(["a", "b"]);
    expect(filterUsage(records, { period: "week", projectId: "p2", now }).map((entry) => entry.threadId)).toEqual([
      "b",
    ]);
  });

  it("counts cost only from turns that reported it", () => {
    expect(sumUsage(records)).toEqual({
      turns: 3,
      inputTokens: 10_500,
      cachedInputTokens: 600,
      outputTokens: 450,
      costUsd: 0.75,
      costedTurns: 2,
    });
  });

  it("groups agents by tokens and chats by most recent", () => {
    expect(groupUsage(records, "provider").map((group) => group.key)).toEqual(["codex", "claude-code"]);
    expect(groupUsage(records, "thread").map((group) => group.key)).toEqual(["a", "b"]);
  });

  it("finds the latest context report", () => {
    expect(latestContext(records)).toEqual({ tokens: 9_300, window: 272_000 });
    expect(latestContext(records.slice(0, 2))).toBeUndefined();
  });

  it("formats counts and costs compactly", () => {
    expect(formatTokens(830)).toBe("830");
    expect(formatTokens(1_250)).toBe("1.3k");
    expect(formatTokens(12_400)).toBe("12k");
    expect(formatTokens(2_000_000)).toBe("2M");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.004)).toBe("under $0.01");
    expect(formatCost(1.234)).toBe("$1.23");
  });
});
