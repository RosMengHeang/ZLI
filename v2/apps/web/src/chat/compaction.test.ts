import type { ThreadMessageProjection, ThreadTurnProjection, ThreadUsageRecord } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import {
  compactFocus,
  compactionMode,
  compactionReply,
  compactionRequestId,
  compactRequestText,
  DEFAULT_COMPACT_FOCUS,
  endsWithCompaction,
  foldCompactions,
  isCompactionNotice,
  knownContextWindow,
  latestSummary,
  nativeTokensSaved,
  SUMMARY_REQUEST,
  shouldAutoCompact,
  summaryContext,
  summaryTokensSaved,
  withKnownWindow,
} from "./compaction.js";

const threadId = "00000000-0000-4000-8000-000000000901" as ThreadProjectionId;
type ThreadProjectionId = ThreadMessageProjection["threadId"];

function message(
  messageId: string,
  role: ThreadMessageProjection["role"],
  text: string,
  turnId?: string,
): ThreadMessageProjection {
  return { messageId, threadId, role, text, ...(turnId ? { turnId } : {}) };
}

describe("compactionMode", () => {
  it("uses the agent's own compaction only when the runtime says it has one", () => {
    expect(compactionMode({ capabilities: { compaction: "native" } })).toBe("native");
    expect(compactionMode({ capabilities: {} })).toBe("summary");
  });
});

describe("foldCompactions", () => {
  it("turns a /compact into a divider and keeps the rest", () => {
    const messages = [
      message("u1", "user", "Fix it"),
      message("u2", "user", " /compact "),
      message("u3", "user", "Next"),
    ];
    const folded = foldCompactions(messages);
    expect(folded.messages.map((entry) => entry.messageId)).toEqual(["u1", "compact:u2", "u3"]);
    const notice = folded.messages[1] as ThreadMessageProjection;
    expect(isCompactionNotice(notice)).toBe(true);
    expect(compactionRequestId(notice)).toBe("u2");
    expect(folded.compactions.get("u2")).toEqual({ requestId: "u2", mode: "native" });
    // The same request keeps the same divider object, so the timeline reuses its row.
    expect(foldCompactions(messages).messages[1]).toBe(notice);
  });

  it("moves the summary reply into the divider", () => {
    const folded = foldCompactions([
      message("u1", "user", "Fix it"),
      message("a1", "assistant", "Done", "t1"),
      message("u2", "user", SUMMARY_REQUEST),
      message("a2", "assistant", "## Goal\n\nFix it", "t2"),
    ]);
    expect(folded.messages.map((entry) => entry.messageId)).toEqual(["u1", "a1", "compact:u2"]);
    expect(folded.compactions.get("u2")).toEqual({ requestId: "u2", mode: "summary", summary: "## Goal\n\nFix it" });
  });

  it("leaves a chat without compactions as it is", () => {
    const messages = [message("u1", "user", "Run /compact later"), message("u2", "user", "/compacting")];
    expect(foldCompactions(messages).messages).toBe(messages);
  });

  it("keeps a native compaction's reply in the divider and reads a skipped or failed one", () => {
    const folded = foldCompactions([
      message("u1", "user", "/compact keep the API decisions"),
      message("a1", "assistant", "Conversation compacted.", "t1"),
      message("u2", "user", "Go on"),
      message("u3", "user", "/compact"),
      message("a3", "assistant", "Compaction failed: nothing to compact", "t2"),
      message("u4", "user", "/compact"),
      message("a4", "assistant", "Compression failed: the model returned an error", "t3"),
    ]);
    expect(folded.messages.map((entry) => entry.messageId)).toEqual(["compact:u1", "u2", "compact:u3", "compact:u4"]);
    expect(folded.compactions.get("u1")).toEqual({
      requestId: "u1",
      mode: "native",
      reply: "Conversation compacted.",
    });
    expect(folded.compactions.get("u3")).toMatchObject({ outcome: "skipped", detail: "nothing to compact" });
    expect(folded.compactions.get("u4")).toMatchObject({
      outcome: "failed",
      detail: "Compression failed: the model returned an error",
    });
  });
});

