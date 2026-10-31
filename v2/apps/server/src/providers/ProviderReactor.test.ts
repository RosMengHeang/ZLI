import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ThreadId as ThreadIdValue,
  WorktreeId,
} from "@zli-v2/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import { ProviderReactor, promptWithAttachments } from "./ProviderReactor.js";
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
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000901"),
  label: "Provider test",
  protocolVersion: 1 as const,
  capabilities: { structuredProviders: true, eventReplay: true },
};
const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000903");
const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000904");

class FakeAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  readonly capabilities = { structuredApproval: true, structuredUserInput: true };
  readonly events = new Set<(event: ProviderEvent) => void>();
  started = false;
  responded = false;
  readonly startInputs: ProviderSessionStart[] = [];
  readonly turnInputs: ProviderTurnInput[] = [];

  async startSession(input: ProviderSessionStart): Promise<ProviderSession> {
    this.started = true;
    this.startInputs.push(input);
    return { threadId: input.threadId, provider: this.provider, cwd: input.cwd, status: "idle" };
  }
  async sendTurn(input: ProviderTurnInput): Promise<{ turnId: string }> {
    this.turnInputs.push(input);
    return { turnId: "provider-turn" };
  }
  async interruptTurn(): Promise<void> {}
  async respondToRequest(): Promise<void> {
    this.responded = true;
  }
  async respondToUserInput(): Promise<void> {}
  async stopSession(): Promise<void> {
    if (!this.started) throw new Error("Fake session does not exist");
    this.started = false;
  }
  listSessions(): ReadonlyArray<ProviderSession> {
    return [];
  }
  hasSession(): boolean {
    return this.started;
  }
  async readThread(input: {
    threadId: ThreadIdValue;
  }): Promise<{ threadId: ThreadIdValue; turns: ReadonlyArray<unknown> }> {
    return { threadId: input.threadId, turns: [] };
  }
  async rollbackThread(input: {
    threadId: ThreadIdValue;
  }): Promise<{ threadId: ThreadIdValue; turns: ReadonlyArray<unknown> }> {
    return { threadId: input.threadId, turns: [] };
  }
  async stopAll(): Promise<void> {
    this.started = false;
  }
  subscribe(listener: (event: ProviderEvent) => void): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }
  /** Like the real adapters, a closed session is forgotten before anyone hears about it. */
  emit(event: ProviderEvent): void {
    if (event.type === "session.closed") this.started = false;
    for (const listener of this.events) listener(event);
  }
}

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("ProviderReactor", () => {
  it("sends queued messages one turn at a time and steers by interrupting", async () => {
    const database = new Database({ path: ":memory:" });
    databases.push(database);
    const engine = new Engine({ database, environment });
    let turns = 0;
    const adapter = new (class extends FakeAdapter {
      interrupted: (string | undefined)[] = [];
      override async sendTurn(input: ProviderTurnInput): Promise<{ turnId: string }> {
        this.turnInputs.push(input);
        turns += 1;
        return { turnId: `turn-${turns}` };
      }
      override async interruptTurn(input?: { turnId?: string }): Promise<void> {
        this.interrupted.push(input?.turnId);
      }
    })();
    const service = new ProviderService(new ProviderRegistry([adapter]));
    const reactor = new ProviderReactor(engine, service);
    let sequence = 0;
    const dispatch = (command: Parameters<Engine["dispatchPromise"]>[0]["command"]) => {
      sequence += 1;
      return engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(`10000000-0000-4000-8000-0000000009${String(sequence).padStart(2, "0")}`),
        command,
      });
    };
    const state = async () => {
      const projection = await engine.projection();
      return { status: projection.threads[0]?.status, queued: (projection.queuedMessages ?? []).map((q) => q.text) };
    };
    const sent = () => adapter.turnInputs.map((input) => input.text);

    await dispatch({ type: "project.register", path: "C:\\workspace\\queue" });
    const project = (await engine.projection()).projects[0];
    if (!project) throw new Error("Expected the registered project in the projection.");
    await dispatch({
      type: "worktree.create",
      worktreeId,
      projectId: ProjectId.parse(project.projectId),
      path: "C:\\workspace\\queue-tree",
      workspaceRoot: "C:\\workspace",
      branch: "feature/queue",
    });
    await dispatch({ type: "thread.start", threadId, worktreeId, provider: "codex", cwd: "C:\\workspace\\queue-tree" });
    await reactor.waitForIdle();

    await dispatch({ type: "thread.queue", queueId: "q1", threadId, text: "first" });
    await dispatch({ type: "thread.queue", queueId: "q2", threadId, text: "second" });
    await reactor.waitForIdle();
    expect(sent()).toEqual(["first"]);
    expect(await state()).toEqual({ status: "working", queued: ["second"] });

    adapter.emit({ type: "turn.completed", threadId, turnId: "turn-1", status: "completed" });
    await reactor.waitForIdle();
    expect(sent()).toEqual(["first", "second"]);
    expect(await state()).toEqual({ status: "working", queued: [] });

    await dispatch({ type: "thread.queue", queueId: "q3", threadId, text: "third" });
    await dispatch({ type: "thread.steer", threadId, queueId: "q3" });
    await reactor.waitForIdle();
    expect(adapter.interrupted).toEqual(["turn-2"]);
    expect(sent()).toEqual(["first", "second", "third"]);
    expect(await state()).toEqual({ status: "working", queued: [] });

    // The interrupted turn reports completion after the steered message has started.
    adapter.emit({ type: "turn.completed", threadId, turnId: "turn-2", status: "interrupted" });
    await reactor.waitForIdle();
    expect((await state()).status).toBe("working");
    adapter.emit({ type: "turn.completed", threadId, turnId: "turn-3", status: "completed" });
    await reactor.waitForIdle();
    expect((await state()).status).toBe("idle");

    reactor.stop();
    await service.stopAll();
    service.dispose();
  });

  it("interrupts a turn that was stopped while the provider was still accepting it", async () => {
    const database = new Database({ path: ":memory:" });
    databases.push(database);
    const engine = new Engine({ database, environment });
    let accept: (() => void) | undefined;
    const adapter = new (class extends FakeAdapter {
      interrupted: (string | undefined)[] = [];
      override async sendTurn(input: ProviderTurnInput): Promise<{ turnId: string }> {
        this.turnInputs.push(input);
        await new Promise<void>((resolve) => {
          accept = resolve;
        });
        return { turnId: "turn-1" };
      }
      override async interruptTurn(input?: { turnId?: string }): Promise<void> {
        this.interrupted.push(input?.turnId);
      }
    })();
    const service = new ProviderService(new ProviderRegistry([adapter]));
    const reactor = new ProviderReactor(engine, service);
    let sequence = 0;
    const dispatch = (command: Parameters<Engine["dispatchPromise"]>[0]["command"]) => {
      sequence += 1;
      return engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(`10000000-0000-4000-8000-0000000019${String(sequence).padStart(2, "0")}`),
        command,
      });
    };
    const status = async () => (await engine.projection()).threads[0]?.status;

    await dispatch({ type: "project.register", path: "C:\\workspace\\stop" });
    const project = (await engine.projection()).projects[0];
    if (!project) throw new Error("Expected the registered project in the projection.");
    await dispatch({
      type: "worktree.create",
      worktreeId,
      projectId: ProjectId.parse(project.projectId),
      path: "C:\\workspace\\stop-tree",
      workspaceRoot: "C:\\workspace",
      branch: "feature/stop",
    });
    await dispatch({ type: "thread.start", threadId, worktreeId, provider: "codex", cwd: "C:\\workspace\\stop-tree" });
    await reactor.waitForIdle();

    await dispatch({ type: "thread.queue", queueId: "s1", threadId, text: "keep working" });
    await vi.waitFor(() => expect(accept).toBeDefined());
    await dispatch({ type: "thread.interrupt", threadId });
    await vi.waitFor(async () => expect(await status()).toBe("idle"));
    accept?.();
    await reactor.waitForIdle();
    expect(adapter.interrupted.at(-1)).toBe("turn-1");
    expect(await status()).toBe("idle");

    // The provider's own start report for the stopped turn arrives late and must not revive it.
    adapter.emit({ type: "turn.started", threadId, turnId: "turn-1" });
    await reactor.waitForIdle();
    expect(await status()).toBe("idle");

    reactor.stop();
    await service.stopAll();
    service.dispose();
  });

  it("turns durable thread intents into provider sessions and projected messages", async () => {
    const database = new Database({ path: ":memory:" });
    databases.push(database);
    const engine = new Engine({ database, environment });
    const adapter = new FakeAdapter();
    const service = new ProviderService(new ProviderRegistry([adapter]));
    const reactor = new ProviderReactor(engine, service);

    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("10000000-0000-4000-8000-000000000901"),
      command: { type: "project.register", path: "C:\\workspace\\provider" },
    });
    const registeredProject = (await engine.projection()).projects[0];
    if (!registeredProject) throw new Error("Expected the registered project in the projection.");
    const projectId = ProjectId.parse(registeredProject.projectId);
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("10000000-0000-4000-8000-000000000902"),
      command: {
        type: "worktree.create",
        worktreeId,
        projectId,
        path: "C:\\workspace\\provider-tree",
        workspaceRoot: "C:\\workspace",
        branch: "feature/provider",
      },
    });
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("10000000-0000-4000-8000-000000000903"),
      command: { type: "thread.start", threadId, worktreeId, provider: "codex", cwd: "C:\\workspace\\provider-tree" },
    });
    await reactor.waitForIdle();

    expect(adapter.started).toBe(true);
    expect((await engine.projection()).threads[0]).toMatchObject({ threadId, status: "idle", worktreeId });

    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("10000000-0000-4000-8000-000000000904"),
      command: { type: "thread.send", threadId, text: "run tests" },
    });
    await reactor.waitForIdle();
    adapter.emit({
      type: "assistant.delta",
      threadId: ThreadId.parse(threadId),
      turnId: "provider-turn",
      text: "Tests are running.",
    });
    await reactor.waitForIdle();

    expect((await engine.projection()).messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId, role: "user", text: "run tests" }),
        expect.objectContaining({ threadId, role: "assistant", text: "Tests are running." }),
      ]),
    );
    adapter.emit({ type: "approval.requested", threadId, requestId: "approval-1", payload: { command: "git status" } });
    await reactor.waitForIdle();
    expect((await engine.projection()).requests).toEqual([
      expect.objectContaining({ requestId: "approval-1", kind: "approval" }),
    ]);
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("10000000-0000-4000-8000-000000000905"),
      command: { type: "thread.respond", threadId, requestId: "approval-1", decision: { approved: true } },
    });
    await reactor.waitForIdle();
    expect(adapter.responded).toBe(true);
    expect((await engine.projection()).requests).toEqual([]);

    adapter.emit({
      type: "turn.started",
      threadId,
      turnId: "00000000-0000-4000-8000-0000000009a1",
    });
    await reactor.waitForIdle();
    expect((await engine.projection()).threads[0]).toMatchObject({ status: "working" });
    adapter.emit({
      type: "provider.error",
      message: "Cursor CLI denied a tool call, which this adapter does not approve.",
    });
    await reactor.waitForIdle();
    expect((await engine.projection()).threads[0]).toMatchObject({ status: "working" });

    adapter.emit({ type: "session.closed", threadId, reason: "provider process exited" });
    await reactor.waitForIdle();
    expect((await engine.projection()).threads[0]).toMatchObject({ threadId, status: "stopped" });

    reactor.stop();
    await service.stopAll();
    service.dispose();
  });
  it("merges streamed fragments, records the prompt first, and reports real failure text", async () => {
    const database = new Database({ path: ":memory:" });
    databases.push(database);
    const engine = new Engine({ database, environment });
    const adapter = new FakeAdapter();
    const service = new ProviderService(new ProviderRegistry([adapter]));
    const reactor = new ProviderReactor(engine, service);

    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("10000000-0000-4000-8000-000000000911"),
      command: { type: "project.register", path: "C:\\workspace\\stream" },
    });
    const project = (await engine.projection()).projects[0];
    if (!project) throw new Error("Expected the registered project in the projection.");
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("10000000-0000-4000-8000-000000000912"),
      command: {
        type: "worktree.create",
        worktreeId,
        projectId: ProjectId.parse(project.projectId),
        path: "C:\\workspace\\stream-tree",
        workspaceRoot: "C:\\workspace",
        branch: "feature/stream",
      },
    });
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("10000000-0000-4000-8000-000000000913"),
      command: { type: "thread.start", threadId, worktreeId, provider: "codex", cwd: "C:\\workspace\\stream-tree" },
    });
    await reactor.waitForIdle();
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("10000000-0000-4000-8000-000000000914"),
      command: { type: "thread.send", threadId, text: "say pong" },
    });
    await reactor.waitForIdle();
    for (const text of ["P", "ON", "G"]) adapter.emit({ type: "assistant.delta", threadId, turnId: "turn-a", text });
    await reactor.waitForIdle();
    adapter.emit({ type: "assistant.delta", threadId, turnId: "turn-a", text: "!" });
    adapter.emit({ type: "turn.completed", threadId, turnId: "turn-a", status: "completed" });
    await reactor.waitForIdle();

    const messages = ((await engine.projection()).messages ?? []).filter((message) => message.threadId === threadId);
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "say pong"],
      ["assistant", "PONG!"],
    ]);

    adapter.emit({ type: "provider.error", threadId, message: "Cursor CLI exited (1): not logged in" });
    await reactor.waitForIdle();
    expect((await engine.projection()).threads[0]).toMatchObject({
      status: "failed",
      errorMessage: "Cursor CLI exited (1): not logged in",
    });

    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("10000000-0000-4000-8000-000000000915"),
      command: { type: "thread.status", threadId, status: "idle" },
    });
    expect((await engine.projection()).threads[0]?.errorMessage).toBeUndefined();
    reactor.stop();
    service.dispose();

    const restartedService = new ProviderService(new ProviderRegistry([new FakeAdapter()]));
    const restartedReactor = new ProviderReactor(engine, restartedService);
    await restartedReactor.reconcileOrphanedThreads();
    expect((await engine.projection()).threads[0]).toMatchObject({ status: "stopped" });
    expect((await engine.projection()).threads[0]?.errorMessage).toContain("restarted");
    restartedReactor.stop();
    restartedService.dispose();
  });
  it("passes permission mode and model to the session, attachments to the turn, and records tool activity in order", async () => {
    const database = new Database({ path: ":memory:" });
    databases.push(database);
    const engine = new Engine({ database, environment });
    const adapter = new FakeAdapter();
    const service = new ProviderService(new ProviderRegistry([adapter]));
    const reactor = new ProviderReactor(engine, service);

    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("10000000-0000-4000-8000-000000000921"),
      command: { type: "project.register", path: "C:\\workspace\\activity" },
    });
    const project = (await engine.projection()).projects[0];
    if (!project) throw new Error("Expected the registered project in the projection.");
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("10000000-0000-4000-8000-000000000922"),
      command: {
        type: "worktree.create",
        worktreeId,
        projectId: ProjectId.parse(project.projectId),
        path: "C:\\workspace\\activity-tree",
        workspaceRoot: "C:\\workspace",
        branch: "feature/activity",
      },
    });
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("10000000-0000-4000-8000-000000000923"),
      command: {
        type: "thread.start",
        threadId,
        worktreeId,
        provider: "codex",
        cwd: "C:\\workspace\\activity-tree",
        permissionMode: "supervised",
        model: "gpt-5",
      },
    });
    await reactor.waitForIdle();
    expect(adapter.startInputs).toEqual([
      expect.objectContaining({
        threadId,
        cwd: "C:\\workspace\\activity-tree",
        worktreeId,
        permissionMode: "supervised",
        model: "gpt-5",
      }),
    ]);

    const image = { name: "shot.png", mimeType: "image/png" as const, path: "C:\\zli\\attachments\\shot.png" };
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("10000000-0000-4000-8000-000000000924"),
      command: { type: "thread.send", threadId, text: "fix the layout", attachments: [image] },
    });
    await reactor.waitForIdle();
    expect(adapter.turnInputs).toEqual([
      {
        threadId,
        text: promptWithAttachments("fix the layout", [image]),
        attachments: [image],
      },
    ]);
    expect(adapter.turnInputs[0]?.text).toContain("C:\\zli\\attachments\\shot.png");
    expect((await engine.projection()).messages).toEqual([
      expect.objectContaining({ role: "user", text: "fix the layout", attachments: [image] }),
    ]);

    adapter.emit({ type: "assistant.delta", threadId, turnId: "turn-b", text: "Checking tests." });
    adapter.emit({
      type: "activity",
      threadId,
      turnId: "turn-b",
      activity: { activityId: "call-1", kind: "command", title: "npm test", status: "running" },
    });
    await reactor.waitForIdle();
    adapter.emit({
      type: "activity",
      threadId,
      turnId: "turn-b",
      activity: {
        activityId: "call-1",
        kind: "command",
        title: "npm test",
        detail: "1 failed\n\n",
        status: "failed",
        connector: { server: "linear", reason: "sign-in" },
      },
    });
    adapter.emit({
      type: "activity",
      threadId,
      activity: {
        activityId: "multi\nline",
        kind: "file-read",
        title: "   ",
        status: "completed",
        files: ["a.ts", ""],
      },
    });
    await reactor.waitForIdle();

    const projection = await engine.projection();
    expect(projection.messages?.map((message) => [message.role, message.text])).toEqual([
      ["user", "fix the layout"],
      ["assistant", "Checking tests."],
    ]);
    expect(projection.activities).toEqual([
      {
        activityId: `${threadId}:call-1`,
        threadId,
        turnId: "turn-b",
        kind: "command",
        title: "npm test",
        detail: "1 failed",
        status: "failed",
        textOffset: 15,
        connector: { server: "linear", reason: "sign-in" },
      },
      {
        activityId: expect.stringMatching(new RegExp(`^${threadId}:[0-9a-f]{40}$`, "u")),
        threadId,
        kind: "file-read",
        title: "Tool call",
        status: "completed",
        files: ["a.ts"],
      },
    ]);

    reactor.stop();
    await service.stopAll();
    service.dispose();
  });
  it("stops a deleted session's provider and drops its late output", async () => {
    const database = new Database({ path: ":memory:" });
    databases.push(database);
    const engine = new Engine({ database, environment });
    const adapter = new FakeAdapter();
    const service = new ProviderService(new ProviderRegistry([adapter]));
    const reactor = new ProviderReactor(engine, service);
    const sessionId = "00000000-0000-4000-8000-000000000990";
    const dispatch = (suffix: string, command: Record<string, unknown>) =>
      engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(`10000000-0000-4000-8000-0000000009${suffix}`),
        command,
      } as never);

    await dispatch("71", { type: "project.register", path: "C:\\workspace\\provider" });
    const project = (await engine.projection()).projects[0];
    if (!project) throw new Error("Expected the registered project in the projection.");
    await dispatch("72", {
      type: "worktree.create",
      worktreeId,
      projectId: project.projectId,
      path: "C:\\workspace\\provider-tree",
      workspaceRoot: "C:\\workspace",
      branch: "feature/provider",
    });
    await dispatch("73", {
      type: "thread.start",
      threadId,
      worktreeId,
      provider: "codex",
      cwd: "C:\\workspace\\provider-tree",
      sessionId,
    });
    await reactor.waitForIdle();
    expect(adapter.started).toBe(true);

    await dispatch("74", { type: "session.delete", sessionId });
    await reactor.waitForIdle();
    expect(adapter.started).toBe(false);

    const before = (await engine.projection()).lastSequence;
    adapter.emit({ type: "assistant.delta", threadId, turnId: "late", text: "late text" });
    adapter.emit({ type: "session.closed", threadId, reason: "gone" });
    await reactor.waitForIdle();
    const after = await engine.projection();
    expect(after.threads).toEqual([]);
    expect(after.lastSequence).toBe(before);
    reactor.stop();
  });
});

