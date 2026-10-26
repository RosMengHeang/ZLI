import {
  EnvironmentId,
  EventId,
  ProjectId,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeEventEnvelope,
  type RuntimeProjection,
  SessionId,
  TerminalId,
  ThreadId,
  WorktreeId,
} from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { DomainError, decide } from "./decider.js";
import { projectEvent } from "./projector.js";

const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000402");
const terminalId = TerminalId.parse("00000000-0000-4000-8000-000000000404");

function projection(worktreePath: string): RuntimeProjection {
  return {
    environment: {
      environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000401"),
      label: "decider",
      protocolVersion: 1,
      capabilities: {},
    },
    projects: [],
    worktrees: [
      {
        worktreeId,
        projectId: ProjectId.parse("00000000-0000-4000-8000-000000000403"),
        path: worktreePath,
        branch: "main",
        status: "ready",
      },
    ],
    threads: [],
    terminals: [],
    browserTabs: [],
    attention: [],
    lastSequence: 0,
  };
}

function terminalCreate(cwd: string): RuntimeCommand {
  return {
    type: "terminal.create",
    terminalId,
    worktreeId,
    cwd,
    shell: "bash",
    title: "shell",
    cols: 80,
    rows: 24,
  };
}

describe("thread cwd", () => {
  const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000405");

  it("binds the session to the selected worktree path", () => {
    expect(
      decide(projection("/repo/tree"), {
        type: "thread.start",
        threadId,
        worktreeId,
        provider: "claude-code",
        cwd: "/tmp/elsewhere",
      }),
    ).toMatchObject([
      {
        type: "thread.start.requested",
        cwd: "/repo/tree",
        thread: { threadId, worktreeId, provider: "claude-code", status: "starting" },
      },
    ]);
    expect(
      decide(projection("C:/Work/Tree"), {
        type: "thread.start",
        threadId,
        worktreeId,
        provider: "cursor-agent",
        cwd: "C:/Work/Tree",
      }),
    ).toMatchObject([{ type: "thread.start.requested", cwd: "C:/Work/Tree", thread: { provider: "cursor-agent" } }]);
  });
});

