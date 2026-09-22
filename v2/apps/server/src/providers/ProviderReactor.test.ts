import { afterEach, describe, expect, it } from "vitest";

import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  WorktreeId,
  type ThreadId as ThreadIdValue,
} from "@zli-v2/contracts";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import { ProviderReactor } from "./ProviderReactor.js";
import {
  ProviderRegistry,
  ProviderService,
  type ProviderAdapter,
  type ProviderEvent,
  type ProviderSession,
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

  async startSession(input: { threadId: ThreadIdValue; cwd: string }): Promise<ProviderSession> {
    this.started = true;
    return { threadId: input.threadId, provider: this.provider, cwd: input.cwd, status: "idle" };
  }
  async sendTurn(): Promise<{ turnId: string }> {
    return { turnId: "provider-turn" };
  }
  async interruptTurn(): Promise<void> {}
  async respondToRequest(): Promise<void> {
    this.responded = true;
  }
  async respondToUserInput(): Promise<void> {}
  async stopSession(): Promise<void> {
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
  emit(event: ProviderEvent): void {
    for (const listener of this.events) listener(event);
  }
}

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("ProviderReactor", () => {
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
    const projectId = ProjectId.parse((await engine.projection()).projects[0]!.projectId);
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

    adapter.emit({ type: "session.closed", threadId, reason: "provider process exited" });
    await reactor.waitForIdle();
    expect((await engine.projection()).threads[0]).toMatchObject({ threadId, status: "stopped" });

    reactor.stop();
    await service.stopAll();
    service.dispose();
  });
});