describe("ProviderReactor resume", () => {
  async function setup(adapter: FakeAdapter) {
    const database = new Database({ path: ":memory:" });
    databases.push(database);
    const engine = new Engine({ database, environment });
    const service = new ProviderService(new ProviderRegistry([adapter]));
    const reactor = new ProviderReactor(engine, service);
    let sequence = 0;
    const dispatch = (command: Parameters<Engine["dispatchPromise"]>[0]["command"]) => {
      sequence += 1;
      return engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(`40000000-0000-4000-8000-0000000009${String(sequence).padStart(2, "0")}`),
        command,
      });
    };
    await dispatch({ type: "project.register", path: "C:\\workspace\\resume" });
    const project = (await engine.projection()).projects[0];
    if (!project) throw new Error("Expected the registered project in the projection.");
    await dispatch({
      type: "worktree.create",
      worktreeId,
      projectId: ProjectId.parse(project.projectId),
      path: "C:\\workspace\\resume-tree",
      workspaceRoot: "C:\\workspace",
      branch: "feature/resume",
    });
    await dispatch({
      type: "thread.start",
      threadId,
      worktreeId,
      provider: "codex",
      cwd: "C:\\workspace\\resume-tree",
    });
    await reactor.waitForIdle();
    const thread = async () => (await engine.projection()).threads[0];
    const messages = async () =>
      ((await engine.projection()).messages ?? []).map((message) => [message.role, message.text]);
    const cleanup = async () => {
      reactor.stop();
      await service.stopAll();
      service.dispose();
    };
    return { engine, reactor, dispatch, thread, messages, cleanup };
  }

  class IdentifiedAdapter extends FakeAdapter {
    failResumeAtStart = false;
    override async startSession(input: ProviderSessionStart): Promise<ProviderSession> {
      this.startInputs.push(input);
      if (input.resumeSessionId && this.failResumeAtStart) throw new Error("No conversation found");
      this.started = true;
      const providerSessionId = input.resumeSessionId ?? `conv-${this.startInputs.length}`;
      return { threadId: input.threadId, provider: this.provider, cwd: input.cwd, status: "idle", providerSessionId };
    }
  }

  it("records the agent's conversation id and resumes it when an ended chat gets a message", async () => {
    const adapter = new IdentifiedAdapter();
    const { reactor, dispatch, thread, messages, cleanup } = await setup(adapter);
    expect(await thread()).toMatchObject({ status: "idle", providerSessionId: "conv-1" });

    adapter.emit({ type: "session.identified", threadId, providerSessionId: "conv-renamed" });
    await reactor.waitForIdle();
    expect((await thread())?.providerSessionId).toBe("conv-renamed");

    await dispatch({ type: "thread.stop", threadId });
    await reactor.waitForIdle();
    expect((await thread())?.status).toBe("stopped");

    await dispatch({ type: "thread.queue", queueId: "r1", threadId, text: "keep going" });
    await reactor.waitForIdle();
    expect(adapter.startInputs.at(-1)).toMatchObject({
      resumeSessionId: "conv-renamed",
      cwd: "C:\\workspace\\resume-tree",
    });
    expect(adapter.turnInputs.map((input) => input.text)).toEqual(["keep going"]);
    expect(await thread()).toMatchObject({ status: "working", providerSessionId: "conv-renamed" });
    expect(await messages()).toEqual([["user", "keep going"]]);
    await cleanup();
  });

  it("starts a fresh conversation in the same chat when the CLI refuses the earlier one at startup", async () => {
    const adapter = new IdentifiedAdapter();
    adapter.failResumeAtStart = true;
    const { reactor, dispatch, thread, messages, cleanup } = await setup(adapter);
    await dispatch({ type: "thread.stop", threadId });
    await reactor.waitForIdle();

    await dispatch({ type: "thread.queue", queueId: "r1", threadId, text: "still there?" });
    await reactor.waitForIdle();
    expect(adapter.startInputs.map((input) => input.resumeSessionId)).toEqual([undefined, "conv-1", undefined]);
    expect(adapter.turnInputs.map((input) => input.text)).toEqual(["still there?"]);
    expect(await thread()).toMatchObject({ status: "working", providerSessionId: "conv-3" });
    const log = await messages();
    expect(log).toHaveLength(2);
    expect(log[0]?.[0]).toBe("system");
    expect(log[0]?.[1]).toContain("could not be resumed");
    expect(log[1]).toEqual(["user", "still there?"]);
    await cleanup();
  });

  it("starts over and sends the message again when the first resumed turn fails", async () => {
    const adapter = new (class extends IdentifiedAdapter {
      override async sendTurn(input: ProviderTurnInput): Promise<{ turnId: string }> {
        this.turnInputs.push(input);
        const resumed = this.startInputs.at(-1)?.resumeSessionId;
        if (resumed)
          queueMicrotask(() => this.emit({ type: "session.closed", threadId, reason: "No conversation found" }));
        return { turnId: `turn-${this.turnInputs.length}` };
      }
    })();
    const { reactor, dispatch, thread, messages, cleanup } = await setup(adapter);
    await dispatch({ type: "thread.stop", threadId });
    await reactor.waitForIdle();

    await dispatch({ type: "thread.queue", queueId: "r1", threadId, text: "pick it up" });
    await reactor.waitForIdle();
    await reactor.waitForIdle();
    expect(adapter.startInputs.map((input) => input.resumeSessionId)).toEqual([undefined, "conv-1", undefined]);
    expect(adapter.turnInputs.map((input) => input.text)).toEqual(["pick it up", "pick it up"]);
    expect((await thread())?.status).toBe("working");
    const log = await messages();
    expect(log.filter(([role]) => role === "user")).toEqual([["user", "pick it up"]]);
    expect(log.filter(([role]) => role === "system")).toHaveLength(1);
    await cleanup();
  });

  it("starts the agent again on its conversation when a message follows a crash", async () => {
    const adapter = new (class extends IdentifiedAdapter {
      override async sendTurn(input: ProviderTurnInput): Promise<{ turnId: string }> {
        this.turnInputs.push(input);
        return { turnId: `turn-${this.turnInputs.length}` };
      }
    })();
    const { reactor, dispatch, thread, cleanup } = await setup(adapter);
    await dispatch({ type: "thread.queue", queueId: "c1", threadId, text: "before the crash" });
    await reactor.waitForIdle();
    expect((await thread())?.status).toBe("working");

    adapter.emit({ type: "session.closed", threadId, reason: "Codex exited (1)." });
    await reactor.waitForIdle();
    expect(await thread()).toMatchObject({ status: "stopped", errorMessage: "Codex exited (1)." });

    await dispatch({ type: "thread.queue", queueId: "c2", threadId, text: "after the crash" });
    await reactor.waitForIdle();
    expect(adapter.startInputs.map((input) => input.resumeSessionId)).toEqual([undefined, "conv-1"]);
    expect(adapter.turnInputs.map((input) => input.text)).toEqual(["before the crash", "after the crash"]);
    expect(await thread()).toMatchObject({ status: "working", providerSessionId: "conv-1" });

    adapter.emit({ type: "turn.completed", threadId, turnId: "turn-2", status: "completed" });
    await reactor.waitForIdle();
    adapter.emit({ type: "session.closed", threadId, reason: "Codex exited (1)." });
    await reactor.waitForIdle();
    await dispatch({ type: "thread.queue", queueId: "c3", threadId, text: "and again" });
    await reactor.waitForIdle();
    expect(adapter.turnInputs.map((input) => input.text)).toEqual(["before the crash", "after the crash", "and again"]);
    expect((await thread())?.status).toBe("working");
    await cleanup();
  });

  it("interrupts the new turn, not the one that died, when Stop follows a send after a crash", async () => {
    let releaseTurn: (() => void) | undefined;
    const adapter = new (class extends IdentifiedAdapter {
      readonly interrupted: (string | undefined)[] = [];
      override async sendTurn(input: ProviderTurnInput): Promise<{ turnId: string }> {
        this.turnInputs.push(input);
        if (this.turnInputs.length > 1) await new Promise<void>((resolve) => (releaseTurn = resolve));
        return { turnId: `turn-${this.turnInputs.length}` };
      }
      override async interruptTurn(input?: { turnId?: string }): Promise<void> {
        this.interrupted.push(input?.turnId);
      }
    })();
    const { reactor, dispatch, thread, cleanup } = await setup(adapter);
    await dispatch({ type: "thread.queue", queueId: "c1", threadId, text: "first" });
    await reactor.waitForIdle();
    adapter.emit({ type: "session.closed", threadId, reason: "Codex exited (1)." });
    await reactor.waitForIdle();

    await dispatch({ type: "thread.queue", queueId: "c2", threadId, text: "second" });
    await vi.waitFor(() => expect(releaseTurn).toBeDefined());
    await dispatch({ type: "thread.interrupt", threadId });
    releaseTurn?.();
    await reactor.waitForIdle();
    expect(adapter.interrupted.at(-1)).toBe("turn-2");
    expect((await thread())?.status).toBe("idle");
    await cleanup();
  });

  it("keeps refusing messages to an ended chat that has no conversation id", async () => {
    const adapter = new FakeAdapter();
    const { reactor, dispatch, cleanup } = await setup(adapter);
    await dispatch({ type: "thread.stop", threadId });
    await reactor.waitForIdle();
    expect(await dispatch({ type: "thread.queue", queueId: "r1", threadId, text: "hello" })).toMatchObject({
      status: "rejected",
      error: { message: expect.stringContaining("Start a new chat") },
    });
    await cleanup();
  });
});

