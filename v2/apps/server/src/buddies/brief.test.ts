import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BuddyMessage,
  type BuddyProjection,
  CommandId,
  type EnvironmentDescriptor,
  EnvironmentId,
  type ProjectProjection,
  type RuntimeCommand,
  type TaskProjection,
} from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import { jobBrief, leadBrief } from "./brief.js";
import { chatBrief, MAX_HISTORY } from "./chat.js";
import { stableId } from "./TaskReactor.js";

const environment: EnvironmentDescriptor = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000003"),
  label: "Briefs",
  protocolVersion: 1,
  capabilities: {},
};

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

let counter = 0;
function send(engine: Engine, command: RuntimeCommand) {
  counter += 1;
  return engine.dispatchPromise({
    protocolVersion: 1,
    commandId: CommandId.parse(stableId(`brief-test:${counter}`)),
    command,
  });
}

async function twoBuddies() {
  const database = new Database({ path: ":memory:" });
  const engine = new Engine({ database, environment });
  const folder = mkdtempSync(join(tmpdir(), "zli-brief-"));
  cleanup.push(
    () => rmSync(folder, { recursive: true, force: true }),
    () => database.close(),
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
    } as RuntimeCommand);
  for (const [buddyId, noteId, text] of [
    ["b1", "n1", "Builder keeps the deploy key notes in the wiki."],
    ["b1", "n2", "Builder prefers squash merges."],
    ["b2", "n3", "Tester runs the e2e suite with Docker."],
  ] as const)
    await send(engine, {
      type: "buddy.memory.add",
      buddyId,
      note: { noteId, text, source: "told", projectId },
    } as RuntimeCommand);
  await send(engine, {
    type: "task.assign",
    task: { taskId: "t1", buddyId: "b2", projectId, kind: "job", goal: "Cover checkout.", origin: { kind: "chat" } },
  } as RuntimeCommand);
  await send(engine, {
    type: "goal.create",
    goal: { goalId: "g1", buddyId: "b2", text: "Ship checkout.", projectId },
  } as RuntimeCommand);
  const state = await engine.projection();
  const buddy = (id: string) => state.buddies?.find((entry) => entry.buddyId === id) as BuddyProjection;
  return { state, projectId, buddy };
}

describe("briefs keep each buddy's notes to itself", () => {
  it("never puts one buddy's notes in another buddy's job, chat or lead brief", async () => {
    const { state, projectId, buddy } = await twoBuddies();
    const tester = buddy("b2");
    expect(buddy("b1").memory).toHaveLength(2);
    const project = state.projects.find((entry) => entry.projectId === projectId) as ProjectProjection;
    const task = state.tasks?.find((entry) => entry.taskId === "t1") as TaskProjection;
    const goal = state.goals?.find((entry) => entry.goalId === "g1");
    expect(goal).toBeDefined();
    const briefs = [
      jobBrief({ buddy: tester, task, project, branch: "zli/t1" }),
      chatBrief({ buddy: tester, state, guess: undefined }),
      leadBrief({ buddy: tester, goal: goal as NonNullable<typeof goal>, state, maxRounds: 5 }),
    ];
    for (const brief of briefs) {
      expect(brief).toContain("Tester runs the e2e suite with Docker.");
      expect(brief).not.toContain("deploy key notes");
      expect(brief).not.toContain("squash merges");
    }
  });
});

describe("chatBrief history", () => {
  it(`carries at most the newest ${MAX_HISTORY} messages of a long chat`, async () => {
    const { state, buddy } = await twoBuddies();
    const history: BuddyMessage[] = Array.from({ length: MAX_HISTORY * 3 }, (_unused, index) => ({
      messageId: `m${index}`,
      buddyId: "b1",
      role: index % 2 === 0 ? "you" : "buddy",
      text: `Message number ${index}.`,
      at: "2026-11-19T10:00:00.000Z",
    }));
    const brief = chatBrief({ buddy: buddy("b1"), state, guess: undefined, history });
    const carried = brief.split("\n").filter((line) => /Message number \d+\./u.test(line));
    expect(carried).toHaveLength(MAX_HISTORY);
    expect(brief).toContain(`Message number ${MAX_HISTORY * 3 - 1}.`);
    expect(brief).not.toContain(`Message number ${MAX_HISTORY * 2 - 1}.`);
  });
});

describe("chatBrief personality", () => {
  it("speaks in the buddy's own voice and sample, with standing instructions still on top", async () => {
    const { state, buddy } = await twoBuddies();
    const plain = chatBrief({ buddy: buddy("b1"), state, guess: undefined });
    expect(plain).toContain("warm, quick, a little playful");
    expect(plain).not.toContain("A line in your voice");

    const dry = chatBrief({
      buddy: { ...buddy("b1"), personality: "dry", sampleReply: "Fixed. It was the cache, again." },
      state,
      guess: undefined,
    });
    expect(dry).toContain("dry and understated");
    expect(dry).not.toContain("warm, quick, a little playful");
    expect(dry).toContain('"Fixed. It was the cache, again."');
    expect(dry).toContain("If your standing instructions give you a voice, that voice wins.");

    const custom = chatBrief({
      buddy: { ...buddy("b1"), personality: "patient and a bit nerdy" },
      state,
      guess: undefined,
    });
    expect(custom).toContain("a personality of your own: patient and a bit nerdy.");
  });
});
