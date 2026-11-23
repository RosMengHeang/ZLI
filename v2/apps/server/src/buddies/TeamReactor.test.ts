import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  CommandId,
  type EnvironmentDescriptor,
  EnvironmentId,
  type RuntimeCommand,
  type RuntimeProjection,
} from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { Database } from "../db/Database.js";
import { GitProcess } from "../git/GitProcess.js";
import { Engine } from "../orchestration/Engine.js";
import { WorktreeReactor } from "../worktrees/WorktreeReactor.js";
import { WorktreeService } from "../worktrees/WorktreeService.js";
import { stableId } from "./stableId.js";
import { TeamReactor, teamBranch, teamResolveId, teamReviewId } from "./TeamReactor.js";
import { parseShortstat, TeamGit } from "./teamGit.js";

const git = promisify(execFile);
const environment: EnvironmentDescriptor = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000003"),
  label: "Teams",
  protocolVersion: 1,
  capabilities: { eventReplay: true, worktrees: true },
};

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

let counter = 0;
function send(engine: Engine, command: RuntimeCommand | Record<string, unknown>) {
  counter += 1;
  return engine.dispatchPromise({
    protocolVersion: 1,
    commandId: CommandId.parse(stableId(`team-test:${counter}`)),
    command: command as RuntimeCommand,
  });
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "zli-team-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const repo = join(root, "app");
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), "start\n");
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "zli-tests@example.invalid"],
    ["config", "user.name", "ZLI Tests"],
    ["add", "README.md"],
    ["commit", "-m", "start"],
  ])
    await git("git", args, { cwd: repo });
  return { root, repo };
}

const PICK = {
  provider: "codex",
  permissionMode: "full-access",
  reason: "Test",
  source: "auto",
  at: "2026-01-01T00:00:00.000Z",
} as const;
const PROFILE = { kind: "feature", size: "s", risk: "low", needsBrowser: false } as const;