describe("ProviderReactor open requests", () => {
  async function setup(adapter: FakeAdapter) {
    const database = new Database({ path: ":memory:" });
    databases.push(database);
    const engine = new Engine({ database, environment });
    const service = new ProviderService(new ProviderRegistry([adapter]));
    const reactor = new ProviderReactor(engine, service);
    let sequence = 0;
    const dispatch = (command: Parameters<Engine["dispatchPromise"]>[0]["command"]) => {
      sequence += 1;
      return engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(`50000000-0000-4000-8000-0000000009${String(sequence).padStart(2, "0")}`),
        command,
      });
    };
    await dispatch({ type: "project.register", path: "C:\\workspace\\requests" });
    const project = (await engine.projection()).projects[0];
    if (!project) throw new Error("Expected the registered project in the projection.");
    await dispatch({
      type: "worktree.create",
      worktreeId,
      projectId: ProjectId.parse(project.projectId),
      path: "C:\\workspace\\requests-tree",
      workspaceRoot: "C:\\workspace",
      branch: "feature/requests",
    });
    await dispatch({
      type: "thread.start",
      threadId,
      worktreeId,
      provider: "codex",
      cwd: "C:\\workspace\\requests-tree",
    });
    await reactor.waitForIdle();
    await dispatch({ type: "thread.send", threadId, text: "clean the build folder" });
    await reactor.waitForIdle();
    adapter.emit({
      type: "approval.requested",
      threadId,
      requestId: "approval-1",
      payload: { command: "rm -rf build" },
    });
    await reactor.waitForIdle();
    const state = async () => {
      const projection = await engine.projection();
      return {
        status: projection.threads[0]?.status,
        requests: (projection.requests ?? []).map((request) => request.requestId),
        attention: projection.attention.map((item) => item.id),
      };
    };
    expect(await state()).toEqual({
      status: "waiting",
      requests: ["approval-1"],
      attention: ["thread-request:approval-1"],
    });
    const cleanup = async () => {
      reactor.stop();
      await service.stopAll();
      service.dispose();
    };
    return { engine, service, reactor, dispatch, state, cleanup };
  }

  const closed = { status: "idle", requests: [], attention: [] };

  it("closes the request when the turn is stopped, so the next message is sent", async () => {
    const adapter = new FakeAdapter();
    const { reactor, dispatch, state, cleanup } = await setup(adapter);

    await dispatch({ type: "thread.interrupt", threadId });
    await reactor.waitForIdle();
    expect(await state()).toEqual(closed);

    await dispatch({ type: "thread.queue", queueId: "after-stop", threadId, text: "hello after stop" });
    await reactor.waitForIdle();
    expect(adapter.turnInputs.map((input) => input.text)).toEqual(["clean the build folder", "hello after stop"]);
    expect((await state()).status).toBe("working");
    await cleanup();
  });

  it("closes the request when the session is stopped", async () => {
    const { reactor, dispatch, state, cleanup } = await setup(new FakeAdapter());
    await dispatch({ type: "thread.stop", threadId });
    await reactor.waitForIdle();
    expect(await state()).toEqual({ ...closed, status: "stopped" });
    await cleanup();
  });

  it("closes the request when the session ends or fails on its own", async () => {
    const endings: [ProviderEvent, string][] = [
      [{ type: "session.closed", threadId, reason: "provider process exited" }, "stopped"],
      [{ type: "provider.error", threadId, message: "Codex crashed" }, "failed"],
    ];
    for (const [event, status] of endings) {
      const adapter = new FakeAdapter();
      const { reactor, state, cleanup } = await setup(adapter);
      adapter.emit(event);
      await reactor.waitForIdle();
      expect(await state()).toEqual({ ...closed, status });
      await cleanup();
    }
  });

  it("closes requests left open by a restart, and an answer to one is refused without failing the chat", async () => {
    const { engine, reactor, service, dispatch, state } = await setup(new FakeAdapter());
    reactor.stop();
    service.dispose();

    const restartedService = new ProviderService(new ProviderRegistry([new FakeAdapter()]));
    const restartedReactor = new ProviderReactor(engine, restartedService);
    await restartedReactor.reconcileOrphanedThreads();
    await restartedReactor.waitForIdle();
    expect(await state()).toEqual({ ...closed, status: "stopped" });

    const answer = await dispatch({
      type: "thread.respond",
      threadId,
      requestId: "approval-1",
      decision: { approved: true },
    });
    expect(answer).toMatchObject({ status: "rejected", error: { message: expect.stringContaining("does not exist") } });
    await restartedReactor.waitForIdle();
    expect((await state()).status).toBe("stopped");

    // A chat that an older build stopped with its request still open is cleaned up on the next start.
    await dispatch({
      type: "thread.request",
      request: { requestId: "approval-2", threadId, kind: "approval", payload: {} },
    });
    restartedReactor.stop();
    restartedService.dispose();
    const laterService = new ProviderService(new ProviderRegistry([new FakeAdapter()]));
    const laterReactor = new ProviderReactor(engine, laterService);
    await laterReactor.reconcileOrphanedThreads();
    await laterReactor.waitForIdle();
    expect(await state()).toEqual({ ...closed, status: "stopped" });
    laterReactor.stop();
    laterService.dispose();
  });

  it("does not fail the chat when an answer loses a race with the session ending", async () => {
    const adapter = new (class extends FakeAdapter {
      override async respondToRequest(): Promise<void> {
        this.emit({ type: "session.closed", threadId, reason: "provider process exited" });
        throw new Error("Provider session does not exist");
      }
    })();
    const { reactor, dispatch, state, cleanup } = await setup(adapter);
    await dispatch({ type: "thread.respond", threadId, requestId: "approval-1", decision: { approved: true } });
    await reactor.waitForIdle();
    expect(await state()).toEqual({ ...closed, status: "stopped" });
    await cleanup();
  });

  it("leaves the chat idle when the answered turn finishes before the answer is recorded", async () => {
    const adapter = new (class extends FakeAdapter {
      override async respondToRequest(): Promise<void> {
        this.emit({ type: "turn.completed", threadId, turnId: "provider-turn", status: "completed" });
      }
    })();
    const { reactor, dispatch, state, cleanup } = await setup(adapter);
    await dispatch({ type: "thread.respond", threadId, requestId: "approval-1", decision: { approved: true } });
    await reactor.waitForIdle();
    expect(await state()).toEqual(closed);
    await cleanup();
  });
});

