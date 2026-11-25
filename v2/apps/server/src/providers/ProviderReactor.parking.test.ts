import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ThreadId as ThreadIdValue,
  WorktreeId,
} from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import { ProviderReactor } from "./ProviderReactor.js";
import {
  type ProviderAdapter,
  type ProviderEvent,
  ProviderRegistry,
  ProviderService,
  type ProviderSession,
  type ProviderSessionStart,
  type ProviderTurnInput,
} from "./ProviderService.js";

const environment = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000a01"),
  label: "Parking test",
  protocolVersion: 1 as const,
  capabilities: { structuredProviders: true, eventReplay: true },
};
const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000a03");
const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000a04");
const IDLE_STOP_MS = 30;

/** A provider whose sessions are processes: stopSession ends one, startSession starts another. */
class ProcessAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  readonly capabilities = { structuredApproval: true, structuredUserInput: true };
  readonly listeners = new Set<(event: ProviderEvent) => void>();
  readonly startInputs: ProviderSessionStart[] = [];
  readonly turnInputs: ProviderTurnInput[] = [];
  running = false;
  stops = 0;
  turns = 0;

  async startSession(input: ProviderSessionStart): Promise<ProviderSession> {
    this.startInputs.push(input);
    this.running = true;
    const providerSessionId = input.resumeSessionId ?? `conv-${this.startInputs.length}`;
    return { threadId: input.threadId, provider: this.provider, cwd: input.cwd, status: "idle", providerSessionId };
  }
  async sendTurn(input: ProviderTurnInput): Promise<{ turnId: string }> {
    if (!this.running) throw new Error("No process to send to");
    this.turnInputs.push(input);
    this.turns += 1;
    return { turnId: `turn-${this.turns}` };
  }
  async interruptTurn(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async respondToUserInput(): Promise<void> {}
  async stopSession(): Promise<void> {
    if (!this.running) throw new Error("No process to stop");
    this.running = false;
    this.stops += 1;
  }
  listSessions(): ReadonlyArray<ProviderSession> {
    return [];
  }
  hasSession(): boolean {
    return this.running;
  }
  async readThread(input: { threadId: ThreadIdValue }) {
    return { threadId: input.threadId, turns: [] };
  }
  async rollbackThread(input: { threadId: ThreadIdValue }) {
    return { threadId: input.threadId, turns: [] };
  }
  async stopAll(): Promise<void> {
    this.running = false;
  }
  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: ProviderEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function setup(idleStopMs = IDLE_STOP_MS) {
  const database = new Database({ path: ":memory:" });
  databases.push(database);
  const engine = new Engine({ database, environment });
  const adapter = new ProcessAdapter();
  const service = new ProviderService(new ProviderRegistry([adapter]));
  const reactor = new ProviderReactor(engine, service, undefined, { idleStopMs });
  let sequence = 0;
  const dispatch = (command: Parameters<Engine["dispatchPromise"]>[0]["command"]) => {
    sequence += 1;
    return engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse(`20000000-0000-4000-8000-0000000a${String(sequence).padStart(4, "0")}`),
      command,
    });
  };
  const thread = async () => (await engine.projection()).threads.find((entry) => entry.threadId === threadId);
  await dispatch({ type: "project.register", path: "C:\\workspace\\park" });
  const project = (await engine.projection()).projects[0];
  if (!project) throw new Error("Expected the registered project.");
  await dispatch({
    type: "worktree.create",
    worktreeId,
    projectId: ProjectId.parse(project.projectId),
    path: "C:\\workspace\\park-tree",
    workspaceRoot: "C:\\workspace",
    branch: "feature/park",
  });
  await dispatch({
    type: "thread.start",
    threadId,
    worktreeId,
    provider: "codex",
    cwd: "C:\\workspace\\park-tree",
    name: "Parker",
  });
  await reactor.waitForIdle();
  /** Sends one message and lets the turn finish, leaving the agent idle. */
  const turn = async (text: string) => {
    await dispatch({ type: "thread.send", threadId, text });
    await reactor.waitForIdle();
    adapter.emit({ type: "turn.completed", threadId, turnId: `turn-${adapter.turns}`, status: "completed" });
    await reactor.waitForIdle();
  };
  const idleLongEnough = async () => {
    await new Promise((resolve) => setTimeout(resolve, IDLE_STOP_MS * 4));
    await reactor.waitForIdle();
  };
  const done = async () => {
    reactor.stop();
    await service.stopAll();
    service.dispose();
  };
  return { engine, adapter, reactor, dispatch, thread, turn, idleLongEnough, done };
}

