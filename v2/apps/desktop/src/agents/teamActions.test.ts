import type { BuddyProjection, GoalProjection, RuntimeProjection, TaskProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { createBuddyActions } from "./buddyActions.js";

const at = "2026-11-15T09:00:00.000Z";
const buddy = (buddyId: string, name: string, role: "primary" | "buddy" = "buddy"): BuddyProjection => ({
  buddyId,
  name,
  color: "jade",
  role,
  order: 0,
  engine: { mode: "auto" },
  permissionMode: "full-access",
  maxActiveJobs: 2,
  handoffs: [],
  memory: [],
  pendingMemory: [],
  createdAt: at,
  updatedAt: at,
});
const project = { projectId: "p1", path: "/work/web", name: "web" };

function harness(extra: Partial<RuntimeProjection> = {}) {
  const state = {
    projects: [project],
    worktrees: [],
    buddies: [buddy("lead", "Primary", "primary"), buddy("b2", "Builder"), buddy("b3", "Tester")],
    tasks: [],
    goals: [],
    ...extra,
  } as unknown as RuntimeProjection;
  const sent: Record<string, unknown>[] = [];
  let next = 0;
  const actions = createBuddyActions({
    projection: () => state,
    caller: () => ({ worktreeId: "w-lead", project: project as never }),
    run: async (command) => {
      sent.push(command);
      return {};
    },
    newId: () => `id-${++next}`,
  });
  return { actions, sent };
}

const planTurn: TaskProjection = {
  taskId: "plan1",
  buddyId: "lead",
  projectId: "p1",
  kind: "job",
  goal: "Add dark mode",
  origin: { kind: "goal", goalId: "g1" },
  picks: [],
  handoffDepth: 0,
  status: "working",
  worktreeId: "w-lead",
  questions: [],
  revisions: [],
  reviews: [],
  createdAt: at,
  updatedAt: at,
};
const teamGoal: GoalProjection = {
  goalId: "g1",
  buddyId: "lead",
  text: "Add dark mode",
  projectId: "p1",
  status: "working",
  rounds: 1,
  resumes: 0,
  createdAt: at,
  updatedAt: at,
  team: { phase: "planning", autoStart: false, reviewRounds: 1, buddyIds: [], plan: [] },
};

describe("start_team", () => {
  it("starts a team the Primary leads, with the buddies it names", async () => {
    const { actions, sent } = harness();
    const result = (await actions.buddystartteam({ goal: "Add dark mode", buddies: ["Builder", "tester"] })) as {
      lead: string;
      goalId: string;
    };
    expect(result.lead).toBe("Primary");
    expect(sent).toEqual([
      {
        type: "goal.create",
        goal: {
          goalId: result.goalId,
          buddyId: "lead",
          text: "Add dark mode",
          projectId: "p1",
          team: { buddyIds: ["b2", "b3"] },
        },
      },
    ]);
  });

  it("passes on auto-start, and refuses a buddy who is not on the team", async () => {
    const { actions, sent } = harness();
    await actions.buddystartteam({ goal: "Fix login", autoStart: true });
    expect(sent[0]).toMatchObject({ goal: { team: { autoStart: true } } });
    await expect(actions.buddystartteam({ goal: "Fix login", buddies: ["Nobody"] })).rejects.toThrow(
      "No buddy called Nobody.",
    );
  });
});

describe("team_plan", () => {
  it("hands in the lead's plan with each buddy by name", async () => {
    const { actions, sent } = harness({ tasks: [planTurn], goals: [teamGoal] });
    const result = (await actions.buddyteamplan({
      tasks: [{ title: "Theme tokens", buddy: "Builder", notes: "CSS variables" }, { title: "Settings toggle" }],
      notes: "Small change.",
    })) as { planned: number; note: string };
    expect(result.planned).toBe(2);
    expect(result.note).toContain("The person checks the plan");
    expect(sent).toEqual([
      {
        type: "goal.plan.submit",
        goalId: "g1",
        plan: [
          { planTaskId: "id-1", title: "Theme tokens", buddyId: "b2", notes: "CSS variables" },
          { planTaskId: "id-2", title: "Settings toggle" },
        ],
        notes: "Small change.",
      },
    ]);
  });

  it("is only for a team lead's planning turn, and keeps assign_task out of it", async () => {
    const plain = harness({ tasks: [planTurn], goals: [{ ...teamGoal, team: undefined } as GoalProjection] });
    await expect(plain.actions.buddyteamplan({ tasks: [{ title: "x" }] })).rejects.toThrow(
      "team_plan is for a team lead's planning turn.",
    );
    const lead = harness({ tasks: [planTurn], goals: [teamGoal] });
    await expect(lead.actions.buddyassign({ buddy: "Builder", goal: "Do it" })).rejects.toThrow(
      "You are planning a team. Hand in the tasks with team_plan instead.",
    );
  });
});
