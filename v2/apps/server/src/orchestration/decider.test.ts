import {
  EnvironmentId,
  EventId,
  ProjectId,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeEventEnvelope,
  type RuntimeProjection,
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
