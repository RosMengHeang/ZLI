import type { PullRequestInfo, ThreadActivityProjection, ThreadUsageRecord } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { checksView, mcpServerOf, mcpUsage, percent, pullRequestTone, sessionTokens } from "./overview.js";

const record = (usage: ThreadUsageRecord["usage"], index = 0): ThreadUsageRecord =>
  ({ usageId: `u${index}`, threadId: "t", turnId: `turn${index}`, provider: "claudeCode", usage }) as ThreadUsageRecord;

const tool = (title: string, status: ThreadActivityProjection["status"] = "completed", kind = "tool") =>
  ({ activityId: title + status, threadId: "t", kind, title, status }) as ThreadActivityProjection;

const pr = (checks: PullRequestInfo["checks"], extra: Partial<PullRequestInfo> = {}): PullRequestInfo => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  isDraft: false,
  ...(checks ? { checks } : {}),
  ...extra,
});

describe("sessionTokens", () => {
  it("splits the session into cache read, uncached input, and output", () => {
    const tokens = sessionTokens([
      record({ inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100 }, 0),
      record({ inputTokens: 2000, cachedInputTokens: 1800, outputTokens: 300 }, 1),
    ]);
    expect(tokens?.total).toBe(3400);
    expect(tokens?.rows.map((row) => [row.label, row.tokens])).toEqual([
      ["Cache read", 2600],
      ["Uncached input", 400],
      ["Output", 400],
    ]);
    expect(tokens?.rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1);
  });

  it("leaves out the cache row for an agent that reports no cache, and is absent with no token counts", () => {
    expect(sessionTokens([record({ inputTokens: 50, outputTokens: 10 })])?.rows.map((row) => row.id)).toEqual([
      "uncached",
      "output",
    ]);
    expect(sessionTokens([record({ contextTokens: 10 })])).toBeUndefined();
    expect(sessionTokens([])).toBeUndefined();
  });
});

describe("percent", () => {
  it("never rounds a share that is there down to nothing, or up to all", () => {
    expect(percent(0)).toBe("0%");
    expect(percent(0.004)).toBe("<1%");
    expect(percent(0.08)).toBe("8%");
    expect(percent(0.996)).toBe("99%");
    expect(percent(1)).toBe("100%");
  });
});

describe("mcpServerOf", () => {
  it("reads the server from Claude, Codex, and Gemini tool names", () => {
    expect(mcpServerOf(tool("mcp__zli-browser__browser_open"))).toBe("zli-browser");
    expect(mcpServerOf(tool("mcp__github__create_issue"))).toBe("github");
    expect(mcpServerOf(tool("linear.list_issues"))).toBe("linear");
    expect(mcpServerOf(tool("task_done (zli MCP Server)"))).toBe("zli");
  });

  it("ignores the agent's own tools and steps that are not tool calls", () => {
    expect(mcpServerOf(tool("TodoWrite"))).toBeUndefined();
    expect(mcpServerOf(tool("Read src/app.ts"))).toBeUndefined();
    expect(mcpServerOf(tool("mcp__github__create_issue", "completed", "command"))).toBeUndefined();
  });
});

describe("mcpUsage", () => {
  it("counts calls and failures per server, most called first", () => {
    expect(
      mcpUsage([tool("mcp__github__a"), tool("mcp__linear__a"), tool("mcp__github__b", "failed"), tool("Bash")]),
    ).toEqual([
      { server: "github", calls: 2, failed: 1 },
      { server: "linear", calls: 1, failed: 0 },
    ]);
  });
});

describe("checksView", () => {
  it("says how many passed, and puts failing checks first", () => {
    expect(
      checksView(
        pr([
          { name: "a", state: "passed" },
          { name: "b", state: "passed" },
        ]),
      )?.headline,
    ).toBe("2/2 passed");
    const failing = checksView(
      pr([
        { name: "lint", state: "passed" },
        { name: "test", state: "failed" },
        { name: "build", state: "pending" },
      ]),
    );
    expect(failing?.tone).toBe("failed");
    expect(failing?.headline).toBe("1 failed");
    expect(failing?.checks.map((check) => check.name)).toEqual(["test", "build", "lint"]);
    expect(checksView(pr([{ name: "build", state: "pending" }]))?.headline).toBe("1 running");
  });

  it("is absent without a pull request or checks", () => {
    expect(checksView(undefined)).toBeUndefined();
    expect(checksView(pr(undefined))).toBeUndefined();
    expect(checksView(pr([{ name: "x", state: "skipped" }]))).toBeUndefined();
  });
});

describe("pullRequestTone", () => {
  it("names the state the way the forge shows it", () => {
    expect(pullRequestTone({ state: "OPEN", isDraft: true })).toBe("draft");
    expect(pullRequestTone({ state: "OPEN", isDraft: false })).toBe("open");
    expect(pullRequestTone({ state: "MERGED", isDraft: false })).toBe("merged");
    expect(pullRequestTone({ state: "CLOSED", isDraft: false })).toBe("closed");
  });
});
