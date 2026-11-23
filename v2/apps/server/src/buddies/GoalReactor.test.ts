import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommandId,
  type EnvironmentDescriptor,
  EnvironmentId,
  MAX_GOAL_ROUNDS,
  type RuntimeCommand,
  type RuntimeProjection,
} from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import { GoalReactor, roundTaskId, summaryTaskId } from "./GoalReactor.js";
import { stableId } from "./stableId.js";

const environment: EnvironmentDescriptor = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000002"),
  label: "Goals",
  protocolVersion: 1,
  capabilities: {},
};

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

let counter = 0;
async function send(engine: Engine, command: RuntimeCommand) {
  counter += 1;
  return engine.dispatchPromise({
    protocolVersion: 1,
    commandId: CommandId.parse(stableId(`goal-test:${counter}`)),
    command,
  });
}

async function setup() {
  const database = new Database({ path: ":memory:" });
  const engine = new Engine({ database, environment });
  const reactor = new GoalReactor(engine);
  const folder = mkdtempSync(join(tmpdir(), "zli-goals-"));
  cleanup.push(
    () => rmSync(folder, { recursive: true, force: true }),
    () => database.close(),
    () => reactor.stop(),
  );
  const registered = await send(engine, { type: "project.register", path: folder } as RuntimeCommand);
  const projectId = registered.result?.projectId as string;
  for (const [buddyId, name] of [
    ["lead", "Primary"],
    ["b2", "Builder"],
  ] as const)
    await send(engine, {
      type: "buddy.create",
      buddy: {
        buddyId,
        name,
        color: "jade",
        role: "buddy",
        engine: { mode: "auto" },
        permissionMode: "full-access",
        maxActiveJobs: 2,
        handoffs: [],
      },
    });
  const settle = async (): Promise<RuntimeProjection> => {
    for (let round = 0; round < 5; round += 1) await reactor.waitForIdle();
    return engine.projection();
  };
  /** Ends a job the way the runtime would: it starts, then its result lands. */
  const finish = async (taskId: string) => {
    await send(engine, { type: "task.status", taskId, status: "working" });
    await send(engine, {
      type: "task.result",
      taskId,
      result: {
        summary: "Did it.",
        files: 1,
        insertions: 1,
        deletions: 0,
        screenshots: [],
        durationMs: 1,
        overlaps: [],
      },
    });
  };
  return { engine, projectId, settle, finish };
}