describe("one live agent per worktree", () => {
  const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000403");
  const occupiedId = worktreeId;
  const freeId = WorktreeId.parse("00000000-0000-4000-8000-000000000406");
  const liveThread = ThreadId.parse("00000000-0000-4000-8000-000000000407");
  const legacyPeer = ThreadId.parse("00000000-0000-4000-8000-000000000408");
  const nextThread = ThreadId.parse("00000000-0000-4000-8000-000000000409");

  function occupiedProjection(status: "idle" | "stopped" | "failed" = "idle"): RuntimeProjection {
    const base = projection("/repo/occupied");
    return {
      ...base,
      projects: [{ projectId, path: "/repo", name: "repo" }],
      worktrees: [
        {
          worktreeId: occupiedId,
          projectId,
          path: "/repo/occupied",
          branch: "occupied",
          status: "ready",
        },
        {
          worktreeId: freeId,
          projectId,
          path: "/repo/free",
          branch: "free",
          status: "ready",
        },
      ],
      threads: [
        {
          threadId: liveThread,
          worktreeId: occupiedId,
          provider: "codex",
          status,
          capabilities: {},
        },
      ],
    };
  }

  function start(target: typeof occupiedId, shareWorktree?: boolean): RuntimeCommand {
    return {
      type: "thread.start",
      threadId: nextThread,
      worktreeId: target,
      provider: "claude-code",
      cwd: "/tmp/ignored",
      ...(shareWorktree ? { shareWorktree: true } : {}),
    };
  }

  it("rejects a new bind onto a live worktree unless sharing is confirmed", () => {
    expect(() => decide(occupiedProjection(), start(occupiedId))).toThrowError(
      expect.objectContaining({ code: "worktree_occupied" }),
    );
    const [decision] = decide(occupiedProjection(), start(occupiedId, true));
    expect(decision).toMatchObject({
      type: "thread.start.requested",
      shareWorktree: true,
      cwd: "/repo/occupied",
      thread: { threadId: nextThread, worktreeId: occupiedId, provider: "claude-code", status: "starting" },
    });
  });

  it("allows a new bind on a free worktree and on a worktree whose agent has stopped or failed", () => {
    expect(decide(occupiedProjection(), start(freeId))[0]).toMatchObject({
      type: "thread.start.requested",
      cwd: "/repo/free",
      thread: { worktreeId: freeId },
    });
    expect(decide(occupiedProjection(), start(freeId))[0]).not.toHaveProperty("shareWorktree");
    expect(decide(occupiedProjection("stopped"), start(occupiedId))[0]).toMatchObject({
      thread: { worktreeId: occupiedId },
    });
    expect(decide(occupiedProjection("failed"), start(occupiedId))[0]).not.toHaveProperty("shareWorktree");
  });

  it("keeps a legacy shared pair and records a confirmed third bind on the project card", () => {
    const legacy = occupiedProjection();
    legacy.threads = [
      ...legacy.threads,
      {
        threadId: legacyPeer,
        worktreeId: occupiedId,
        provider: "cursor-agent",
        status: "working",
        capabilities: {},
      },
    ];
    expect(legacy.threads.map((thread) => thread.worktreeId)).toEqual([occupiedId, occupiedId]);
    expect(() => decide(legacy, start(occupiedId))).toThrow(DomainError);

    const [decision] = decide(legacy, start(occupiedId, true));
    if (!decision) throw new Error("Expected a start decision.");
    const next = projectEvent(legacy, envelope(decision));
    const card = next.projectContexts?.find((context) => context.projectId === projectId);
    expect(card?.threads.map((thread) => thread.worktreeId)).toEqual([occupiedId, occupiedId, occupiedId]);
    expect(card?.threads.map((thread) => thread.threadId)).toEqual([liveThread, legacyPeer, nextThread]);
    expect(legacy.threads).toHaveLength(2);
  });

  it("shows a default bind on the free worktree in shared project context", () => {
    const current = occupiedProjection();
    const [decision] = decide(current, start(freeId));
    if (!decision) throw new Error("Expected a start decision.");
    const card = projectEvent(current, envelope(decision)).projectContexts?.find(
      (context) => context.projectId === projectId,
    );
    expect(card?.threads).toEqual([
      { threadId: liveThread, worktreeId: occupiedId, provider: "codex", status: "idle" },
      { threadId: nextThread, worktreeId: freeId, provider: "claude-code", status: "starting" },
    ]);
  });
});

function envelope(event: RuntimeEvent): RuntimeEventEnvelope {
  return {
    protocolVersion: 1,
    sequence: 1,
    eventId: EventId.parse("00000000-0000-4000-8000-000000000410"),
    occurredAt: "2026-09-23T12:00:00.000Z",
    event,
  };
}

describe("terminal cwd", () => {
  it("pins a terminal to the worktree root and its subdirectories", () => {
    expect(decide(projection("/repo/tree"), terminalCreate("/repo/tree"))).toMatchObject([
      { type: "terminal.create.requested", cwd: "/repo/tree" },
    ]);
    expect(decide(projection("/repo/tree"), terminalCreate("src/pkg"))).toMatchObject([
      { type: "terminal.create.requested", cwd: "/repo/tree/src/pkg" },
    ]);
    expect(decide(projection("C:/Work/Tree"), terminalCreate("src"))).toMatchObject([
      { type: "terminal.create.requested", cwd: "C:\\Work\\Tree\\src" },
    ]);
  });

  it("rejects cwd values that leave the worktree", () => {
    expect(() => decide(projection("/repo/tree"), terminalCreate("/etc/passwd"))).toThrowError(DomainError);
    expect(() => decide(projection("/repo/tree"), terminalCreate("../outside"))).toThrow(DomainError);
    expect(() => decide(projection("/repo/tree"), terminalCreate("/repo/tree-evil"))).toThrowError(
      expect.objectContaining({ code: "terminal_cwd_rejected" }),
    );
    expect(() => decide(projection("C:/Work/Tree"), terminalCreate("C:../Outside"))).toThrowError(
      expect.objectContaining({ code: "terminal_cwd_rejected" }),
    );
  });
});

