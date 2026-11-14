import { describe, expect, it } from "vitest";

import type { ThreadId } from "./ids.js";
import {
  appendThreadMessage,
  deliverAgentMessage,
  MAX_ACTIVITIES_PER_THREAD,
  MAX_MESSAGES_PER_THREAD,
  RuntimeProjection,
  recordTurnStatus,
  trimThread,
  upsertThreadActivity,
} from "./projections.js";
import {
  MAX_REASONING_TEXT,
  ThreadActivityProjection,
  type ThreadMessageProjection,
  type ThreadTurnProjection,
} from "./provider.js";

const busy = "00000000-0000-4000-8000-000000000b01" as ThreadId;
const quiet = "00000000-0000-4000-8000-000000000b02" as ThreadId;

function message(threadId: ThreadId, index: number): ThreadMessageProjection {
  return { messageId: `${threadId}-${index}`, threadId, role: "user", text: `message ${index}` };
}

describe("trimThread", () => {
  it("drops only the oldest entries of the thread that went over", () => {
    const items = [
      { threadId: "a", n: 1 },
      { threadId: "b", n: 2 },
      { threadId: "a", n: 3 },
      { threadId: "a", n: 4 },
    ];
    expect(trimThread(items, "a", 2)).toEqual([
      { threadId: "b", n: 2 },
      { threadId: "a", n: 3 },
      { threadId: "a", n: 4 },
    ]);
  });

  it("returns the same list when the thread is under its cap", () => {
    const items = [{ threadId: "a" }];
    expect(trimThread(items, "a", 5)).toBe(items);
  });
});

describe("appendThreadMessage", () => {
  it("keeps an older chat's messages while a busy chat passes its cap", () => {
    let messages: ThreadMessageProjection[] = [message(quiet, 0), message(quiet, 1)];
    for (let index = 0; index < MAX_MESSAGES_PER_THREAD + 50; index += 1) {
      messages = appendThreadMessage(messages, message(busy, index));
    }
    expect(messages.filter((entry) => entry.threadId === quiet)).toHaveLength(2);
    const kept = messages.filter((entry) => entry.threadId === busy);
    expect(kept).toHaveLength(MAX_MESSAGES_PER_THREAD);
    expect(kept[0]?.text).toBe("message 50");
  });

  it("still merges streamed text into the turn's reply", () => {
    const first = { messageId: "m1", threadId: busy, turnId: "t1", role: "assistant" as const, text: "Hel" };
    const second = { messageId: "m2", threadId: busy, turnId: "t1", role: "assistant" as const, text: "lo" };
    expect(appendThreadMessage([first], second)).toEqual([{ ...first, text: "Hello" }]);
  });
});

describe("deliverAgentMessage", () => {
  it("replaces a redelivered message and caps per chat", () => {
    const original = { ...message(busy, 1), role: "agent" as const, sourceThreadId: quiet };
    const again = { ...original, text: "updated" };
    expect(deliverAgentMessage([message(quiet, 0), original], again)).toEqual([message(quiet, 0), again]);
  });
});

