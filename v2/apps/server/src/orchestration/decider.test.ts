import {
  EnvironmentId,
  ProjectId,
  type RuntimeCommand,
  type RuntimeProjection,
  TerminalId,
  ThreadId,
  WorktreeId,
} from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { DomainError, decide } from "./decider.js";

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