describe("project archive", () => {
  const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000403");
  const otherProject = ProjectId.parse("00000000-0000-4000-8000-000000000420");
  const otherWorktree = WorktreeId.parse("00000000-0000-4000-8000-000000000421");

  function withProjects(): RuntimeProjection {
    const base = projection("/repo/tree");
    return {
      ...base,
      projects: [
        { projectId, path: "/repo", name: "repo" },
        { projectId: otherProject, path: "/other", name: "other" },
      ],
      worktrees: [
        ...base.worktrees,
        { worktreeId: otherWorktree, projectId: otherProject, path: "/other", branch: "main", status: "ready" },
      ],
    };
  }

  it("forgets the project's worktrees, then the project, and leaves other projects alone", () => {
    expect(decide(withProjects(), { type: "project.archive", projectId })).toEqual([
      { type: "worktree.archived", worktreeId },
      { type: "project.archived", projectId },
    ]);
  });

  it("rejects while an agent, a terminal, or a worktree setup is still running there", () => {
    const base = withProjects();
    const running: RuntimeProjection = {
      ...base,
      terminals: [{ terminalId, worktreeId, title: "shell", status: "running", lastSequence: 0 }],
    };
    const working: RuntimeProjection = {
      ...base,
      threads: [
        {
          threadId: ThreadId.parse("00000000-0000-4000-8000-000000000422"),
          worktreeId,
          provider: "codex",
          status: "idle",
          capabilities: {},
        },
      ],
    };
    const creating: RuntimeProjection = {
      ...base,
      worktrees: base.worktrees.map((worktree) => ({ ...worktree, status: "creating" as const })),
    };
    for (const state of [running, working, creating]) {
      expect(() => decide(state, { type: "project.archive", projectId })).toThrowError(
        expect.objectContaining({ code: "unsupported_command" }),
      );
    }
    const stopped: RuntimeProjection = {
      ...running,
      terminals: [{ terminalId, worktreeId, title: "shell", status: "exited", lastSequence: 0 }],
    };
    expect(decide(stopped, { type: "project.archive", projectId }).at(-1)).toEqual({
      type: "project.archived",
      projectId,
    });
  });
});
describe("session delete", () => {
  const sessionId = SessionId.parse("00000000-0000-4000-8000-000000000410");
  const agentTerminal = TerminalId.parse("00000000-0000-4000-8000-000000000411");
  const drawerShell = TerminalId.parse("00000000-0000-4000-8000-000000000412");
  const otherShell = TerminalId.parse("00000000-0000-4000-8000-000000000416");
  const chatThread = ThreadId.parse("00000000-0000-4000-8000-000000000413");
  const legacyThread = ThreadId.parse("00000000-0000-4000-8000-000000000414");

  function populated(): RuntimeProjection {
    const base = projection("/repo/tree");
    return {
      ...base,
      terminals: [
        {
          terminalId: agentTerminal,
          worktreeId,
          title: "Cursor",
          status: "exited",
          lastSequence: 3,
          kind: "agent",
          agent: { provider: "cursor-agent" },
          sessionId,
        },
        { terminalId: drawerShell, worktreeId, title: "shell", status: "running", lastSequence: 0, sessionId },
        { terminalId: otherShell, worktreeId, title: "shell", status: "running", lastSequence: 0 },
      ],
      threads: [
        { threadId: chatThread, worktreeId, provider: "cursor-agent", status: "idle", capabilities: {}, sessionId },
        { threadId: legacyThread, worktreeId, provider: "codex", status: "stopped", capabilities: {} },
      ],
      messages: [
        { messageId: "m1", threadId: chatThread, role: "user", text: "hi" },
        { messageId: "m2", threadId: legacyThread, role: "user", text: "old" },
      ],
      activities: [{ activityId: "a1", threadId: chatThread, kind: "command", title: "npm test", status: "completed" }],
      requests: [{ requestId: "r1", threadId: chatThread, kind: "approval", payload: {} }],
      attention: [{ id: "thread-request:r1", kind: "approval", title: "Agent approval required" }],
    };
  }

  function apply(state: RuntimeProjection, event: RuntimeEvent): RuntimeProjection {
    const envelope: RuntimeEventEnvelope = {
      protocolVersion: 1,
      sequence: state.lastSequence + 1,
      eventId: EventId.parse("00000000-0000-4000-8000-000000000415"),
      occurredAt: "2026-10-20T10:00:00.000Z",
      event,
    };
    return projectEvent(state, envelope);
  }

  it("removes the session's terminals, threads, and their history, and nothing else", () => {
    const state = populated();
    const decisions = decide(state, { type: "session.delete", sessionId });
    expect(decisions).toEqual([
      { type: "session.deleted", sessionId, terminalIds: [agentTerminal, drawerShell], threadIds: [chatThread] },
    ]);
    const next = apply(state, decisions[0] as RuntimeEvent);
    expect(next.terminals.map((terminal) => terminal.terminalId)).toEqual([otherShell]);
    expect(next.threads.map((thread) => thread.threadId)).toEqual([legacyThread]);
    expect(next.messages?.map((message) => message.messageId)).toEqual(["m2"]);
    expect(next.activities).toEqual([]);
    expect(next.requests).toEqual([]);
    expect(next.attention).toEqual([]);
  });

  it("treats a record from before sessions existed as its own session", () => {
    expect(decide(populated(), { type: "session.delete", sessionId: SessionId.parse(legacyThread) })).toEqual([
      { type: "session.deleted", sessionId: legacyThread, terminalIds: [], threadIds: [legacyThread] },
    ]);
  });

  it("rejects an unknown session", () => {
    expect(() =>
      decide(populated(), {
        type: "session.delete",
        sessionId: SessionId.parse("00000000-0000-4000-8000-000000000499"),
      }),
    ).toThrowError(expect.objectContaining({ code: "session_missing" }));
  });
});

