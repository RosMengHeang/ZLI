import { describe, expect, it } from "vitest";

import {
  applyBuddyEvent,
  type BuddyProjection,
  type BuddyState,
  DEFAULT_TEAM_DEFAULTS,
  type GoalProjection,
  RuntimeCommand,
  type TaskProjection,
  teamDefaults,
  teamReviewer,
  teamTaskState,
} from "./index.js";

const at = "2026-11-15T09:00:00.000Z";
const buddy = (buddyId: string, name: string, title?: string): BuddyProjection => ({
  buddyId,
  name,
  ...(title ? { title } : {}),
  color: "jade",
  role: buddyId === "lead" ? "primary" : "buddy",
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
const task = (extra: Partial<TaskProjection>): TaskProjection => ({
  taskId: "t1",
  buddyId: "b2",
  projectId: "p1",
  kind: "job",
  goal: "Theme tokens",
  origin: { kind: "primary", goalId: "g1" },
  picks: [],
  handoffDepth: 0,
  status: "ready",
  questions: [],
  revisions: [],
  reviews: [],
  createdAt: at,
  updatedAt: at,
  ...extra,
});
const team = { buddyId: "lead", team: { buddyIds: [] as string[], reviewRounds: 1 } };
const buddies = [buddy("lead", "Primary"), buddy("b2", "Builder"), buddy("b3", "Quinn", "QA")];

describe("teams", () => {
  it("says where each task of the plan is", () => {
    const state = (tasks: TaskProjection[]) => ({ buddies, tasks });
    expect(teamTaskState(state([]), team, {})).toBe("planned");
    expect(teamTaskState(state([task({ status: "working" })]), team, { taskId: "t1" })).toBe("working");
    // Finished, but not reviewed yet.
    expect(teamTaskState(state([task({})]), team, { taskId: "t1" })).toBe("in_review");
    expect(
      teamTaskState(state([task({ reviews: [{ taskId: "r", buddyId: "b3", verdict: "ok", notes: [] }] })]), team, {
        taskId: "t1",
      }),
    ).toBe("done");
    // Out of review rounds with notes: the person decides, and can take it as it is.
    const noted = task({ reviews: [{ taskId: "r", buddyId: "b3", verdict: "notes", notes: ["x"] }] });
    expect(teamTaskState(state([noted]), team, { taskId: "t1" })).toBe("needs_you");
    expect(teamTaskState(state([noted]), team, { taskId: "t1", accepted: true })).toBe("done");
    expect(teamTaskState(state([task({ status: "failed" })]), team, { taskId: "t1" })).toBe("failed");
    expect(teamTaskState(state([task({ status: "cancelled" })]), team, { taskId: "t1" })).toBe("dropped");
    // No review rounds, or nobody else to review: done as soon as it finishes.
    expect(
      teamTaskState(state([task({})]), { ...team, team: { ...team.team, reviewRounds: 0 } }, { taskId: "t1" }),
    ).toBe("done");
    expect(teamTaskState({ buddies: [buddy("b2", "Builder")], tasks: [task({})] }, team, { taskId: "t1" })).toBe(
      "done",
    );
  });

  it("picks a reviewer other than the one who did the work, a tester first", () => {
    expect(teamReviewer({ buddies }, team, { buddyId: "b2" })?.name).toBe("Quinn");
    expect(teamReviewer({ buddies }, team, { buddyId: "b3" })?.name).toBe("Builder");
  });

  it("folds a team from its events, and fills the defaults the person left out", () => {
    let state: BuddyState = { buddies, goals: [] };
    const fold = (event: Parameters<typeof applyBuddyEvent>[1]) => {
      state = applyBuddyEvent(state, event, at);
    };
    fold({
      type: "goal.created",
      goal: {
        goalId: "g1",
        buddyId: "lead",
        text: "Add dark mode",
        projectId: "p1",
        team: { autoStart: false, reviewRounds: 1, buddyIds: [] },
      },
    });
    fold({ type: "goal.plan.submitted", goalId: "g1", plan: [{ planTaskId: "a", title: "Tokens", buddyId: "b2" }] });
    expect(state.goals?.[0]?.team).toMatchObject({ phase: "plan_ready", plan: [{ title: "Tokens" }] });
    fold({
      type: "goal.plan.approved",
      goalId: "g1",
      plan: [{ planTaskId: "a", title: "Tokens", buddyId: "b2", taskId: "a" }],
      baseRef: "main",
    });
    fold({ type: "goal.combining", goalId: "g1", branch: "team/dark", worktreeId: "w" });
    fold({ type: "goal.conflicted", goalId: "g1", taskId: "a", files: ["x.css"], resolveTaskId: "fix" });
    fold({ type: "goal.merged", goalId: "g1", taskId: "a" });
    fold({ type: "goal.combined", goalId: "g1", diff: { files: 1, insertions: 2, deletions: 0 } });
    fold({ type: "goal.finished", goalId: "g1", summary: "Done." });
    const goal = state.goals?.[0] as GoalProjection;
    expect(goal.status).toBe("done");
    expect(goal.team).toMatchObject({
      phase: "done",
      baseRef: "main",
      combine: { branch: "team/dark", merged: ["a"], diff: { files: 1, insertions: 2, deletions: 0 } },
    });
    expect(goal.team?.combine?.conflict).toBeUndefined();
    expect(teamDefaults(undefined)).toEqual(DEFAULT_TEAM_DEFAULTS);
    expect(
      teamDefaults({ paused: false, quality: "balanced", team: { autoStart: true, maxParallel: 2, reviewRounds: 0 } }),
    ).toMatchObject({ autoStart: true, maxParallel: 2 });
  });

  it("parses the team commands the web and tools send", () => {
    expect(
      RuntimeCommand.safeParse({
        type: "goal.create",
        goal: { goalId: "g1", buddyId: "lead", text: "Add dark mode", team: { autoStart: true, buddyIds: ["b2"] } },
      }).success,
    ).toBe(true);
    expect(
      RuntimeCommand.safeParse({ type: "goal.plan.approve", goalId: "g1", plan: [{ planTaskId: "a", title: "" }] })
        .success,
    ).toBe(false);
    expect(
      RuntimeCommand.safeParse({ type: "buddies.team", team: { autoStart: false, maxParallel: 9, reviewRounds: 1 } })
        .success,
    ).toBe(false);
  });
});