describe("promptWithAttachments", () => {
  it("leaves text alone without attachments and lists stored paths otherwise", () => {
    expect(promptWithAttachments("hello", [])).toBe("hello");
    expect(
      promptWithAttachments("hello", [
        { name: "a.png", mimeType: "image/png", path: "/tmp/a.png" },
        { name: "b.jpg", mimeType: "image/jpeg", path: "/tmp/b.jpg" },
      ]),
    ).toBe("hello\n\nAttached images (read them from disk):\n- /tmp/a.png\n- /tmp/b.jpg");
  });

  it("lists pasted text separately from images", () => {
    expect(
      promptWithAttachments("review this", [
        { name: "pasted-text-1.txt", mimeType: "text/plain", path: "/tmp/p.txt" },
        { name: "a.png", mimeType: "image/png", path: "/tmp/a.png" },
      ]),
    ).toBe(
      "review this\n\nAttached images (read them from disk):\n- /tmp/a.png\n\nAttached text the person pasted (read it from disk):\n- /tmp/p.txt",
    );
  });
});

describe("ProviderReactor usage", () => {
  it("records provider usage reports against the thread's turn", async () => {
    const database = new Database({ path: ":memory:" });
    databases.push(database);
    const engine = new Engine({ database, environment });
    const adapter = new FakeAdapter();
    const service = new ProviderService(new ProviderRegistry([adapter]));
    const reactor = new ProviderReactor(engine, service);
    let sequence = 0;
    const dispatch = (command: Parameters<Engine["dispatchPromise"]>[0]["command"]) => {
      sequence += 1;
      return engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(`20000000-0000-4000-8000-0000000009${String(sequence).padStart(2, "0")}`),
        command,
      });
    };
    await dispatch({ type: "project.register", path: "C:\\workspace\\usage" });
    const project = (await engine.projection()).projects[0];
    if (!project) throw new Error("Expected the registered project in the projection.");
    await dispatch({
      type: "worktree.create",
      worktreeId,
      projectId: ProjectId.parse(project.projectId),
      path: "C:\\workspace\\usage-tree",
      workspaceRoot: "C:\\workspace",
      branch: "feature/usage",
    });
    await dispatch({
      type: "thread.start",
      threadId,
      worktreeId,
      provider: "codex",
      cwd: "C:\\workspace\\usage-tree",
      model: "gpt-5",
    });
    await reactor.waitForIdle();

    adapter.emit({ type: "usage", threadId, turnId: "provider-turn", usage: { inputTokens: 40, outputTokens: 5 } });
    adapter.emit({ type: "usage", threadId, turnId: "provider-turn", usage: { inputTokens: 90, outputTokens: 12 } });
    await reactor.waitForIdle();

    const records = (await engine.projection()).usage ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      threadId,
      turnId: "provider-turn",
      provider: "codex",
      projectId: project.projectId,
      model: "gpt-5",
      usage: { inputTokens: 90, outputTokens: 12 },
    });
    reactor.stop();
  });

  it("snapshots files before each turn and records them when the turn ends or is steered away", async () => {
    const database = new Database({ path: ":memory:" });
    databases.push(database);
    const engine = new Engine({ database, environment });
    let turns = 0;
    const order: string[] = [];
    const adapter = new (class extends FakeAdapter {
      override async sendTurn(input: ProviderTurnInput): Promise<{ turnId: string }> {
        this.turnInputs.push(input);
        turns += 1;
        order.push(`send ${input.text}`);
        return { turnId: `turn-${turns}` };
      }
    })();
    const recorded: Array<[string, string, string]> = [];
    const checkpoints = {
      capture: async (id: string) => {
        order.push("capture");
        return {
          worktreeId,
          worktreePath: "C:\\workspace\\checkpoint-tree",
          tree: `tree-${id.slice(-1)}-${turns + 1}`,
        };
      },
      record: async (id: string, turnId: string, start: { tree: string }) => {
        recorded.push([id, turnId, start.tree]);
      },
    };
    const service = new ProviderService(new ProviderRegistry([adapter]));
    const reactor = new ProviderReactor(engine, service, checkpoints);
    let sequence = 0;
    const dispatch = (command: Parameters<Engine["dispatchPromise"]>[0]["command"]) => {
      sequence += 1;
      return engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(`30000000-0000-4000-8000-0000000009${String(sequence).padStart(2, "0")}`),
        command,
      });
    };
    await dispatch({ type: "project.register", path: "C:\\workspace\\checkpoint" });
    const project = (await engine.projection()).projects[0];
    if (!project) throw new Error("Expected the registered project in the projection.");
    await dispatch({
      type: "worktree.create",
      worktreeId,
      projectId: ProjectId.parse(project.projectId),
      path: "C:\\workspace\\checkpoint-tree",
      workspaceRoot: "C:\\workspace",
      branch: "feature/checkpoint",
    });
    await dispatch({
      type: "thread.start",
      threadId,
      worktreeId,
      provider: "codex",
      cwd: "C:\\workspace\\checkpoint-tree",
    });
    await reactor.waitForIdle();

    await dispatch({ type: "thread.queue", queueId: "c1", threadId, text: "first" });
    await reactor.waitForIdle();
    expect(order).toEqual(["capture", "send first"]);
    adapter.emit({ type: "turn.completed", threadId, turnId: "turn-1", status: "completed" });
    await reactor.waitForIdle();
    expect(recorded).toEqual([[threadId, "turn-1", "tree-4-1"]]);

    await dispatch({ type: "thread.queue", queueId: "c2", threadId, text: "second" });
    await reactor.waitForIdle();
    await dispatch({ type: "thread.queue", queueId: "c3", threadId, text: "third" });
    await dispatch({ type: "thread.steer", threadId, queueId: "c3" });
    await reactor.waitForIdle();
    expect(recorded).toEqual([
      [threadId, "turn-1", "tree-4-1"],
      [threadId, "turn-2", "tree-4-2"],
    ]);
    // The steered turn's late completion must not record it twice.
    adapter.emit({ type: "turn.completed", threadId, turnId: "turn-2", status: "interrupted" });
    adapter.emit({ type: "turn.completed", threadId, turnId: "turn-3", status: "completed" });
    await reactor.waitForIdle();
    expect(recorded.map(([, turnId, tree]) => `${turnId} ${tree}`)).toEqual([
      "turn-1 tree-4-1",
      "turn-2 tree-4-2",
      "turn-3 tree-4-3",
    ]);
    reactor.stop();
    await service.stopAll();
    service.dispose();
  });
});

