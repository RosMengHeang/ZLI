import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUDDY_HOMES_FOLDER,
  CommandId,
  type EnvironmentDescriptor,
  EnvironmentId,
  isBuddyHome,
  type ProviderDiscovery,
  type RuntimeCommand,
  type RuntimeProjection,
} from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import { BuddyHomes } from "./homes.js";
import { stableId } from "./stableId.js";
import { TaskReactor } from "./TaskReactor.js";

const environment: EnvironmentDescriptor = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000003"),
  label: "Homes",
  protocolVersion: 1,
  capabilities: {},
};
const providers: ProviderDiscovery[] = [
  {
    provider: "claude-code",
    displayName: "Claude Code",
    status: "found",
    path: "claude",
    models: [{ id: "claude-sonnet-5-5", label: "Sonnet" }],
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
    commandId: CommandId.parse(stableId(`home-test:${counter}`)),
    command,
  });
}

async function setup() {
  const database = new Database({ path: ":memory:" });
  const engine = new Engine({ database, environment });
  const folder = mkdtempSync(join(tmpdir(), "zli-homes-"));
  const homes = new BuddyHomes(engine, join(folder, BUDDY_HOMES_FOLDER));
  cleanup.push(
    () => rmSync(folder, { recursive: true, force: true }),
    () => database.close(),
  );
  await send(engine, {
    type: "buddy.create",
    buddy: {
      buddyId: "b1",
      name: "Scout",
      color: "jade",
      role: "buddy",
      engine: { mode: "auto" },
      permissionMode: "full-access",
      maxActiveJobs: 2,
      handoffs: [],
    },
  });
  return { engine, homes, folder };
}

describe("BuddyHomes", () => {
  it("gives a buddy its own folder, kept out of Git and out of the project lists", async () => {
    const { engine, homes, folder } = await setup();
    const home = await homes.home(await engine.projection(), (await engine.projection()).buddies?.[0] as never);
    expect(home?.path.startsWith(join(folder, BUDDY_HOMES_FOLDER))).toBe(true);
    expect(existsSync(join(home?.path ?? "", "files"))).toBe(true);
    expect(existsSync(join(home?.path ?? "", "notes.md"))).toBe(true);
    const state = await engine.projection();
    const project = state.projects.find((entry) => isBuddyHome(entry));
    expect(project?.git).toBe(false);
    expect(state.buddies?.[0]?.home).toEqual({ worktreeId: home?.worktreeId, path: home?.path });
    // The same home every time.
    const again = await homes.home(state, state.buddies?.[0] as never);
    expect(again?.worktreeId).toBe(home?.worktreeId);
  });

  it("runs a web job in the buddy's home with a web brief, and keeps its budget", async () => {
    const { engine, homes } = await setup();
    const project = await homes.project(await engine.projection());
    const reactor = new TaskReactor(engine, { providers: async () => providers, homes });
    cleanup.push(() => reactor.stop());
    await send(engine, {
      type: "task.assign",
      task: {
        taskId: "web1",
        buddyId: "b1",
        projectId: project?.projectId as string,
        kind: "job",
        goal: "Compare three hosting plans and write a table",
        origin: { kind: "chat" },
      },
    });
    let state: RuntimeProjection = await engine.projection();
    for (let round = 0; round < 6; round += 1) {
      await reactor.waitForIdle();
      state = await engine.projection();
    }
    const task = state.tasks?.find((entry) => entry.taskId === "web1");
    const home = state.buddies?.[0]?.home;
    expect(task?.status).toBe("working");
    expect(task?.worktreeId).toBe(home?.worktreeId);
    expect(task?.profile?.kind).toBe("web");
    const brief = state.queuedMessages?.find((message) => message.threadId === task?.threadId)?.context ?? "";
    expect(brief).toContain("This is a web job");
    expect(brief).toContain("Ask the person first");
  });
});