describe("upsertThreadActivity", () => {
  it("caps activities per chat", () => {
    const activity = (threadId: ThreadId, index: number): ThreadActivityProjection => ({
      activityId: `${threadId}-${index}`,
      threadId,
      kind: "command",
      title: `step ${index}`,
      status: "completed",
    });
    let activities: ThreadActivityProjection[] = [activity(quiet, 0)];
    for (let index = 0; index < MAX_ACTIVITIES_PER_THREAD + 5; index += 1) {
      activities = upsertThreadActivity(activities, activity(busy, index));
    }
    expect(activities[0]).toEqual(activity(quiet, 0));
    expect(activities.filter((entry) => entry.threadId === busy)).toHaveLength(MAX_ACTIVITIES_PER_THREAD);
  });

  it("stamps when a step started and finished from the times its updates were recorded", () => {
    const step: ThreadActivityProjection = {
      activityId: "a",
      threadId: busy,
      kind: "web",
      title: "Web search zod",
      status: "running",
    };
    let activities = upsertThreadActivity([], step, "2026-01-01T00:00:00.000Z");
    activities = upsertThreadActivity(activities, step, "2026-01-01T00:00:01.000Z");
    expect(activities[0]).toMatchObject({ startedAt: "2026-01-01T00:00:00.000Z" });
    expect(activities[0]?.completedAt).toBeUndefined();
    activities = upsertThreadActivity(
      activities,
      { ...step, status: "completed", urls: [{ url: "https://zod.dev", title: "Zod" }] },
      "2026-01-01T00:00:05.000Z",
    );
    activities = upsertThreadActivity(activities, { ...step, status: "completed" }, "2026-01-01T00:00:09.000Z");
    expect(activities[0]).toMatchObject({
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:05.000Z",
      urls: [{ url: "https://zod.dev", title: "Zod" }],
    });
    // Steps recorded before timestamps existed still parse and stay unstamped without a time.
    expect(upsertThreadActivity([], step)[0]).toEqual(step);
  });

  it("extends a reasoning step's text with each update and keeps the start of long thinking", () => {
    const part = (text: string, status: ThreadActivityProjection["status"] = "running"): ThreadActivityProjection => ({
      activityId: "r",
      threadId: busy,
      kind: "reasoning",
      title: "Thinking",
      status,
      text,
    });
    let activities = upsertThreadActivity([], part("Plan "));
    activities = upsertThreadActivity(activities, part("the fix."));
    expect(activities[0]?.text).toBe("Plan the fix.");
    activities = upsertThreadActivity(activities, part("x".repeat(MAX_REASONING_TEXT), "completed"));
    expect(activities[0]?.text).toHaveLength(MAX_REASONING_TEXT);
    expect(activities[0]?.text?.startsWith("Plan the fix.x")).toBe(true);
    expect(activities[0]).toMatchObject({ truncated: true, status: "completed" });
    expect(ThreadActivityProjection.safeParse(activities[0]).success).toBe(true);
  });
});

describe("recordTurnStatus", () => {
  it("starts a turn when the thread works on it and ends it when the thread goes idle, stops, or fails", () => {
    let turns: ThreadTurnProjection[] = [];
    turns = recordTurnStatus(
      turns,
      { threadId: busy, status: "working", turnId: "u1", providerTurnId: "t1" },
      "2026-01-01T00:00:00.000Z",
    );
    turns = recordTurnStatus(
      turns,
      { threadId: busy, status: "working", providerTurnId: "t1" },
      "2026-01-01T00:00:01.000Z",
    );
    turns = recordTurnStatus(turns, { threadId: busy, status: "waiting" }, "2026-01-01T00:00:02.000Z");
    turns = recordTurnStatus(
      turns,
      { threadId: busy, status: "idle", providerTurnId: "t1" },
      "2026-01-01T00:00:03.000Z",
    );
    turns = recordTurnStatus(
      turns,
      { threadId: busy, status: "working", providerTurnId: "t2" },
      "2026-01-01T00:00:04.000Z",
    );
    turns = recordTurnStatus(turns, { threadId: quiet, status: "working", turnId: "q1" }, "2026-01-01T00:00:05.000Z");
    turns = recordTurnStatus(turns, { threadId: busy, status: "failed" }, "2026-01-01T00:00:06.000Z");
    expect(turns).toEqual([
      {
        threadId: busy,
        turnId: "t1",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:03.000Z",
        status: "completed",
      },
      {
        threadId: busy,
        turnId: "t2",
        startedAt: "2026-01-01T00:00:04.000Z",
        completedAt: "2026-01-01T00:00:06.000Z",
        status: "failed",
      },
      { threadId: quiet, turnId: "q1", startedAt: "2026-01-01T00:00:05.000Z" },
    ]);
    expect(RuntimeProjection.shape.turns.safeParse(turns).success).toBe(true);
  });
});
