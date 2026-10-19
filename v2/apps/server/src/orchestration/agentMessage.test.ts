import {
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  type RuntimeProjection,
  ThreadId,
  WorktreeId,
} from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { Database } from "../db/Database.js";
import type { ProviderAdapter, ProviderEvent, ProviderSession } from "../providers/ProviderService.js";
import { ProviderRegistry, ProviderService } from "../providers/ProviderService.js";
import { ProviderReactor } from "../providers/ProviderReactor.js";
import { AgentMessageReactor } from "./AgentMessageReactor.js";
import { DomainError, decide } from "./decider.js";
import { Engine } from "./Engine.js";
import { projectEvent } from "./projector.js";

const environment = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000701"),
  label: "Agent messages",
  protocolVersion: 1 as const,
  capabilities: { structuredProviders: true, eventReplay: true },
};

const projectA = ProjectId.parse("00000000-0000-4000-8000-000000000711");
const projectB = ProjectId.parse("00000000-0000-4000-8000-000000000712");
const worktreeA = WorktreeId.parse("00000000-0000-4000-8000-000000000721");
const worktreeA2 = WorktreeId.parse("00000000-0000-4000-8000-000000000723");
const worktreeB = WorktreeId.parse("00000000-0000-4000-8000-000000000722");
const threadA = ThreadId.parse("00000000-0000-4000-8000-000000000731");
const threadB = ThreadId.parse("00000000-0000-4000-8000-000000000732");
const threadC = ThreadId.parse("00000000-0000-4000-8000-000000000733");
const messageId = "agent-message-1";

function baseProjection(): RuntimeProjection {
  return {
    environment,
    projects: [
      { projectId: projectA, path: "C:\\work\\alpha", name: "alpha" },
      { projectId: projectB, path: "C:\\work\\beta", name: "beta" },
    ],
    worktrees: [
      { worktreeId: worktreeA, projectId: projectA, path: "C:\\work\\alpha\\a", branch: "feature-a", status: "ready" },
      { worktreeId: worktreeB, projectId: projectB, path: "C:\\work\\beta\\b", branch: "feature-b", status: "ready" },
    ],
    threads: [
      { threadId: threadA, worktreeId: worktreeA, provider: "codex", status: "idle", capabilities: {} },
      { threadId: threadB, worktreeId: worktreeA, provider: "claude-code", status: "idle", capabilities: {} },
      { threadId: threadC, worktreeId: worktreeB, provider: "cursor-agent", status: "idle", capabilities: {} },
    ],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 4,
  };
}