describe("GoalReactor", () => {
  it("gives the lead a quiet planning turn as soon as a goal is set", async () => {
    const { engine, projectId, settle } = await setup();
    await send(engine, {
      type: "goal.create",
      goal: { goalId: "g1", buddyId: "lead", text: "Ship dark mode", projectId },
    });
    const state = await settle();
    const plan = state.tasks?.find((task) => task.taskId === roundTaskId("g1", 1, 0));
    expect(plan?.buddyId).toBe("lead");
    expect(plan?.origin).toEqual({ kind: "goal", goalId: "g1" });
    expect(plan?.quiet).toBe(true);
    expect(state.goals?.find((goal) => goal.goalId === "g1")?.rounds).toBe(1);
  });

  it("waits while the goal's jobs run, then wakes the lead once they have all ended", async () => {
    const { engine, projectId, settle, finish } = await setup();
    await send(engine, {
      type: "goal.create",
      goal: { goalId: "g1", buddyId: "lead", text: "Ship dark mode", projectId },
    });
    await settle();
    const plan = roundTaskId("g1", 1, 0);
    // The lead hands out a job, then ends its turn.
    await send(engine, {
      type: "task.assign",
      task: {
        taskId: "job1",
        buddyId: "b2",
        projectId,
        kind: "job",
        goal: "Add the toggle",
        origin: { kind: "primary", goalId: "g1" },
        parentTaskId: plan,
      },
    });
    await finish(plan);
    let state = await settle();
    expect(state.goals?.[0]?.rounds).toBe(1);
    expect(state.tasks?.find((task) => task.taskId === plan)?.status).toBe("closed");
    await finish("job1");
    state = await settle();
    expect(state.goals?.[0]?.rounds).toBe(2);
    expect(state.tasks?.some((task) => task.taskId === roundTaskId("g1", 2, 0))).toBe(true);
  });

  it("asks the person when a planning turn handed nothing out and did not finish", async () => {
    const { engine, projectId, settle, finish } = await setup();
    await send(engine, {
      type: "goal.create",
      goal: { goalId: "g1", buddyId: "lead", text: "Ship dark mode", projectId },
    });
    await settle();
    await finish(roundTaskId("g1", 1, 0));
    const state = await settle();
    const goal = state.goals?.[0];
    expect(goal?.status).toBe("needs_you");
    expect(goal?.needs).toMatch(/handed nothing out/u);
    // Keep going plans again.
    await send(engine, { type: "goal.resume", goalId: "g1" });
    const after = await settle();
    expect(after.goals?.[0]?.status).toBe("working");
    expect(after.tasks?.some((task) => task.taskId === roundTaskId("g1", 2, 1))).toBe(true);
  });

  it("stops after its rounds and asks the person how to go on", async () => {
    const { engine, projectId, settle, finish } = await setup();
    await send(engine, {
      type: "goal.create",
      goal: { goalId: "g1", buddyId: "lead", text: "Ship dark mode", projectId },
    });
    for (let round = 1; round <= MAX_GOAL_ROUNDS; round += 1) {
      await settle();
      const plan = roundTaskId("g1", round, 0);
      await send(engine, {
        type: "task.assign",
        task: {
          taskId: `job${round}`,
          buddyId: "b2",
          projectId,
          kind: "job",
          goal: `Step ${round}`,
          origin: { kind: "primary", goalId: "g1" },
          parentTaskId: plan,
        },
      });
      await finish(plan);
      await finish(`job${round}`);
    }
    const state = await settle();
    expect(state.goals?.[0]?.status).toBe("needs_you");
    expect(state.goals?.[0]?.needs).toMatch(/Planned 8 times/u);
  });

  it("ends when the lead says it is done, and stopping drops its open jobs", async () => {
    const { engine, projectId, settle } = await setup();
    await send(engine, { type: "goal.create", goal: { goalId: "g1", buddyId: "lead", text: "Ship it", projectId } });
    await send(engine, {
      type: "goal.create",
      goal: { goalId: "g2", buddyId: "lead", text: "Research it", projectId },
    });
    await settle();
    await send(engine, { type: "goal.finish", goalId: "g1", summary: "Shipped." });
    await send(engine, { type: "goal.stop", goalId: "g2" });
    const state = await settle();
    expect(state.goals?.find((goal) => goal.goalId === "g1")).toMatchObject({ status: "done", summary: "Shipped." });
    expect(state.goals?.find((goal) => goal.goalId === "g2")?.status).toBe("stopped");
    expect(state.tasks?.find((task) => task.taskId === roundTaskId("g2", 1, 0))?.status).toBe("cancelled");
  });
});