describe("compact requests", () => {
  const claude = { capabilities: { compaction: "native", compactionInstructions: true } } as const;
  const codex = { capabilities: { compaction: "native" } } as const;
  const gemini = { capabilities: {} };

  it("reads the focus after /compact", () => {
    expect(compactFocus(" /compact  keep the API decisions ")).toBe("keep the API decisions");
    expect(compactFocus("/compact")).toBeUndefined();
    expect(compactFocus("hello")).toBeUndefined();
  });

  it("sends the focus only where the agent takes one, and into ZLI's own summary request", () => {
    expect(compactRequestText(claude, "keep the API decisions")).toBe("/compact keep the API decisions");
    expect(compactRequestText(claude, undefined)).toBe("/compact");
    expect(compactRequestText(codex, "keep the API decisions")).toBe("/compact");
    expect(compactRequestText(gemini, undefined)).toBe(SUMMARY_REQUEST);
    expect(compactRequestText(gemini, DEFAULT_COMPACT_FOCUS)).toBe(
      `${SUMMARY_REQUEST}

Pay most attention to this: ${DEFAULT_COMPACT_FOCUS}`,
    );
  });
});

describe("compactionReply", () => {
  it("tells a skipped or failed compaction from a normal one", () => {
    expect(compactionReply("Nothing to compact.")).toEqual({ outcome: "skipped", detail: "Nothing to compact." });
    expect(compactionReply("Chat history is already compressed.")).toMatchObject({ outcome: "skipped" });
    expect(compactionReply("Compression aborted: too few messages")).toMatchObject({ outcome: "failed" });
    expect(compactionReply("This agent does not take focus instructions")).toMatchObject({ outcome: "failed" });
    expect(compactionReply("Context compacted.")).toBeUndefined();
    expect(compactionReply("")).toBeUndefined();
    // A long summary that happens to use the words is still a summary.
    expect(compactionReply(`Compaction failed earlier. ${"x".repeat(600)}`)).toBeUndefined();
  });
});

describe("latestSummary and summaryContext", () => {
  it("finds the newest summary and what was said after it", () => {
    const messages = [
      message("u1", "user", SUMMARY_REQUEST),
      message("a1", "assistant", "Old summary"),
      message("u2", "user", SUMMARY_REQUEST),
      message("a2", "assistant", "New summary"),
      message("u3", "user", "One more thing"),
    ];
    const found = latestSummary(messages);
    expect(found?.summary).toBe("New summary");
    expect(found?.after.map((entry) => entry.messageId)).toEqual(["u3"]);
    const context = summaryContext({ ...(found as NonNullable<typeof found>), branch: "main", nameOf: () => "Gemini" });
    expect(context).toContain("<summary>\nNew summary\n</summary>");
    expect(context).toContain("## User\n\nOne more thing");
    expect(context).toContain("on branch main");
    expect(context.endsWith("The person's new message:")).toBe(true);
  });

  it("has no summary until the agent answers the request", () => {
    expect(latestSummary([message("u1", "user", SUMMARY_REQUEST)])).toBeUndefined();
  });
});

describe("knownContextWindow", () => {
  it("knows the windows of models whose agents may not report one", () => {
    expect(knownContextWindow("claude-sonnet-4-5")).toBe(200_000);
    expect(knownContextWindow("sonnet[1m]")).toBe(1_000_000);
    expect(knownContextWindow("gemini-2.5-pro")).toBe(1_048_576);
    expect(knownContextWindow("some-new-model")).toBeUndefined();
    expect(knownContextWindow(undefined)).toBeUndefined();
  });

  it("keeps the window the agent reported", () => {
    expect(withKnownWindow({ tokens: 10, window: 50 }, "claude-opus-4")).toEqual({ tokens: 10, window: 50 });
    expect(withKnownWindow({ tokens: 10 }, "claude-opus-4")).toEqual({ tokens: 10, window: 200_000 });
    expect(withKnownWindow({ tokens: 10 }, "mystery")).toEqual({ tokens: 10 });
  });
});