describe("permission mode changes", () => {
  const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000420");

  function withThread(permissionSwitch?: "in-session" | "unsupported"): RuntimeProjection {
    return {
      ...projection("/work/tree"),
      threads: [
        {
          threadId,
          worktreeId,
          provider: "droid",
          status: "idle",
          permissionMode: "full-access",
          capabilities: permissionSwitch ? { permissionSwitch } : {},
        },
      ],
    };
  }

  function send(permissionMode?: "full-access" | "supervised"): RuntimeCommand {
    return { type: "thread.send", threadId, text: "next", ...(permissionMode ? { permissionMode } : {}) };
  }

  it("records a new mode for providers that can switch, and the projection follows it", () => {
    const state = withThread("in-session");
    const events = decide(state, send("supervised"));
    expect(events).toEqual([{ type: "thread.send.requested", threadId, text: "next", permissionMode: "supervised" }]);
    const [first] = events;
    if (!first) throw new Error("expected an event");
    expect(projectEvent(state, envelope(first)).threads[0]?.permissionMode).toBe("supervised");
  });

  it("drops an unchanged mode and rejects a change the provider cannot make", () => {
    expect(decide(withThread("unsupported"), send("full-access"))).toEqual([
      { type: "thread.send.requested", threadId, text: "next" },
    ]);
    expect(() => decide(withThread("unsupported"), send("supervised"))).toThrow(DomainError);
    expect(() => decide(withThread(), send("supervised"))).toThrow(/keeps its permission mode/u);
  });
});

