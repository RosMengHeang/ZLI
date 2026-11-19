import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommandId,
  type EnvironmentDescriptor,
  EnvironmentId,
  MAX_OPEN_JOBS,
  type ProviderDiscovery,
  type RuntimeCommand,
  type RuntimeProjection,
} from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import { budgetReserved, stableId, TaskReactor, type TaskReactorOptions } from "./TaskReactor.js";

const environment: EnvironmentDescriptor = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000001"),
  label: "Buddies",
  protocolVersion: 1,
  capabilities: {},
};
const providers: ProviderDiscovery[] = [
  {
    provider: "claude-code",
    displayName: "Claude Code",
    status: "found",
    path: "claude",
    models: [
      { id: "claude-sonnet-5-5", label: "Sonnet" },
      { id: "claude-opus-5-5", label: "Opus" },
    ],
  },
];

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

let counter = 0;
async function send(engine: Engine, command: RuntimeCommand) {
  counter += 1;
  return engine.dispatchPromise({
    protocolVersion: 1,
    commandId: CommandId.parse(stableId(`test:${counter}`)),
    command,
  });
}

async function setup(options: Partial<TaskReactorOptions> = {}) {
  const database = new Database({ path: ":memory:" });
  const engine = new Engine({ database, environment });
  const reactor = new TaskReactor(engine, { providers: async () => providers, ...options });
  const folder = mkdtempSync(join(tmpdir(), "zli-buddies-"));
  cleanup.push(
    () => rmSync(folder, { recursive: true, force: true }),
    () => database.close(),
    () => reactor.stop(),
  );
  const registered = await send(engine, { type: "project.register", path: folder } as RuntimeCommand);
  const projectId = registered.result?.projectId as string;
  for (const [buddyId, name] of [
    ["b1", "Builder"],
    ["b2", "Tester"],
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
  /** Plays the parts the runtime would: makes worktrees ready and chats idle after one answer. */
  const runtime = async (finish?: { taskId: string; summary: string }) => {
    let state = await settle();
    for (const worktree of state.worktrees)
      if (worktree.status !== "ready")
        await send(engine, {
          type: "worktree.status",
          worktreeId: worktree.worktreeId,
          status: "ready",
        } as RuntimeCommand);
    state = await settle();
    for (const thread of state.threads)
      if (thread.status === "starting") {
        await send(engine, { type: "thread.status", threadId: thread.threadId, status: "working" } as RuntimeCommand);
        for (const queued of state.queuedMessages ?? [])
          if (queued.threadId === thread.threadId)
            await send(engine, {
              type: "thread.queue.remove",
              threadId: thread.threadId,
              queueId: queued.queueId,
            } as RuntimeCommand);
        await send(engine, {
          type: "thread.message",
          message: { messageId: `m-${thread.threadId}`, threadId: thread.threadId, role: "assistant", text: "On it." },
        } as RuntimeCommand);
      }
    if (finish) await send(engine, { type: "task.finish", taskId: finish.taskId, summary: finish.summary });
    for (const thread of (await settle()).threads)
      if (thread.status === "working")
        await send(engine, { type: "thread.status", threadId: thread.threadId, status: "idle" } as RuntimeCommand);
    return settle();
  };
  return { engine, projectId, settle, runtime };
}

describe("TaskReactor", () => {
  it("runs a job from assignment to a result card", async () => {
    const { engine, projectId, runtime } = await setup();
    await send(engine, {
      type: "task.assign",
      task: {
        taskId: "t1",
        buddyId: "b1",
        projectId,
        kind: "job",
        goal: "Fix the flaky checkout test",
        origin: { kind: "chat" },
      },
    });
    let state = await runtime();
    const task = state.tasks?.find((candidate) => candidate.taskId === "t1");
    expect(task?.status).toBe("working");
    expect(task?.pick?.provider).toBe("claude-code");
    expect(task?.branch).toMatch(/^builder\/fix-the-flaky-checkout-test-/u);
    const first = state.queuedMessages?.find((message) => message.threadId === task?.threadId);
    if (first) {
      expect(first.text).toBe("Fix the flaky checkout test");
      expect(first.context).toContain("You are Builder");
    }
    state = await runtime({ taskId: "t1", summary: "Made the test wait for the cart. Ran it 20 times." });
    const done = state.tasks?.find((candidate) => candidate.taskId === "t1");
    expect(done?.status).toBe("ready");
    expect(done?.result?.summary).toMatch(/^Made the test wait/u);
    expect(state.buddies?.find((buddy) => buddy.buddyId === "b1")?.lastLine?.text).toMatch(
      /^Done: Made the test wait/u,
    );
  });

  it("hands finished work to the reviewer named in a rule", async () => {
    const { engine, projectId, runtime } = await setup();
    await send(engine, {
      type: "buddy.handoff.set",
      buddyId: "b1",
      rule: { ruleId: "r1", when: "finished", to: "b2", action: "check", maxRounds: 2, enabled: true },
    });
    await send(engine, {
      type: "task.assign",
      task: {
        taskId: "t1",
        buddyId: "b1",
        projectId,
        kind: "job",
        goal: "Add a dark mode toggle",
        origin: { kind: "chat" },
      },
    });
    await runtime();
    const state = await runtime({ taskId: "t1", summary: "Added the toggle." });
    const review = state.tasks?.find((candidate) => candidate.parentTaskId === "t1");
    expect(review).toMatchObject({ buddyId: "b2", kind: "review", round: 1 });
    expect(review?.goal).toMatch(/^Check Builder's work/u);
  });

  it("holds jobs past the buddy's limit in the queue", async () => {
    const { engine, projectId, settle } = await setup();
    for (const taskId of ["t1", "t2", "t3"])
      await send(engine, {
        type: "task.assign",
        task: { taskId, buddyId: "b1", projectId, kind: "job", goal: `Job ${taskId}`, origin: { kind: "chat" } },
      });
    const state = await settle();
    expect(state.tasks?.map((task) => task.status)).toEqual(["preparing", "preparing", "queued"]);
  });

  it("runs one Primary job at a time in a project's checkout, so its tools always find the right job", async () => {
    const { engine, projectId, settle } = await setup();
    const state0 = await engine.projection();
    // The first buddy made is the Primary; it works in the project's checkout.
    expect(state0.buddies?.find((buddy) => buddy.buddyId === "b1")?.role).toBe("primary");
    const project = state0.projects.find((entry) => entry.projectId === projectId);
    await send(engine, {
      type: "worktree.import",
      worktreeId: stableId("checkout"),
      projectId,
      path: project?.path ?? "",
      branch: "main",
      kind: "checkout",
    } as RuntimeCommand);
    for (const taskId of ["p1", "p2"])
      await send(engine, {
        type: "task.assign",
        task: { taskId, buddyId: "b1", projectId, kind: "job", goal: `Job ${taskId}`, origin: { kind: "chat" } },
      });
    const state = await settle();
    expect(state.tasks?.map((task) => [task.taskId, task.status])).toEqual([
      ["p1", "working"],
      ["p2", "queued"],
    ]);
  });

  it("keeps a new Primary job out of the checkout while a review of the last one reads it", async () => {
    const { engine, projectId, runtime, settle } = await setup();
    const project = (await engine.projection()).projects.find((entry) => entry.projectId === projectId);
    await send(engine, {
      type: "worktree.import",
      worktreeId: stableId("checkout"),
      projectId,
      path: project?.path ?? "",
      branch: "main",
      kind: "checkout",
    } as RuntimeCommand);
    await send(engine, {
      type: "buddy.handoff.set",
      buddyId: "b1",
      rule: { ruleId: "r1", when: "finished", to: "b2", action: "check", maxRounds: 2, enabled: true },
    });
    await send(engine, {
      type: "task.assign",
      task: { taskId: "p1", buddyId: "b1", projectId, kind: "job", goal: "Job p1", origin: { kind: "chat" } },
    });
    await runtime();
    await runtime({ taskId: "p1", summary: "Done p1." });
    await send(engine, {
      type: "task.assign",
      task: { taskId: "p2", buddyId: "b1", projectId, kind: "job", goal: "Job p2", origin: { kind: "chat" } },
    });
    const state = await settle();
    const review = state.tasks?.find((task) => task.parentTaskId === "p1");
    expect(review?.worktreeId).toBe(stableId("checkout"));
    expect(["preparing", "working", "needs_you"]).toContain(review?.status);
    expect(state.tasks?.find((task) => task.taskId === "p2")?.status).toBe("queued");
  });

  it("makes a failed worktree again once, and again on Try again, instead of failing the job at once", async () => {
    const { engine, projectId, settle } = await setup();
    await send(engine, {
      type: "task.assign",
      task: { taskId: "w1", buddyId: "b2", projectId, kind: "job", goal: "Fix it", origin: { kind: "chat" } },
    });
    let state = await settle();
    const worktreeId = state.tasks?.[0]?.worktreeId ?? state.worktrees.at(-1)?.worktreeId ?? "";
    const fail = () =>
      send(engine, { type: "worktree.status", worktreeId, status: "failed" } as RuntimeCommand).then(settle);
    // A first failure: made again, the job still preparing.
    state = await fail();
    expect(state.worktrees.find((entry) => entry.worktreeId === worktreeId)?.status).toBe("queued");
    expect(state.tasks?.[0]?.status).toBe("preparing");
    // Failing again in the same attempt ends the job.
    state = await fail();
    expect(state.tasks?.[0]?.status).toBe("failed");
    // Try again makes it once more.
    await send(engine, { type: "task.retry", taskId: "w1" });
    state = await settle();
    expect(state.worktrees.find((entry) => entry.worktreeId === worktreeId)?.status).toBe("queued");
    expect(state.tasks?.[0]?.status).toBe("preparing");
  });

  it("stops a job whose agent runs one turn past the limit, and says why", async () => {
    let clock = Date.now();
    const { engine, projectId, settle, runtime } = await setup({ now: () => new Date(clock), checkEveryMs: 5 });
    await send(engine, {
      type: "task.assign",
      task: { taskId: "t1", buddyId: "b1", projectId, kind: "job", goal: "Refactor", origin: { kind: "chat" } },
    });
    let state = await runtime();
    const threadId = state.tasks?.[0]?.threadId as string;
    await send(engine, {
      type: "thread.status",
      threadId,
      status: "working",
      turnId: "00000000-0000-4000-8000-0000000000aa",
    } as RuntimeCommand);
    state = await settle();
    expect(state.tasks?.[0]?.status).toBe("working");

    clock += 91 * 60_000;
    await new Promise((resolve) => setTimeout(resolve, 30));
    state = await settle();
    expect(state.tasks?.[0]).toMatchObject({
      status: "failed",
      needs: { kind: "stuck", text: expect.stringContaining("over 90 minutes") },
    });
  });

  it("waits for the last turn's snapshot before counting a finished job's files", async () => {
    const { engine, projectId, settle, runtime } = await setup();
    await send(engine, {
      type: "task.assign",
      task: { taskId: "t1", buddyId: "b1", projectId, kind: "job", goal: "Add hello.txt", origin: { kind: "chat" } },
    });
    let state = await runtime();
    const task = state.tasks?.[0];
    const threadId = task?.threadId as string;
    await send(engine, {
      type: "thread.status",
      threadId,
      status: "working",
      providerTurnId: "turn-2",
    } as RuntimeCommand);
    await send(engine, { type: "task.finish", taskId: "t1", summary: "Added hello.txt." });
    await send(engine, { type: "thread.status", threadId, status: "idle", providerTurnId: "turn-2" } as RuntimeCommand);
    state = await settle();
    // The turn ended, but its snapshot has not landed: no result yet.
    expect(state.tasks?.[0]?.status).toBe("working");

    await send(engine, {
      type: "thread.checkpoint",
      checkpoint: {
        checkpointId: "00000000-0000-4000-8000-0000000000c1",
        threadId,
        worktreeId: task?.worktreeId,
        turnId: "turn-2",
        startTree: "a".repeat(40),
        endTree: "b".repeat(40),
        files: [{ path: "hello.txt", kind: "added", additions: 1, deletions: 0, binary: false }],
        fileCount: 1,
        additions: 1,
        deletions: 0,
      },
    } as RuntimeCommand);
    state = await settle();
    expect(state.tasks?.[0]).toMatchObject({ status: "ready", result: { files: 1, insertions: 1 } });
  });

  it("refuses more jobs than a buddy may hold open", async () => {
    const { engine, projectId } = await setup();
    await send(engine, { type: "buddies.pause" } as RuntimeCommand);
    for (let index = 0; index < MAX_OPEN_JOBS; index += 1)
      await send(engine, {
        type: "task.assign",
        task: {
          taskId: `t${index}`,
          buddyId: "b1",
          projectId,
          kind: "job",
          goal: `Job ${index}`,
          origin: { kind: "chat" },
        },
      });
    const refused = await send(engine, {
      type: "task.assign",
      task: { taskId: "t-over", buddyId: "b1", projectId, kind: "job", goal: "One more", origin: { kind: "chat" } },
    });
    expect(refused).toMatchObject({ status: "rejected", error: { code: "job_limit" } });
  });

  it("starts nothing while buddies are paused", async () => {
    const { engine, projectId, settle } = await setup();
    await send(engine, { type: "buddies.pause" });
    await send(engine, {
      type: "task.assign",
      task: { taskId: "t1", buddyId: "b1", projectId, kind: "job", goal: "Job", origin: { kind: "chat" } },
    });
    expect((await settle()).tasks?.[0]?.status).toBe("queued");
  });
});

describe("TaskReactor learning and budget", () => {
  it("keeps the person's answers and change requests as lessons, at once", async () => {
    const { engine, projectId, runtime } = await setup();
    await send(engine, {
      type: "task.assign",
      task: { taskId: "t1", buddyId: "b1", projectId, kind: "job", goal: "Add a dark mode", origin: { kind: "chat" } },
    });
    await runtime();
    await send(engine, { type: "task.question.ask", taskId: "t1", questionId: "q1", text: "Which color for dark?" });
    await send(engine, { type: "task.question.answer", taskId: "t1", questionId: "q1", answer: "Charcoal, not black" });
    await runtime({ taskId: "t1", summary: "Added it." });
    await send(engine, { type: "task.revise", taskId: "t1", note: "Use our tokens instead of raw hex colors" });
    const state = await runtime();
    const memory = state.buddies?.find((buddy) => buddy.buddyId === "b1")?.memory ?? [];
    expect(memory.map((note) => note.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Charcoal, not black"),
        expect.stringContaining("Use our tokens instead of raw hex colors"),
      ]),
    );
    expect(memory.every((note) => note.source === "you" && note.projectId === projectId)).toBe(true);
  });

  it("holds a buddy's new jobs once its week's spending passes its budget", async () => {
    const { engine, projectId, runtime } = await setup();
    await send(engine, {
      type: "task.assign",
      task: { taskId: "t1", buddyId: "b1", projectId, kind: "job", goal: "First job", origin: { kind: "chat" } },
    });
    await runtime();
    await send(engine, {
      type: "task.result",
      taskId: "t1",
      result: {
        summary: "Done.",
        files: 1,
        insertions: 1,
        deletions: 0,
        screenshots: [],
        costUsd: 6,
        durationMs: 1,
        overlaps: [],
      },
    });
    await send(engine, { type: "buddy.update", buddyId: "b1", changes: { budgetUsd: 5 } });
    await send(engine, {
      type: "task.assign",
      task: { taskId: "t2", buddyId: "b1", projectId, kind: "job", goal: "Second job", origin: { kind: "chat" } },
    });
    let state = await runtime();
    expect(state.tasks?.find((task) => task.taskId === "t2")?.status).toBe("queued");
    // Raising the limit lets it start.
    await send(engine, { type: "buddy.update", buddyId: "b1", changes: { budgetUsd: 0 } });
    state = await runtime();
    expect(state.buddies?.find((buddy) => buddy.buddyId === "b1")?.budgetUsd).toBeUndefined();
    expect(state.tasks?.find((task) => task.taskId === "t2")?.status).toBe("working");
  });
});

describe("TaskReactor take over", () => {
  it("stops the buddy's turn while the person drives, and tells it where they left off", async () => {
    const { engine, projectId, runtime, settle } = await setup();
    await send(engine, {
      type: "task.assign",
      task: { taskId: "t1", buddyId: "b1", projectId, kind: "job", goal: "Compare plans", origin: { kind: "chat" } },
    });
    let state = await runtime();
    const threadId = state.tasks?.find((task) => task.taskId === "t1")?.threadId as string;
    await send(engine, { type: "task.takeover", taskId: "t1" });
    state = await runtime();
    expect(state.tasks?.find((task) => task.taskId === "t1")).toMatchObject({
      status: "needs_you",
      needs: { kind: "takeover" },
    });
    await send(engine, { type: "task.handback", taskId: "t1", note: "The browser is now on https://example.com/cart" });
    state = await settle();
    expect(state.tasks?.find((task) => task.taskId === "t1")?.status).toBe("working");
    // The note went to its chat as a new turn: the chat was idle while the person drove, and works again.
    expect(state.threads.find((thread) => thread.threadId === threadId)?.status).toBe("working");
  });
});

describe("budgetReserved", () => {
  const now = new Date("2026-11-19T12:00:00.000Z");
  const buddy = { buddyId: "b1", budgetUsd: 10 } as never;
  const finished = (taskId: string, costUsd: number) => ({
    taskId,
    buddyId: "b1",
    updatedAt: "2026-11-19T10:00:00.000Z",
    endedAt: "2026-11-19T10:00:00.000Z",
    result: { costUsd },
  });
  it("counts running jobs at the week's average cost, so jobs side by side do not overshoot together", () => {
    const state = { tasks: [finished("t1", 4)] } as unknown as RuntimeProjection;
    // 4 spent; one running job at about 4 leaves room, a second running one would reach 12.
    expect(budgetReserved(state, buddy, 1, now)).toBe(false);
    expect(budgetReserved(state, buddy, 2, now)).toBe(true);
  });
  it("holds nothing back with no running jobs, no budget, or no history", () => {
    const state = { tasks: [finished("t1", 4)] } as unknown as RuntimeProjection;
    expect(budgetReserved(state, buddy, 0, now)).toBe(false);
    expect(budgetReserved(state, { buddyId: "b1" } as never, 3, now)).toBe(false);
    expect(budgetReserved({ tasks: [] } as unknown as RuntimeProjection, buddy, 3, now)).toBe(false);
  });
});