describe("shouldAutoCompact", () => {
  const base = {
    enabled: true,
    threshold: 0.85,
    context: { tokens: 180_000, window: 200_000 },
    idle: true,
    busy: false,
    justCompacted: false,
  };

  it("compacts an idle chat past the threshold", () => {
    expect(shouldAutoCompact(base)).toBe(true);
    expect(shouldAutoCompact({ ...base, context: { tokens: 160_000, window: 200_000 } })).toBe(false);
  });

  it("never compacts mid-turn, while busy, twice in a row, when off, or without a known window", () => {
    expect(shouldAutoCompact({ ...base, idle: false })).toBe(false);
    expect(shouldAutoCompact({ ...base, busy: true })).toBe(false);
    expect(shouldAutoCompact({ ...base, justCompacted: true })).toBe(false);
    expect(shouldAutoCompact({ ...base, enabled: false })).toBe(false);
    expect(shouldAutoCompact({ ...base, context: { tokens: 180_000 } })).toBe(false);
  });
});

describe("endsWithCompaction", () => {
  it("is true right after a compaction request or its summary", () => {
    expect(endsWithCompaction([message("u1", "user", "/compact")])).toBe(true);
    expect(endsWithCompaction([message("u1", "user", SUMMARY_REQUEST), message("a1", "assistant", "S")])).toBe(true);
    expect(endsWithCompaction([message("u1", "user", "/compact"), message("u2", "user", "Go on")])).toBe(false);
    expect(endsWithCompaction([message("u1", "user", "Hi"), message("a1", "assistant", "Hello")])).toBe(false);
    expect(endsWithCompaction([message("u1", "user", "/compact"), message("a1", "assistant", "Compacted.")])).toBe(
      true,
    );
  });
});

describe("tokens saved", () => {
  const record = (turnId: string, at: string, contextTokens: number): ThreadUsageRecord => ({
    usageId: `${turnId}-usage`,
    threadId,
    turnId,
    provider: "claude-code",
    recordedAt: at,
    usage: { contextTokens },
  });
  const turn = (turnId: string, startedAt: string): ThreadTurnProjection => ({ threadId, turnId, startedAt });

  it("reads a native compaction's saving from the usage before and during its turn", () => {
    const saved = nativeTokensSaved({
      requestId: "u2",
      messages: [
        message("u1", "user", "Fix it"),
        message("a1", "assistant", "Done"),
        message("u2", "user", "/compact"),
      ],
      turns: [turn("t2", "2026-11-21T10:05:00Z"), turn("t1", "2026-11-21T10:00:00Z")],
      usage: [record("t1", "2026-11-21T10:01:00Z", 150_000), record("t2", "2026-11-21T10:05:30Z", 12_000)],
    });
    expect(saved).toBe(138_000);
  });

  it("says nothing when the compaction turn reported no context", () => {
    expect(
      nativeTokensSaved({
        requestId: "u1",
        messages: [message("u1", "user", "/compact")],
        turns: [turn("t1", "2026-11-21T10:05:00Z")],
        usage: [],
      }),
    ).toBeUndefined();
  });

  it("estimates the summary way from the fresh session, or the summary's size before it reports", () => {
    expect(summaryTokensSaved({ before: 100_000, freshContext: 8_000, summary: "x" })).toBe(92_000);
    expect(summaryTokensSaved({ before: 100_000, freshContext: undefined, summary: "x".repeat(4_000) })).toBe(99_000);
    expect(summaryTokensSaved({ before: undefined, freshContext: 8_000, summary: "x" })).toBeUndefined();
  });
});