describe("queued messages", () => {
  const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000430");
  const turnId = "00000000-0000-4000-8000-000000000431";

  function withThread(status: "idle" | "working" | "waiting" | "stopped"): RuntimeProjection {
    return {
      ...projection("/work/tree"),
      threads: [{ threadId, worktreeId, provider: "codex", status, activeTurnId: turnId, capabilities: {} }],
    } as RuntimeProjection;
  }

  function next(state: RuntimeProjection, event: RuntimeEvent): RuntimeProjection {
    return projectEvent(state, { ...envelope(event), sequence: state.lastSequence + 1 });
  }

  function apply(state: RuntimeProjection, command: RuntimeCommand): RuntimeProjection {
    return decide(state, command).reduce(next, state);
  }

  const queue = (queueId: string, text = queueId): RuntimeCommand => ({
    type: "thread.queue",
    queueId,
    threadId,
    text,
  });

  it("sends at once to an idle agent and marks it working so the next message waits", () => {
    const state = withThread("idle");
    expect(decide(state, queue("q1", "first"))).toEqual([{ type: "thread.send.requested", threadId, text: "first" }]);
    const next = apply(state, queue("q1", "first"));
    expect(next.threads[0]?.status).toBe("working");
    expect(decide(next, queue("q2", "second"))).toEqual([
      { type: "thread.queued", message: { queueId: "q2", threadId, text: "second" } },
    ]);
  });

  it("holds messages while the agent works and sends the oldest when it goes idle", () => {
    let state = apply(apply(withThread("working"), queue("q1")), queue("q2"));
    expect(state.queuedMessages?.map((entry) => entry.queueId)).toEqual(["q1", "q2"]);
    expect(decide(state, queue("q1"))).toEqual([]);
    expect(decide(state, { type: "thread.queue.flush", threadId })).toEqual([]);

    state = apply(state, { type: "thread.status", threadId, status: "idle" });
    expect(decide(state, { type: "thread.queue.flush", threadId })).toEqual([
      { type: "thread.queue.removed", threadId, queueId: "q1" },
      { type: "thread.send.requested", threadId, text: "q1" },
    ]);
    state = apply(state, { type: "thread.queue.flush", threadId });
    expect(state.queuedMessages?.map((entry) => entry.queueId)).toEqual(["q2"]);
    expect(state.threads[0]?.status).toBe("working");
  });

  it("removes a queued message, and does nothing for one already gone", () => {
    const state = apply(withThread("working"), queue("q1"));
    const removed = apply(state, { type: "thread.queue.remove", threadId, queueId: "q1" });
    expect(removed.queuedMessages).toEqual([]);
    expect(decide(removed, { type: "thread.queue.remove", threadId, queueId: "q1" })).toEqual([]);
  });

  it("steers by moving a message to the front and interrupting the current turn", () => {
    const state = apply(apply(withThread("working"), queue("q1")), queue("q2"));
    expect(decide(state, { type: "thread.steer", threadId, queueId: "q2" })).toEqual([
      { type: "thread.queue.prioritized", threadId, queueId: "q2" },
      { type: "thread.interrupt.requested", threadId, turnId },
    ]);
    const steered = apply(state, { type: "thread.steer", threadId, queueId: "q2" });
    expect(steered.queuedMessages?.map((entry) => entry.queueId)).toEqual(["q2", "q1"]);
  });

  it("steers an idle agent by sending the message straight away", () => {
    const working = apply(withThread("working"), queue("q1"));
    const idle = apply(working, { type: "thread.status", threadId, status: "idle" });
    expect(decide(idle, { type: "thread.steer", threadId, queueId: "q1" })).toEqual([
      { type: "thread.queue.removed", threadId, queueId: "q1" },
      { type: "thread.send.requested", threadId, text: "q1" },
    ]);
  });

  it("will not steer past an open request or a message that is gone", () => {
    const waiting = apply(apply(withThread("waiting"), queue("q1")), {
      type: "thread.request",
      request: { requestId: "r1", threadId, kind: "approval", payload: {} },
    });
    expect(decide(waiting, { type: "thread.queue.flush", threadId })).toEqual([]);
    expect(() => decide(waiting, { type: "thread.steer", threadId, queueId: "q1" })).toThrow(/Answer the agent/u);
    expect(() => decide(waiting, { type: "thread.steer", threadId, queueId: "q9" })).toThrow(/no longer queued/u);
  });

  it("rejects messages for an ended agent, past the queue limit, or with a mode the agent cannot take", () => {
    expect(() => decide(withThread("stopped"), queue("q1"))).toThrow(/has ended/u);
    let state = withThread("working");
    for (let index = 0; index < 20; index += 1) state = apply(state, queue(`q${index}`));
    expect(() => decide(state, queue("q20"))).toThrow(/up to 20/u);
    expect(() =>
      decide(withThread("working"), {
        type: "thread.queue",
        queueId: "q1",
        threadId,
        text: "x",
        permissionMode: "supervised",
      }),
    ).toThrow(/keeps its permission mode/u);
  });

  it("drops the queue with the session", () => {
    const state = apply(withThread("working"), queue("q1"));
    const sessionId = SessionId.parse("00000000-0000-4000-8000-000000000432");
    const deleted = next(state, { type: "session.deleted", sessionId, terminalIds: [], threadIds: [threadId] });
    expect(deleted.queuedMessages).toEqual([]);
  });
});

