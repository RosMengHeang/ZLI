import type { ThreadUsageRecord } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import {
  filterUsage,
  formatCost,
  formatTokens,
  groupUsage,
  latestContext,
  stripUsage,
  sumUsage,
  usageGroupKey,
} from "./usage.js";

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

describe("groupUsage by account", () => {
  it("gives each saved account its own row and keeps the usual login on the provider's", () => {
    const at = "2026-09-20T10:00:00.000Z";
    const rows = groupUsage(
      [
        record("x", "codex", at, { inputTokens: 10 }),
        { ...record("y", "codex", at, { inputTokens: 30 }), accountId: "work" },
        { ...record("z", "codex", at, { inputTokens: 5 }), accountId: "usual" },
      ],
      "provider",
    );
    expect(rows.map((row) => [row.key, row.accountId, row.totals.inputTokens])).toEqual([
      ["codex:work", "work", 30],
      ["codex", undefined, 15],
    ]);
  });
});

describe("stripUsage", () => {
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();

  it("is undefined when nothing ran in the last 7 days", () => {
    expect(stripUsage([], now)).toBeUndefined();
    expect(stripUsage([record("a", "codex", "2026-09-01T10:00:00.000Z", { inputTokens: 5 })], now)).toBeUndefined();
  });

  it("shows today, or the last 7 days when nothing ran today", () => {
    const yesterday = record("a", "codex", at(30), { inputTokens: 100 });
    expect(stripUsage([yesterday], now)?.period).toBe("week");
    const strip = stripUsage([yesterday, record("b", "codex", at(1), { inputTokens: 40 })], now);
    expect(strip?.period).toBe("today");
    expect(strip?.totals.inputTokens).toBe(40);
  });

  it("puts the highest cost first, then the most tokens, one row per account", () => {
    const strip = stripUsage(
      [
        record("a", "codex", at(1), { inputTokens: 9_000 }),
        { ...record("b", "claude-code", at(1), { inputTokens: 100, costUsd: 0.1 }), accountId: "work" },
        record("c", "claude-code", at(1), { inputTokens: 200, costUsd: 0.4 }),
        record("d", "gemini", at(1), { inputTokens: 20_000 }),
      ],
      now,
    );
    expect(strip?.groups.map((group) => group.key)).toEqual(["claude-code", "claude-code:work", "gemini", "codex"]);
    expect(strip?.maxTokens).toBe(20_000);
  });

  it("keys the usual login like the plain provider", () => {
    expect(usageGroupKey("codex", undefined)).toBe("codex");
    expect(usageGroupKey("codex", "usual")).toBe("codex");
    expect(usageGroupKey("codex", "work")).toBe("codex:work");
  });
});