describe("ProviderReactor accounts", () => {
  it("starts the thread's agent with its account and keeps the account on the thread", async () => {
    const database = new Database({ path: ":memory:" });
    databases.push(database);
    const engine = new Engine({ database, environment });
    const adapter = new FakeAdapter();
    const service = new ProviderService(new ProviderRegistry([adapter]));
    const asked: Array<string | undefined> = [];
    const reactor = new ProviderReactor(engine, service, undefined, {
      resolveAccount: async (_provider, accountId) => {
        asked.push(accountId);
        return accountId ? { accountId, env: { CODEX_HOME: "/zli/accounts/work" } } : undefined;
      },
    });
    let sequence = 0;
    const dispatch = (command: Parameters<Engine["dispatchPromise"]>[0]["command"]) => {
      sequence += 1;
      return engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(`30000000-0000-4000-8000-0000000009${String(sequence).padStart(2, "0")}`),
        command,
      });
    };
    await dispatch({ type: "project.register", path: "C:\\workspace\\accounts" });
    const project = (await engine.projection()).projects[0];
    if (!project) throw new Error("Expected the registered project in the projection.");
    await dispatch({
      type: "worktree.create",
      worktreeId,
      projectId: ProjectId.parse(project.projectId),
      path: "C:\\workspace\\accounts-tree",
      workspaceRoot: "C:\\workspace",
      branch: "feature/accounts",
    });
    await dispatch({
      type: "thread.start",
      threadId,
      worktreeId,
      provider: "codex",
      cwd: "C:\\workspace\\accounts-tree",
      accountId: "work",
    });
    await reactor.waitForIdle();

    expect(asked).toEqual(["work"]);
    expect(adapter.startInputs[0]?.account).toEqual({ accountId: "work", env: { CODEX_HOME: "/zli/accounts/work" } });
    expect((await engine.projection()).threads[0]?.accountId).toBe("work");
    reactor.stop();
  });
});