describe("turn usage", () => {
  const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000440");

  function withThread(): RuntimeProjection {
    return {
      ...projection("/work/tree"),
      threads: [{ threadId, worktreeId, provider: "claude-code", status: "working", capabilities: {}, model: "opus" }],
    } as RuntimeProjection;
  }

  function apply(state: RuntimeProjection, command: RuntimeCommand): RuntimeProjection {
    return decide(state, command).reduce(
      (current, event) => projectEvent(current, { ...envelope(event), sequence: current.lastSequence + 1 }),
      state,
    );
  }

  const usage = (outputTokens: number): RuntimeCommand => ({
    type: "thread.usage",
    threadId,
    turnId: "turn-1",
    usage: { inputTokens: 100, outputTokens },
  });

  it("records the thread's provider, project, and model, and replaces the turn's earlier report", () => {
    let state = apply(withThread(), usage(10));
    expect(decide(state, usage(10))).toEqual([]);
    state = apply(state, usage(25));
    expect(state.usage).toEqual([
      {
        usageId: `${threadId}:turn-1`,
        threadId,
        turnId: "turn-1",
        provider: "claude-code",
        projectId: "00000000-0000-4000-8000-000000000403",
        model: "opus",
        recordedAt: "2026-09-23T12:00:00.000Z",
        usage: { inputTokens: 100, outputTokens: 25 },
      },
    ]);
  });

  it("keeps usage after the session is deleted", () => {
    const state = apply(apply(withThread(), usage(10)), {
      type: "session.delete",
      sessionId: SessionId.parse(threadId),
    });
    expect(state.threads).toEqual([]);
    expect(state.usage).toHaveLength(1);
  });

  it("rejects usage for an unknown thread", () => {
    expect(() => decide(projection("/work/tree"), usage(10))).toThrow(DomainError);
  });
});

describe("projects without Git", () => {
  const projectId = ProjectId.parse("00000000-0000-4000-8000-000000000403");
  const plain = (git: boolean | undefined): RuntimeProjection => ({
    ...projection("/work/app"),
    worktrees: [],
    projects: [{ projectId, path: "/work/app", name: "app", ...(git === undefined ? {} : { git }) }],
  });
  const create: RuntimeCommand = {
    type: "worktree.create",
    worktreeId,
    projectId,
    path: "/work/app-worktrees/feature",
    workspaceRoot: "/work/app-worktrees",
    branch: "feature",
  };

  it("records whether the folder is a Git repository", () => {
    expect(decide(plain(undefined), { type: "project.git", projectId, git: false })).toEqual([
      { type: "project.git.changed", projectId, git: false },
    ]);
  });

  it("refuses a new worktree for a folder that is not a Git repository", () => {
    expect(() => decide(plain(false), create)).toThrow(/not a Git repository/u);
    expect(decide(plain(undefined), create)[0]?.type).toBe("worktree.create.requested");
  });
});
