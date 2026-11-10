import type { ThreadActivityProjection, ThreadId, ThreadMessageProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import type { TimelineItem } from "../sessions/sessions.js";
import { groupTurns, promptLabel, trailSummary } from "./turns.js";

const threadId = "thread-1" as ThreadId;

function message(id: string, role: ThreadMessageProjection["role"], text: string): TimelineItem {
  return { kind: "message", message: { messageId: id, threadId, role, text } };
}

function activity(id: string, kind: ThreadActivityProjection["kind"], extra: Partial<ThreadActivityProjection> = {}) {
  return { activityId: id, threadId, kind, title: id, status: "completed", ...extra } as ThreadActivityProjection;
}

function work(key: string, activities: ThreadActivityProjection[]): TimelineItem {
  return { kind: "work", key, turnId: key, activities, changedFiles: [] };
}

describe("groupTurns", () => {
  const timeline: TimelineItem[] = [
    message("u1", "user", "Add a health route"),
    message("a1", "assistant", "I'll look first."),
    work("w1", [activity("r1", "file-read", { files: ["src/app.ts"] })]),
    message("a2", "assistant", "Done."),
    message("u2", "user", "Now test it"),
    work("w2", [activity("c1", "command")]),
    message("a3", "assistant", "Tests pass."),
  ];

  it("folds the steps of earlier turns and leaves the latest turn open", () => {
    const { rows } = groupTurns(timeline);
    expect(rows).toEqual([
      { kind: "item", index: 0 },
      { kind: "fold", key: "fold-w1", indexes: [1, 2], activities: [expect.objectContaining({ activityId: "r1" })] },
      { kind: "item", index: 3 },
      { kind: "item", index: 4 },
      { kind: "item", index: 5 },
      { kind: "item", index: 6 },
    ]);
  });

  it("gives each turn's last part the whole reply to copy", () => {
    const { replies, latestStart } = groupTurns(timeline);
    expect(replies.get(3)).toBe("I'll look first.\n\nDone.");
    expect(replies.get(6)).toBe("Tests pass.");
    expect(latestStart).toBe(4);
  });

  it("lists the messages the person sent, without the files attached to them", () => {
    expect(groupTurns(timeline).prompts).toEqual([
      { id: "u1", text: "Add a health route" },
      { id: "u2", text: "Now test it" },
    ]);
  });

  it("keeps a turn open when another agent's note sits among its steps", () => {
    const { rows } = groupTurns([
      message("u1", "user", "Go"),
      message("p1", "agent", "A note from a peer"),
      work("w1", [activity("c1", "command")]),
      message("a1", "assistant", "Done."),
      message("u2", "user", "Next"),
    ]);
    expect(rows.every((row) => row.kind === "item")).toBe(true);
  });

  it("leaves a turn with no steps as it is", () => {
    const { rows } = groupTurns([
      message("u1", "user", "Hi"),
      message("a1", "assistant", "Hello."),
      message("u2", "user", "Bye"),
    ]);
    expect(rows).toEqual([
      { kind: "item", index: 0 },
      { kind: "item", index: 1 },
      { kind: "item", index: 2 },
    ]);
  });
});

describe("trailSummary", () => {
  it("says what the agent did in a few words", () => {
    expect(
      trailSummary([
        activity("r1", "file-read", { files: ["src/app.ts"] }),
        activity("r2", "file-read", { files: ["src/routes.ts"] }),
        activity("s1", "search"),
        activity("e1", "file-edit", { files: ["src/routes.ts"] }),
        activity("c1", "command"),
        activity("c2", "command", { status: "failed" }),
      ]),
    ).toBe("Explored 2 files, 1 search · Edited routes.ts · Ran 2 commands · 1 failed");
  });

  it("counts edited files when there are several", () => {
    expect(
      trailSummary([
        activity("e1", "file-edit", { files: ["a.ts"] }),
        activity("e2", "file-edit", { files: ["b.ts"] }),
        activity("t1", "tool"),
      ]),
    ).toBe("Edited 2 files · Used 1 tool");
  });
});

describe("promptLabel", () => {
  it("is the first line with text", () => {
    expect(promptLabel("\n  Fix the login bug  \nand add a test")).toBe("Fix the login bug");
  });
});