describe("GoalReactor teams", () => {
  const teamGoal = (projectId: string, team: Record<string, unknown> = {}) =>
    ({
      type: "goal.create",
      goal: { goalId: "t1", buddyId: "lead", text: "Add dark mode", projectId, team },
    }) as RuntimeCommand;

  it("gives a team's lead one planning turn, then waits for the person to press Go", async () => {
    const { engine, projectId, settle, finish } = await setup();
    await send(engine, teamGoal(projectId));
    await settle();
    const plan = roundTaskId("t1", 1, 0);
    await send(engine, {
      type: "goal.plan.submit",
      goalId: "t1",
      plan: [{ planTaskId: "p1", title: "Theme tokens" }],
      notes: "Small change.",
    });
    await finish(plan);
    const state = await settle();
    const goal = state.goals?.[0];
    expect(goal?.status).toBe("needs_you");
    expect(goal?.needs).toBe("Check the plan and press Go");
    // A task with no buddy goes to someone on the team other than the lead.
    expect(goal?.team).toMatchObject({ phase: "plan_ready", notes: "Small change.", autoStart: false });
    expect(goal?.team?.plan).toEqual([{ planTaskId: "p1", title: "Theme tokens", buddyId: "b2" }]);
    // No second planning turn while the plan waits.
    expect(state.tasks?.filter((task) => task.origin.kind === "goal")).toHaveLength(1);
  });

  it("starts the plan at once when the team starts on its own, and Go takes the person's edits", async () => {
    const { engine, projectId, settle } = await setup();
    await send(engine, teamGoal(projectId, { autoStart: true }));
    await settle();
    await send(engine, {
      type: "goal.plan.submit",
      goalId: "t1",
      plan: [{ planTaskId: "p1", title: "Theme tokens", buddyId: "b2" }],
    });
    const auto = await engine.projection();
    expect(auto.goals?.[0]?.team?.phase).toBe("working");
    expect(auto.tasks?.find((task) => task.taskId === "p1")).toMatchObject({
      buddyId: "b2",
      origin: { kind: "primary", goalId: "t1" },
    });
    expect(auto.tasks?.find((task) => task.taskId === "p1")?.goal).toMatch(/^Theme tokens\n\nThis is one task/u);

    // A second team waits for Go, and the person reassigns, edits, removes and adds tasks first.
    await send(engine, {
      type: "goal.create",
      goal: { goalId: "t2", buddyId: "lead", text: "Fix login", projectId, team: {} },
    });
    await send(engine, {
      type: "goal.plan.submit",
      goalId: "t2",
      plan: [
        { planTaskId: "q1", title: "Find the bug", buddyId: "b2" },
        { planTaskId: "q2", title: "Drop me", buddyId: "b2" },
      ],
    });
    const refused = await send(engine, { type: "goal.task.add", goalId: "t2", task: { planTaskId: "q9", title: "x" } });
    expect(refused.status).toBe("rejected");
    const go = await send(engine, {
      type: "goal.plan.approve",
      goalId: "t2",
      plan: [
        { planTaskId: "q1", title: "Find and fix the bug", buddyId: "lead", notes: "With a test." },
        { planTaskId: "q3", title: "Add a test", buddyId: "b2" },
      ],
    });
    expect(go.status).toBe("accepted");
    const state = await engine.projection();
    const team = state.goals?.find((goal) => goal.goalId === "t2");
    expect(team?.status).toBe("working");
    expect(team?.team?.plan.map((item) => [item.title, item.buddyId, item.taskId])).toEqual([
      ["Find and fix the bug", "lead", "q1"],
      ["Add a test", "b2", "q3"],
    ]);
    expect(state.tasks?.some((task) => task.taskId === "q2")).toBe(false);
    const again = await send(engine, {
      type: "goal.plan.approve",
      goalId: "t2",
      plan: [{ planTaskId: "z", title: "z" }],
    });
    expect(again.status).toBe("rejected");

    // Stepping in: a task added once the team works starts at once; a dropped one stops.
    await send(engine, {
      type: "goal.task.add",
      goalId: "t2",
      task: { planTaskId: "q4", title: "Docs", buddyId: "b2" },
    });
    await send(engine, { type: "goal.task.drop", goalId: "t2", taskId: "q3" });
    const stepped = await engine.projection();
    expect(stepped.goals?.find((goal) => goal.goalId === "t2")?.team?.plan.map((item) => item.planTaskId)).toEqual([
      "q1",
      "q4",
    ]);
    expect(stepped.tasks?.find((task) => task.taskId === "q4")?.status).toBe("queued");
    expect(stepped.tasks?.find((task) => task.taskId === "q3")?.status).toBe("cancelled");
  });

  it("asks the person when the lead's planning turn hands in no plan", async () => {
    const { engine, projectId, settle, finish } = await setup();
    await send(engine, teamGoal(projectId));
    await settle();
    await finish(roundTaskId("t1", 1, 0));
    const state = await settle();
    expect(state.goals?.[0]?.status).toBe("needs_you");
    expect(state.goals?.[0]?.needs).toBe("The lead did not hand in a plan. Tell it what to do next");
  });

  it("gives the lead a summary turn once the work is combined, and finishes with what it said", async () => {
    const { engine, projectId, settle, finish } = await setup();
    await send(engine, teamGoal(projectId, { autoStart: true }));
    await settle();
    await send(engine, {
      type: "goal.plan.submit",
      goalId: "t1",
      plan: [{ planTaskId: "p1", title: "Theme tokens", buddyId: "b2" }],
    });
    await finish(roundTaskId("t1", 1, 0));
    await finish("p1");
    await send(engine, { type: "goal.combine", goalId: "t1", branch: "team/dark", worktreeId: "w1" });
    await send(engine, { type: "goal.merge", goalId: "t1", taskId: "p1" });
    await send(engine, {
      type: "goal.combine.done",
      goalId: "t1",
      diff: { files: 2, insertions: 10, deletions: 1 },
    });
    const summing = await settle();
    expect(summing.goals?.[0]?.team?.phase).toBe("summing_up");
    const summary = summing.tasks?.find((task) => task.taskId === summaryTaskId("t1", 0));
    expect(summary).toMatchObject({ buddyId: "lead", origin: { kind: "goal", goalId: "t1" } });
    await finish(summaryTaskId("t1", 0));
    const state = await settle();
    expect(state.goals?.[0]).toMatchObject({ status: "done", summary: "Did it." });
    expect(state.goals?.[0]?.team?.phase).toBe("done");
  });
});