async function setup(options: { reviewRounds?: number } = {}) {
  const { root, repo } = await repository();
  const database = new Database({ path: ":memory:" });
  const engine = new Engine({ database, environment });
  const worktrees = new WorktreeReactor(engine, new WorktreeService(new GitProcess()));
  const team = new TeamReactor(engine, { git: new TeamGit(new GitProcess()) });
  cleanup.push(
    () => database.close(),
    () => worktrees.stop(),
    () => team.stop(),
  );
  const settle = async (done: (state: RuntimeProjection) => boolean): Promise<RuntimeProjection> => {
    for (let round = 0; round < 80; round += 1) {
      await worktrees.waitForIdle();
      await team.waitForIdle();
      const state = await engine.projection();
      if (done(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return engine.projection();
  };

  const registered = await send(engine, { type: "project.register", path: repo });
  const projectId = registered.result?.projectId as string;
  await send(engine, {
    type: "worktree.import",
    worktreeId: stableId("checkout"),
    projectId,
    path: repo,
    branch: "HEAD",
    kind: "checkout",
  });
  for (const [buddyId, name, title] of [
    ["lead", "Primary", "Lead"],
    ["b2", "Builder", "Builder"],
    ["b3", "Fixer", "Builder"],
  ] as const)
    await send(engine, {
      type: "buddy.create",
      buddy: {
        buddyId,
        name,
        title,
        color: "jade",
        role: "buddy",
        engine: { mode: "auto" },
        permissionMode: "full-access",
        maxActiveJobs: 2,
        handoffs: [],
      },
    });
  await settle((state) => state.worktrees.some((entry) => entry.kind === "checkout" && entry.branch === "main"));
  // Reviews have their own test; here a finished task is approved as it is.
  await send(engine, {
    type: "buddies.team",
    team: { autoStart: false, maxParallel: 3, reviewRounds: options.reviewRounds ?? 0 },
  });

  /** Runs a job the way a buddy would: its worktree is made, it writes files, and its result lands. */
  const work = async (taskId: string, files: Record<string, string>, options: { merge?: string } = {}) => {
    const state = await engine.projection();
    const task = state.tasks?.find((entry) => entry.taskId === taskId);
    if (!task) throw new Error(`No task ${taskId}`);
    const worktreeId = stableId(`job-worktree:${taskId}`);
    const branch = `job/${taskId.slice(0, 8)}`;
    await send(engine, {
      type: "worktree.create",
      worktreeId,
      projectId,
      path: join(root, "app-worktrees", branch.replace("/", "-")),
      workspaceRoot: join(root, "app-worktrees"),
      branch,
      ...(task.baseRef ? { baseRef: task.baseRef } : {}),
    });
    const ready = await settle(
      (next) => next.worktrees.find((entry) => entry.worktreeId === worktreeId)?.status === "ready",
    );
    const path = ready.worktrees.find((entry) => entry.worktreeId === worktreeId)?.path as string;
    if (options.merge) await git("git", ["merge", options.merge], { cwd: path }).catch(() => undefined);
    for (const [name, text] of Object.entries(files)) await writeFile(join(path, name), text);
    if (options.merge) {
      await git("git", ["add", "-A"], { cwd: path });
      await git("git", ["commit", "--no-edit", "-m", "Merge"], { cwd: path });
    }
    await send(engine, {
      type: "task.start",
      taskId,
      threadId: stableId(`thread:${taskId}`),
      worktreeId,
      branch,
      profile: PROFILE,
      pick: PICK,
    });
    await send(engine, { type: "task.status", taskId, status: "working" });
    await send(engine, {
      type: "task.result",
      taskId,
      result: {
        summary: "Done.",
        files: 1,
        insertions: 1,
        deletions: 0,
        screenshots: [],
        durationMs: 1,
        overlaps: [],
      },
    });
  };

  /** A team with a two-task plan, Go pressed. */
  const startTeam = async () => {
    await send(engine, {
      type: "goal.create",
      goal: { goalId: "team1", buddyId: "lead", text: "Add dark mode", projectId, team: {} },
    });
    await send(engine, {
      type: "goal.plan.submit",
      goalId: "team1",
      plan: [
        { planTaskId: "p1", title: "Theme tokens", buddyId: "b2" },
        { planTaskId: "p2", title: "Settings toggle", buddyId: "b3" },
      ],
    });
    const planned = await engine.projection();
    expect(planned.goals?.[0]?.team?.phase).toBe("plan_ready");
    expect(planned.goals?.[0]?.status).toBe("needs_you");
    const approved = await send(engine, {
      type: "goal.plan.approve",
      goalId: "team1",
      plan: planned.goals?.[0]?.team?.plan ?? [],
    });
    expect(approved.status).toBe("accepted");
  };

  return { engine, repo, settle, work, startTeam };
}

describe("TeamReactor", () => {
  it("merges every approved task into one team branch and measures it", async () => {
    const { engine, repo, settle, work, startTeam } = await setup();
    await startTeam();
    const going = await engine.projection();
    expect(going.goals?.[0]?.team).toMatchObject({ phase: "working", baseRef: "main" });
    expect(going.tasks?.map((task) => [task.taskId, task.buddyId, task.baseRef])).toEqual([
      ["p1", "b2", "main"],
      ["p2", "b3", "main"],
    ]);

    await work("p1", { "theme.css": "dark\n" });
    // One task done is not enough: the team waits for the other.
    expect((await settle(() => false)).goals?.[0]?.team?.phase).toBe("working");
    await work("p2", { "toggle.ts": "on\n" });

    const state = await settle((next) => next.goals?.[0]?.team?.phase === "summing_up");
    const team = state.goals?.[0]?.team;
    expect(team?.phase).toBe("summing_up");
    expect(team?.combine).toMatchObject({ branch: teamBranch({ goalId: "team1", text: "Add dark mode" }) });
    expect(team?.combine?.merged).toEqual(["p1", "p2"]);
    expect(team?.combine?.diff).toEqual({ files: 2, insertions: 2, deletions: 0 });
    // What each job left uncommitted was committed on its branch before the merge.
    const { stdout } = await git("git", ["log", "--format=%s", team?.combine?.branch ?? ""], { cwd: repo });
    expect(stdout).toContain("Merge task: Theme tokens");
    expect(stdout).toContain("Merge task: Settings toggle");
  }, 60_000);

  it("hands a conflicting merge to the task's buddy, then merges the fix", async () => {
    const { settle, work, startTeam } = await setup();
    await startTeam();
    await work("p1", { "README.md": "dark\n" });
    await work("p2", { "README.md": "light\n" });

    const conflicted = await settle((next) => next.goals?.[0]?.team?.combine?.conflict !== undefined);
    const combine = conflicted.goals?.[0]?.team?.combine;
    const resolveId = teamResolveId("team1", "p2", 0);
    expect(combine?.merged).toEqual(["p1"]);
    expect(combine?.conflict).toEqual({ taskId: "p2", files: ["README.md"], resolveTaskId: resolveId });
    const fix = conflicted.tasks?.find((task) => task.taskId === resolveId);
    expect(fix).toMatchObject({ buddyId: "b3", baseRef: combine?.branch, status: "queued" });
    expect(fix?.goal).toContain("README.md");

    // The buddy merges the task's branch into a branch from the team branch and settles the conflict.
    await work(resolveId, { "README.md": "dark and light\n" }, { merge: "job/p2" });
    const state = await settle((next) => next.goals?.[0]?.team?.phase === "summing_up");
    expect(state.goals?.[0]?.team?.combine?.merged).toEqual(["p1", "p2"]);
    expect(state.goals?.[0]?.team?.combine?.conflict).toBeUndefined();
    expect(state.goals?.[0]?.team?.combine?.diff?.files).toBe(1);
  }, 60_000);
});

describe("TeamReactor reviews", () => {
  it("has another buddy review each finished task, and waits for an ok before combining", async () => {
    const { engine, settle, work, startTeam } = await setup({ reviewRounds: 1 });
    await startTeam();
    await work("p1", { "theme.css": "dark\n" });
    await work("p2", { "toggle.ts": "on\n" });
    const reviewing = await settle((next) => (next.tasks ?? []).filter((task) => task.kind === "review").length === 2);
    const review = reviewing.tasks?.find((task) => task.taskId === teamReviewId("p1", 1));
    expect(review).toMatchObject({ kind: "review", parentTaskId: "p1", round: 1 });
    expect(review?.buddyId).not.toBe("b2");
    expect(reviewing.goals?.[0]?.team?.phase).toBe("working");

    for (const taskId of ["p1", "p2"]) {
      const reviewer = reviewing.tasks?.find((task) => task.taskId === teamReviewId(taskId, 1));
      await send(engine, {
        type: "task.review.attach",
        taskId,
        review: { taskId: reviewer?.taskId, buddyId: reviewer?.buddyId, verdict: "ok", notes: [] },
      });
    }
    const state = await settle((next) => next.goals?.[0]?.team?.phase === "summing_up");
    expect(state.goals?.[0]?.team?.combine?.merged).toEqual(["p1", "p2"]);
  }, 60_000);
});

describe("parseShortstat", () => {
  it("reads git's one-line summary", () => {
    expect(parseShortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)\n")).toEqual({
      files: 3,
      insertions: 10,
      deletions: 2,
    });
    expect(parseShortstat(" 1 file changed, 1 insertion(+)\n")).toEqual({ files: 1, insertions: 1, deletions: 0 });
    expect(parseShortstat("")).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });
});