function command(targetThreadId: ThreadId, sourceThreadId: ThreadId = threadA, text = "  look at the failing test  ") {
  return {
    type: "thread.a2a" as const,
    messageId,
    sourceThreadId,
    targetThreadId,
    text,
  };
}

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("agent-to-agent project messages", () => {
  it("delivers a trimmed message onto the target thread in the same project", () => {
    const projection = baseProjection();
    const [decision] = decide(projection, command(threadB));
    if (decision?.type !== "thread.a2a.delivered") throw new Error("expected a delivered agent message");
    expect(decision).toEqual({
      type: "thread.a2a.delivered",
      projectId: projectA,
      message: {
        messageId,
        threadId: threadB,
        role: "agent",
        text: "look at the failing test",
        sourceThreadId: threadA,
      },
    });

    const next = projectEvent(projection, {
      protocolVersion: 1,
      sequence: 5,
      eventId: EventId.parse("00000000-0000-4000-8000-000000000741"),
      occurredAt: "2026-09-23T12:00:00.000Z",
      event: decision,
    });
    expect(next.messages).toEqual([
      {
        messageId,
        threadId: threadB,
        role: "agent",
        text: "look at the failing test",
        sourceThreadId: threadA,
      },
    ]);
    expect(next.messages?.some((message) => message.threadId === threadA)).toBe(false);
  });

  it("rejects a target thread in another project", () => {
    expect(() => decide(baseProjection(), command(threadC))).toThrowError(
      expect.objectContaining({
        name: "DomainError",
        code: "a2a_cross_project",
        message: "Agent messages can only be sent between threads in the same project.",
      }),
    );
    expect(() => decide(baseProjection(), command(threadC))).toThrow(DomainError);
  });

  it("rejects an unknown target and an unknown source", () => {
    const missing = ThreadId.parse("00000000-0000-4000-8000-000000000799");
    expect(() => decide(baseProjection(), command(missing))).toThrowError(
      expect.objectContaining({
        code: "thread_missing",
        message: `Thread does not exist: ${missing}`,
      }),
    );
    expect(() => decide(baseProjection(), command(threadB, missing))).toThrowError(
      expect.objectContaining({
        code: "thread_missing",
        message: `Thread does not exist: ${missing}`,
      }),
    );
  });

  it("records the delivered message in the event log and does not start a provider turn", async () => {
    const database = new Database({ path: ":memory:" });
    databases.push(database);
    const engine = new Engine({ database, environment });
    const adapter = new CountingAdapter();
    const providerService = new ProviderService(new ProviderRegistry([adapter]));
    const providerReactor = new ProviderReactor(engine, providerService);
    const agentReactor = new AgentMessageReactor(engine);

    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("00000000-0000-4000-8000-000000000751"),
      command: { type: "project.register", path: "C:\\work\\alpha" },
    });
    const registered = (await engine.projection()).projects[0];
    if (!registered) throw new Error("project was not registered");
    const projectId = registered.projectId;
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("00000000-0000-4000-8000-000000000752"),
      command: {
        type: "worktree.create",
        worktreeId: worktreeA,
        projectId,
        path: "C:\\work\\alpha\\a",
        workspaceRoot: "C:\\work",
        branch: "feature-a",
      },
    });
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("00000000-0000-4000-8000-000000000753"),
      command: {
        type: "thread.start",
        threadId: threadA,
        worktreeId: worktreeA,
        provider: "codex",
        cwd: "C:\\work\\alpha\\a",
      },
    });
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("00000000-0000-4000-8000-000000000760"),
      command: {
        type: "worktree.create",
        worktreeId: worktreeA2,
        projectId,
        path: "C:\\work\\alpha\\a2",
        workspaceRoot: "C:\\work",
        branch: "feature-a2",
      },
    });
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("00000000-0000-4000-8000-000000000754"),
      command: {
        type: "thread.start",
        threadId: threadB,
        worktreeId: worktreeA2,
        provider: "claude-code",
        cwd: "C:\\work\\alpha\\a2",
      },
    });
    await providerReactor.waitForIdle();
    adapter.turns = 0;

    const receipt = await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("00000000-0000-4000-8000-000000000755"),
      command: {
        type: "thread.a2a",
        messageId,
        sourceThreadId: threadA,
        targetThreadId: threadB,
        text: "please review the diff",
      },
    });
    await providerReactor.waitForIdle();
    await agentReactor.waitForIdle();

    expect(receipt).toMatchObject({ status: "accepted", eventTypes: ["thread.a2a.delivered"] });
    const events = await engine.eventsAfter(0);
    const delivered = events.filter((event) => event.event.type === "thread.a2a.delivered");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.event).toMatchObject({
      projectId,
      message: {
        threadId: threadB,
        role: "agent",
        text: "please review the diff",
        sourceThreadId: threadA,
      },
    });
    expect(events.some((event) => event.event.type === "thread.send.requested")).toBe(false);
    expect((await engine.projection()).messages).toEqual([
      expect.objectContaining({
        threadId: threadB,
        role: "agent",
        text: "please review the diff",
        sourceThreadId: threadA,
      }),
    ]);
    expect(adapter.turns).toBe(0);

    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("00000000-0000-4000-8000-000000000756"),
      command: { type: "project.register", path: "C:\\work\\beta" },
    });
    const otherProject = (await engine.projection()).projects.find((project) => project.path === "C:\\work\\beta");
    if (!otherProject) throw new Error("beta was not registered");
    const otherProjectId = otherProject.projectId;
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("00000000-0000-4000-8000-000000000757"),
      command: {
        type: "worktree.create",
        worktreeId: worktreeB,
        projectId: otherProjectId,
        path: "C:\\work\\beta\\b",
        workspaceRoot: "C:\\work",
        branch: "feature-b",
      },
    });
    await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("00000000-0000-4000-8000-000000000758"),
      command: {
        type: "thread.start",
        threadId: threadC,
        worktreeId: worktreeB,
        provider: "codex",
        cwd: "C:\\work\\beta\\b",
      },
    });
    await providerReactor.waitForIdle();
    adapter.turns = 0;

    const rejected = await engine.dispatchPromise({
      protocolVersion: 1,
      commandId: CommandId.parse("00000000-0000-4000-8000-000000000759"),
      command: {
        type: "thread.a2a",
        messageId: "cross-project",
        sourceThreadId: threadA,
        targetThreadId: threadC,
        text: "cross project",
      },
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      error: {
        code: "a2a_cross_project",
        message: "Agent messages can only be sent between threads in the same project.",
      },
    });
    expect((await engine.eventsAfter(0)).some((event) => JSON.stringify(event).includes("cross project"))).toBe(false);
    expect(adapter.turns).toBe(0);

    providerReactor.stop();
    agentReactor.stop();
    await providerService.stopAll();
    providerService.dispose();
  });
});

class CountingAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  readonly capabilities = {};
  turns = 0;

  async startSession(input: { threadId: ThreadId; cwd: string }): Promise<ProviderSession> {
    return { threadId: input.threadId, provider: this.provider, cwd: input.cwd, status: "idle" };
  }

  async sendTurn(): Promise<{ turnId: string }> {
    this.turns += 1;
    return { turnId: "turn-should-not-run" };
  }

  async interruptTurn(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async respondToUserInput(): Promise<void> {}
  async stopSession(): Promise<void> {}
  listSessions(): ReadonlyArray<ProviderSession> {
    return [];
  }
  hasSession(): boolean {
    return false;
  }
  async readThread(input: { threadId: ThreadId }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    return { threadId: input.threadId, turns: [] };
  }
  async rollbackThread(input: { threadId: ThreadId }): Promise<{ threadId: ThreadId; turns: ReadonlyArray<unknown> }> {
    return { threadId: input.threadId, turns: [] };
  }
  async stopAll(): Promise<void> {}
  subscribe(_listener: (event: ProviderEvent) => void): () => void {
    return () => undefined;
  }
}
