import { describe, expect, it } from "vitest";

import {
  applyBuddyEvent,
  type BuddyEvent,
  type BuddyProjection,
  BuddyProjection as BuddyProjectionSchema,
  type BuddyState,
  buddiesInOrder,
  firstSentence,
  guessProject,
  isBuddyHome,
  isBuddyToolCall,
  needsYou,
  overBudget,
  playbooksFor,
  RuntimeCommand,
  RuntimeEvent,
  rulesOf,
  rulesText,
  spentThisWeek,
  type TaskProjection,
  workProjects,
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

describe("playbooks", () => {
  const save = (playbookId: string, title: string, steps: string[], projectId = "p1"): BuddyEvent => ({
    type: "buddy.playbook.saved",
    buddyId: "a",
    playbook: { playbookId, projectId, title, steps },
  });

  it("keeps one playbook per title in a project, the newest steps winning", () => {
    const state = fold([
      { type: "buddy.created", buddy: buddy("a", "Builder"), order: 0 },
      save("p-1", "Add an API route", ["Add the handler in src/routes"]),
      save("p-2", "add an api route", ["Add the handler in src/api", "Run pnpm test:api"]),
      save("p-3", "Add an API route", ["Elsewhere"], "p2"),
    ]);
    const playbooks = state.buddies?.[0]?.playbooks ?? [];
    expect(playbooks.map((entry) => [entry.projectId, entry.steps.length])).toEqual([
      ["p1", 2],
      ["p2", 1],
    ]);
    const removed = fold([{ type: "buddy.playbook.removed", buddyId: "a", playbookId: "p-3" }], state);
    expect(removed.buddies?.[0]?.playbooks).toHaveLength(1);
  });

  it("offers a job the playbooks of its project that share the most words with it", () => {
    const state = fold([
      { type: "buddy.created", buddy: buddy("a", "Builder"), order: 0 },
      save("p-1", "Release a version", ["Bump package.json", "Tag and push"]),
      save("p-2", "Add an API route", ["Add the handler in src/api", "Run the api tests"]),
      save("p-3", "Add an API route elsewhere", ["Other project"], "p2"),
    ]);
    const found = playbooksFor(state.buddies?.[0] as never, "p1", "Add a route to the API for invoices");
    expect(found.map((entry) => entry.title)).toEqual(["Add an API route", "Release a version"]);
  });
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

describe("isBuddyToolCall", () => {
  it("knows ZLI's buddy tools in each agent's naming, and nothing else", () => {
    for (const name of [
      "mcp__zli__task_done",
      "zli___remember",
      "zli_ask_person",
      "zli:hand_off",
      "task_done (zli MCP Server)",
    ])
      expect(isBuddyToolCall(name), name).toBe(true);
    for (const name of [
      "Bash",
      "mcp__zli__browser_open",
      "mcp__zli-browser__task_done",
      "zli-mobile:task_done",
      "task_done",
      "mcp__other__task_done",
      "task_done (zli-mobile MCP Server)",
    ])
      expect(isBuddyToolCall(name), name).toBe(false);
  });
});

describe("buddy homes, rules and budgets", () => {
  it("knows the homes folder and keeps it out of project guesses", () => {
    const projects = [
      { projectId: "p1", name: "Shop", path: "D:/code/shop" },
      { projectId: "home", name: "zli-buddy-homes", path: "C:/data/zli-buddy-homes/" },
    ];
    expect(isBuddyHome(projects[1])).toBe(true);
    expect(isBuddyHome(projects[0])).toBe(false);
    expect(workProjects(projects).map((project) => project.projectId)).toEqual(["p1"]);
    // With the homes left out, one real project is the only answer.
    expect(guessProject("fix the cart", projects, [], "b1", undefined)).toEqual({ projectId: "p1", why: "named" });
  });

  it("counts a week of a buddy's spending against its budget", () => {
    const now = new Date("2026-11-18T12:00:00Z");
    const task = (taskId: string, endedAt: string, costUsd: number) =>
      ({
        taskId,
        buddyId: "b1",
        endedAt,
        updatedAt: endedAt,
        result: { costUsd },
      }) as unknown as TaskProjection;
    const tasks = [task("old", "2026-11-01T00:00:00Z", 50), task("new", "2026-11-17T00:00:00Z", 3)];
    expect(spentThisWeek({ tasks }, "b1", now)).toBe(3);
    const spender = { buddyId: "b1", budgetUsd: 2 } as BuddyProjection;
    expect(overBudget({ tasks }, spender, now)).toBe(true);
    expect(overBudget({ tasks }, { ...spender, budgetUsd: 5 }, now)).toBe(false);
    expect(rulesText(rulesOf({})).join("\n")).toContain("Pay or buy anything");
  });
});

describe("buddy personality", () => {
  const saved = { ...buddy("a", "Builder"), order: 0, memory: [], pendingMemory: [], createdAt: at, updatedAt: at };

  it("still loads a buddy saved before personalities", () => {
    const parsed = BuddyProjectionSchema.parse(saved);
    expect(parsed.personality).toBeUndefined();
    expect(parsed.sampleReply).toBeUndefined();
  });

  it("loads a preset or custom voice with a sample, and refuses one that is too long", () => {
    const parsed = BuddyProjectionSchema.parse({
      ...saved,
      personality: " dry ",
      sampleReply: "Fixed. It was the cache.",
    });
    expect(parsed.personality).toBe("dry");
    expect(parsed.sampleReply).toBe("Fixed. It was the cache.");
    expect(BuddyProjectionSchema.safeParse({ ...saved, personality: "x".repeat(121) }).success).toBe(false);
    expect(BuddyProjectionSchema.safeParse({ ...saved, sampleReply: "x".repeat(301) }).success).toBe(false);
  });

  it("sets the voice through an update, and empty clears it", () => {
    const created = fold([{ type: "buddy.created", buddy: buddy("a", "Builder"), order: 0 }]);
    const set = fold(
      [
        {
          type: "buddy.updated",
          buddyId: "a",
          changes: { personality: "calm", sampleReply: "No rush. Done by noon." },
        },
      ],
      created,
    );
    expect(set.buddies?.[0]).toMatchObject({ personality: "calm", sampleReply: "No rush. Done by noon." });
    const cleared = fold([{ type: "buddy.updated", buddyId: "a", changes: { personality: "", sampleReply: "" } }], set);
    expect(cleared.buddies?.[0]?.personality).toBeUndefined();
    expect(cleared.buddies?.[0]?.sampleReply).toBeUndefined();
    expect(
      RuntimeCommand.safeParse({ type: "buddy.update", buddyId: "a", changes: { personality: "dry" } }).success,
    ).toBe(true);
  });
});