describe("ProviderReactor idle stop", () => {
  it("ends an idle agent's process and keeps the chat idle with its name", async () => {
    const { adapter, thread, turn, idleLongEnough, done } = await setup();
    await turn("hi");
    expect(adapter.running).toBe(true);

    await idleLongEnough();
    expect(adapter.running).toBe(false);
    expect(adapter.stops).toBe(1);
    expect(await thread()).toMatchObject({ status: "idle", name: "Parker", providerSessionId: "conv-1" });
    await done();
  });

  it("starts the process again on the same conversation for the next message", async () => {
    const { adapter, dispatch, reactor, thread, turn, idleLongEnough, done } = await setup();
    await turn("hi");
    await idleLongEnough();
    expect(adapter.running).toBe(false);

    await dispatch({ type: "thread.send", threadId, text: "again" });
    await reactor.waitForIdle();
    expect(adapter.running).toBe(true);
    expect(adapter.startInputs.map((input) => input.resumeSessionId)).toEqual([undefined, "conv-1"]);
    expect(adapter.turnInputs.map((input) => input.text)).toEqual(["hi", "again"]);
    expect((await thread())?.status).toBe("working");
    await done();
  });

  it("marks a parked agent stopped when the person stops it", async () => {
    const { adapter, dispatch, reactor, thread, turn, idleLongEnough, done } = await setup();
    await turn("hi");
    await idleLongEnough();

    await dispatch({ type: "thread.stop", threadId });
    await reactor.waitForIdle();
    expect((await thread())?.status).toBe("stopped");
    expect(adapter.stops).toBe(1);
    await done();
  });

  it("keeps a working agent's process however long the turn runs", async () => {
    const { adapter, dispatch, reactor, idleLongEnough, done } = await setup();
    await dispatch({ type: "thread.send", threadId, text: "long job" });
    await reactor.waitForIdle();
    await idleLongEnough();
    expect(adapter.running).toBe(true);
    await done();
  });

  it("keeps every process when idle stop is off", async () => {
    const { adapter, turn, idleLongEnough, done } = await setup(0);
    await turn("hi");
    await idleLongEnough();
    expect(adapter.running).toBe(true);
    await done();
  });
});

describe("ProviderReactor warm limit", () => {
  it("gives back the process of the agent idle longest once more agents are idle than the limit", async () => {
    const database = new Database({ path: ":memory:" });
    databases.push(database);
    const engine = new Engine({ database, environment });
    const adapters = new Map<string, boolean>();
    const adapter = new (class extends ProcessAdapter {
      override async startSession(input: ProviderSessionStart): Promise<ProviderSession> {
        adapters.set(input.threadId, true);
        return super.startSession(input);
      }
      override async stopSession(input?: { threadId: ThreadIdValue }): Promise<void> {
        if (input) adapters.set(input.threadId, false);
        this.stops += 1;
      }
      override hasSession(input?: { threadId: ThreadIdValue }): boolean {
        return input ? adapters.get(input.threadId) === true : false;
      }
    })();
    const service = new ProviderService(new ProviderRegistry([adapter]));
    const reactor = new ProviderReactor(engine, service, undefined, { idleStopMs: 0, maxWarmAgents: 2 });
    let sequence = 0;
    const dispatch = (command: Parameters<Engine["dispatchPromise"]>[0]["command"]) => {
      sequence += 1;
      return engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(`40000000-0000-4000-8000-0000000a${String(sequence).padStart(4, "0")}`),
        command,
      });
    };
    await dispatch({ type: "project.register", path: "C:\workspace\warm" });
    const project = (await engine.projection()).projects[0];
    if (!project) throw new Error("Expected the registered project.");
    await dispatch({
      type: "worktree.create",
      worktreeId,
      projectId: ProjectId.parse(project.projectId),
      path: "C:\workspace\warm-tree",
      workspaceRoot: "C:\workspace",
      branch: "feature/warm",
    });
    const ids = [1, 2, 3].map((index) => ThreadId.parse(`00000000-0000-4000-8000-000000000b1${index}`));
    for (const [index, id] of ids.entries()) {
      await dispatch({
        type: "thread.start",
        threadId: id,
        worktreeId,
        provider: "codex",
        cwd: "C:\workspace\warm-tree",
        name: `Warm${index + 1}`,
        shareWorktree: true,
      });
      await reactor.waitForIdle();
      await dispatch({ type: "thread.send", threadId: id, text: "hi" });
      await reactor.waitForIdle();
      adapter.emit({ type: "turn.completed", threadId: id, turnId: `turn-${adapter.turns}`, status: "completed" });
      await reactor.waitForIdle();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await reactor.waitForIdle();
    expect(ids.map((id) => adapters.get(id))).toEqual([false, true, true]);
    const statuses = (await engine.projection()).threads.map((thread) => thread.status);
    expect(statuses).toEqual(["idle", "idle", "idle"]);
    reactor.stop();
    service.dispose();
  });
});
