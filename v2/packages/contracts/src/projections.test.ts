import { describe, expect, it } from "vitest";

import type { ThreadId } from "./ids.js";
import {
  appendThreadMessage,
  deliverAgentMessage,
  MAX_ACTIVITIES_PER_THREAD,
  MAX_MESSAGES_PER_THREAD,
  trimThread,
  upsertThreadActivity,
} from "./projections.js";
import type { ThreadActivityProjection, ThreadMessageProjection } from "./provider.js";

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
});
