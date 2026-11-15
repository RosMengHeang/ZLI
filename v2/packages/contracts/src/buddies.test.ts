import { describe, expect, it } from "vitest";

import {
  applyBuddyEvent,
  type BuddyEvent,
  type BuddyState,
  buddiesInOrder,
  firstSentence,
  needsYou,
  RuntimeCommand,
  RuntimeEvent,
} from "./index.js";

const at = "2026-11-15T09:00:00.000Z";
const buddy = (buddyId: string, name: string, role: "primary" | "buddy" = "buddy") => ({
  buddyId,
  name,
  color: "sky" as const,
  role,
  engine: { mode: "auto" as const },
  permissionMode: "full-access" as const,
  maxActiveJobs: 2,
  handoffs: [],
});

function fold(events: BuddyEvent[], state: BuddyState = {}): Required<BuddyState> {
  let next = state as Required<BuddyState>;
  for (const event of events) next = applyBuddyEvent(next, event, at);
  return next;
}

const assign = (taskId: string, buddyId: string, extra: Record<string, unknown> = {}): BuddyEvent => ({
  type: "task.assigned",
  task: {
    taskId,
    buddyId,
    projectId: "p1",
    kind: "job",
    goal: "Fix the flaky checkout test. It fails on CI.",
    origin: { kind: "chat" },
    ...extra,
  },
  handoffDepth: 0,
});

describe("buddies", () => {
  it("keeps the Primary on top and the rest in the order the person set", () => {
    const state = fold([
      { type: "buddy.created", buddy: buddy("a", "Builder"), order: 0 },
      { type: "buddy.created", buddy: buddy("b", "Tester"), order: 1 },
      { type: "buddy.created", buddy: buddy("c", "Primary", "primary"), order: 2 },
      { type: "buddy.reordered", buddyIds: ["b", "a", "c"] },
    ]);
    expect(buddiesInOrder(state).map((entry) => entry.name)).toEqual(["Primary", "Tester", "Builder"]);
  });

  it("writes the buddy's row as a sentence about its latest job", () => {
    const state = fold([{ type: "buddy.created", buddy: buddy("a", "Builder"), order: 0 }, assign("t1", "a")]);
    expect(state.buddies?.[0]?.lastLine?.text).toBe("Up next: fix the flaky checkout test");
    const working = fold([{ type: "task.status.changed", taskId: "t1", status: "working" }], state);
    expect(working.buddies?.[0]?.lastLine?.text).toBe("Working on fix the flaky checkout test");
  });

  it("puts open questions and ready jobs in Needs you, and clears them once answered", () => {
    const state = fold([
      { type: "buddy.created", buddy: buddy("a", "Builder"), order: 0 },
      assign("t1", "a"),
      { type: "task.question.asked", taskId: "t1", question: { questionId: "q1", text: "Which API version?" } },
    ]);
    expect(needsYou(state).map((task) => task.taskId)).toEqual(["t1"]);
    const answered = fold([{ type: "task.question.answered", taskId: "t1", questionId: "q1", answer: "v2" }], state);
    expect(needsYou(answered)).toEqual([]);
    expect(answered.tasks?.[0]?.status).toBe("working");
  });

  it("pauses a routine after three failed runs in a row", () => {
    let state = fold([
      { type: "buddy.created", buddy: buddy("a", "Builder"), order: 0 },
      {
        type: "routine.created",
        routine: {
          routineId: "r1",
          buddyId: "a",
          projectId: "p1",
          goal: "Run tests",
          trigger: { kind: "schedule", cron: "0 9 * * 1-5" },
          paused: false,
        },
      },
    ]);
    for (const taskId of ["t1", "t2", "t3"])
      state = fold(
        [
          assign(taskId, "a", { origin: { kind: "routine", routineId: "r1" } }),
          { type: "task.status.changed", taskId, status: "failed" },
        ],
        state,
      );
    expect(state.routines?.[0]).toMatchObject({ failuresInRow: 3, paused: true });
  });

  it("keeps a proposed lesson only when the person accepts it, with their edit", () => {
    const state = fold([
      { type: "buddy.created", buddy: buddy("a", "Builder"), order: 0 },
      { type: "buddy.memory.proposed", buddyId: "a", note: { noteId: "n1", text: "Run pnpm test", source: "lesson" } },
      { type: "buddy.memory.accepted", buddyId: "a", noteId: "n1", text: "Run pnpm verify" },
    ]);
    expect(state.buddies?.[0]?.pendingMemory).toEqual([]);
    expect(state.buddies?.[0]?.memory.map((note) => note.text)).toEqual(["Run pnpm verify"]);
  });

  it("parses buddy commands and events as runtime ones", () => {
    expect(RuntimeCommand.safeParse({ type: "buddies.pause" }).success).toBe(true);
    expect(RuntimeEvent.safeParse({ type: "buddies.paused" }).success).toBe(true);
  });

  it("shortens to the first sentence", () => {
    expect(firstSentence("Add a login page. Then tests.")).toBe("Add a login page");
  });
});
