import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommandId,
  type EnvironmentDescriptor,
  EnvironmentId,
  type ProviderDiscovery,
  type RuntimeCommand,
  type RuntimeProjection,
} from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import { stableId, TaskReactor } from "./TaskReactor.js";

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

async function setup() {
  const database = new Database({ path: ":memory:" });
  const engine = new Engine({ database, environment });
  const reactor = new TaskReactor(engine, { providers: async () => providers });
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
    const brief = state.queuedMessages?.find((message) => message.threadId === task?.threadId)?.text ?? "";
    expect(brief === "" || brief.includes("You are Builder")).toBe(true);
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
