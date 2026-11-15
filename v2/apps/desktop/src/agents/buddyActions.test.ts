import type { BuddyProjection, RuntimeProjection, TaskProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { createBuddyActions, suitedBuddy } from "./buddyActions.js";

const at = "2026-11-15T09:00:00.000Z";
const buddy = (buddyId: string, name: string, title?: string, order = 0): BuddyProjection => ({
  buddyId,
  name,
  ...(title ? { title } : {}),
  color: "sky",
  role: name === "Primary" ? "primary" : "buddy",
  order,
  engine: { mode: "auto" },
  permissionMode: "full-access",
  maxActiveJobs: 2,
  handoffs: [],
  memory: [],
  pendingMemory: [],
  createdAt: at,
  updatedAt: at,
});
const job: TaskProjection = {
  taskId: "t1",
  buddyId: "b1",
  projectId: "p1",
  kind: "job",
  goal: "Add a login page",
  origin: { kind: "chat" },
  worktreeId: "w1",
  branch: "builder/login",
  picks: [],
  handoffDepth: 0,
  status: "working",
  questions: [],
  revisions: [],
  reviews: [],
  createdAt: at,
  updatedAt: at,
};
const state = {
  projects: [{ projectId: "p1", name: "web", path: "/web" }],
  buddies: [
    buddy("b0", "Primary"),
    buddy("b1", "Builder", "Builder", 1),
    buddy("b2", "Tess", "Tester", 2),
    buddy("b3", "Dot", "Docs", 3),
  ],
  tasks: [job],
} as unknown as RuntimeProjection;

function host() {
  const sent: Record<string, unknown>[] = [];
  let id = 0;
  const actions = createBuddyActions({
    projection: () => state,
    caller: () => ({ worktreeId: "w1", project: state.projects[0] as RuntimeProjection["projects"][number] }),
    run: async (command) => {
      sent.push(command);
      return {};
    },
    newId: () => `id-${++id}`,
  });
  return { actions, sent };
}

describe("buddy actions", () => {
  it("picks the buddy whose title suits the goal, never the caller or the Primary", () => {
    expect(suitedBuddy(state, "Write tests for the login page", "b1")?.name).toBe("Tess");
    expect(suitedBuddy(state, "Update the README", "b1")?.name).toBe("Dot");
  });

  it("finishes the caller's job by its worktree", async () => {
    const { actions, sent } = host();
    await actions.buddydone({ summary: "Added the page." });
    expect(sent).toEqual([{ type: "task.finish", taskId: "t1", summary: "Added the page." }]);
  });

  it("hands work on from the caller's branch and links it to the caller's job", async () => {
    const { actions, sent } = host();
    const result = (await actions.buddyhandoff({ goal: "Write tests for the login page" })) as { handedTo: string };
    expect(result.handedTo).toBe("Tess");
    expect(sent[0]).toMatchObject({
      type: "task.assign",
      task: { buddyId: "b2", parentTaskId: "t1", baseRef: "builder/login", origin: { kind: "agent" } },
    });
  });

  it("refuses a routine with no schedule or event", async () => {
    const { actions } = host();
    await expect(actions.buddyroutine({ buddy: "Tess", goal: "Run tests" })).rejects.toThrow(/schedule/u);
    const { actions: ok, sent } = host();
    await ok.buddyroutine({ buddy: "Tess", goal: "Run tests", schedule: "0 9 * * 1-5" });
    expect(sent[0]).toMatchObject({
      type: "routine.create",
      routine: { trigger: { kind: "schedule", cron: "0 9 * * 1-5" } },
    });
  });
});