describe("ProviderReactor folder trust", () => {
  it("names the project folder for the agent to trust only after the person trusted the project", async () => {
    const database = new Database({ path: ":memory:" });
    databases.push(database);
    const engine = new Engine({ database, environment });
    const adapter = new FakeAdapter();
    const service = new ProviderService(new ProviderRegistry([adapter]));
    const reactor = new ProviderReactor(engine, service);
    let sequence = 0;
    const dispatch = (command: Parameters<Engine["dispatchPromise"]>[0]["command"]) => {
      sequence += 1;
      return engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(`30000000-0000-4000-8000-0000000010${String(sequence).padStart(2, "0")}`),
        command,
      });
    };
    await dispatch({ type: "project.register", path: "C:\\workspace\\trust" });
    const project = (await engine.projection()).projects[0];
    if (!project) throw new Error("Expected the registered project in the projection.");
    const projectId = ProjectId.parse(project.projectId);
    const start = async (n: number) => {
      const tree = WorktreeId.parse(`00000000-0000-4000-8000-000000000a1${n}`);
      await dispatch({
        type: "worktree.create",
        worktreeId: tree,
        projectId,
        path: `C:\\workspace\\trust-${n}`,
        workspaceRoot: "C:\\workspace",
        branch: `feature/trust-${n}`,
      });
      await dispatch({
        type: "thread.start",
        threadId: ThreadId.parse(`00000000-0000-4000-8000-000000000a2${n}`),
        worktreeId: tree,
        provider: "codex",
        cwd: `C:\\workspace\\trust-${n}`,
      });
      await reactor.waitForIdle();
      // The fake reports one session for every thread, so the next start would look like a duplicate.
      adapter.started = false;
    };
    await start(1);
    await dispatch({ type: "project.agents", projectId, trusted: true });
    await start(2);

    expect(adapter.startInputs.map((input) => input.trustedProjectPath)).toEqual([undefined, "C:\\workspace\\trust"]);
    reactor.stop();
  });
});
