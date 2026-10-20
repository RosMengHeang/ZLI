import type {
  RuntimeProjection,
  TerminalProjection,
  ThreadActivityProjection,
  ThreadProjection,
} from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import {
  buildTimeline,
  changedFiles,
  deriveSessions,
  gridColumns,
  gridLayout,
  relativeTime,
  sessionStopCommands,
  sessionTitle,
} from "./sessions.js";
import { forgetSession, parseWorkbenchState } from "./workbench.js";

const worktreeId = "00000000-0000-4000-8000-000000000011";
const sessionId = "00000000-0000-4000-8000-000000000201";
const threadId = "00000000-0000-4000-8000-000000000401";

const agentTerminal = {
  terminalId: "00000000-0000-4000-8000-000000000301",
  worktreeId,
  title: "Cursor",
  status: "running",
  kind: "agent",
  agent: { provider: "cursor-agent" },
  sessionId,
  createdAt: "2026-01-01T10:00:00.000Z",
} as TerminalProjection;

const thread = {
  threadId,
  worktreeId,
  provider: "cursor-agent",
  status: "working",
  capabilities: {},
  sessionId,
  createdAt: "2026-01-01T10:05:00.000Z",
  updatedAt: "2026-01-01T10:06:00.000Z",
} as ThreadProjection;

const activity = (id: string, turnId: string, kind: ThreadActivityProjection["kind"], files?: string[]) =>
  ({
    activityId: id,
    threadId,
    turnId,
    kind,
    title: id,
    status: "completed",
    ...(files ? { files } : {}),
  }) as ThreadActivityProjection;

describe("deriveSessions", () => {
  it("joins an agent terminal and a chat thread that share a session", () => {
    const [session, ...rest] = deriveSessions({ terminals: [agentTerminal], threads: [thread] });
    expect(rest).toEqual([]);
    expect(session?.terminal?.terminalId).toBe(agentTerminal.terminalId);
    expect(session?.thread?.threadId).toBe(threadId);
    expect(session?.status).toBe("working");
    expect(session?.defaultMode).toBe("chat");
    expect(session?.createdAt).toBe("2026-01-01T10:00:00.000Z");
    expect(session?.updatedAt).toBe("2026-01-01T10:06:00.000Z");
  });

  it("ignores shell terminals and shows pending launches until they start", () => {
    const shell = {
      ...agentTerminal,
      terminalId: "00000000-0000-4000-8000-000000000302",
      kind: "shell",
      agent: undefined,
    };
    const pending = {
      sessionId: "00000000-0000-4000-8000-000000000209",
      worktreeId,
      provider: "droid",
      mode: "terminal" as const,
      createdAt: "2026-01-01T11:00:00.000Z",
    };
    const sessions = deriveSessions({ terminals: [shell as TerminalProjection], threads: [] }, [pending]);
    expect(sessions.map((session) => [session.sessionId, session.status])).toEqual([[pending.sessionId, "preparing"]]);
    const failed = deriveSessions({ terminals: [], threads: [] }, [{ ...pending, errorMessage: "No CLI" }]);
    expect(failed[0]?.status).toBe("failed");
  });

  it("reports ended when the CLI exits and no chat is live", () => {
    const [session] = deriveSessions({ terminals: [{ ...agentTerminal, status: "exited" }], threads: [] });
    expect(session?.status).toBe("ended");
    expect(session?.defaultMode).toBe("terminal");
  });
});

describe("timeline", () => {
  it("places each turn's work before its reply and keeps running work at the end", () => {
    const messages = [
      { messageId: "m1", threadId, turnId: "t1", role: "user" as const, text: "fix it" },
      { messageId: "m2", threadId, turnId: "t1", role: "assistant" as const, text: "done" },
      { messageId: "m3", threadId, turnId: "t2", role: "user" as const, text: "again" },
    ] as RuntimeProjection["messages"] & object;
    const items = buildTimeline(messages, [
      activity("read", "t1", "file-read", ["a.ts"]),
      activity("edit", "t1", "file-edit", ["a.ts", "b.ts"]),
      activity("run", "t2", "command"),
    ]);
    expect(items.map((item) => (item.kind === "work" ? `work:${item.turnId}` : item.message.messageId))).toEqual([
      "m1",
      "work:t1",
      "m2",
      "m3",
      "work:t2",
    ]);
    const work = items[1];
    expect(work?.kind === "work" ? work.changedFiles : []).toEqual(["a.ts", "b.ts"]);
  });

  it("reuses earlier items so only the streaming message and the growing work log change", () => {
    const user = { messageId: "m1", threadId, turnId: "t1", role: "user" as const, text: "fix it" };
    const read = activity("read", "t1", "file-read", ["a.ts"]);
    const first = buildTimeline([user] as never, [read]);
    const reply = { messageId: "m2", threadId, turnId: "t1", role: "assistant" as const, text: "do" };
    const second = buildTimeline([user, reply] as never, [read], first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    const third = buildTimeline(
      [user, { ...reply, text: "done" }] as never,
      [read, activity("edit", "t1", "file-edit", ["a.ts"])],
      second,
    );
    expect(third[0]).toBe(first[0]);
    expect(third[1]).not.toBe(second[1]);
    expect(third[2]).not.toBe(second[2]);
  });

  it("does not count failed edits as changed files", () => {
    expect(changedFiles([{ ...activity("edit", "t1", "file-edit", ["x.ts"]), status: "failed" }])).toEqual([]);
  });
});

describe("helpers", () => {
  it("titles a session with the first user message", () => {
    const messages = [{ messageId: "m1", threadId, role: "user" as const, text: "Add a login page\nwith tests" }];
    expect(sessionTitle({ thread, provider: "cursor-agent" }, messages as never, undefined)).toBe("Add a login page");
    expect(sessionTitle({ provider: "droid" }, [], undefined)).toBe("Droid");
  });

  it("formats compact relative times", () => {
    const now = Date.parse("2026-01-01T12:00:00.000Z");
    expect(relativeTime("2026-01-01T11:59:50.000Z", now)).toBe("now");
    expect(relativeTime("2026-01-01T11:55:00.000Z", now)).toBe("5m");
    expect(relativeTime("2026-01-01T09:00:00.000Z", now)).toBe("3h");
    expect(relativeTime(undefined, now)).toBe("");
  });

  it("chooses grid columns by tile count", () => {
    expect([1, 2, 4, 5, 9, 12].map(gridColumns)).toEqual([1, 2, 2, 3, 3, 4]);
  });

  it("stacks tiles into rows when the grid is too narrow for them side by side", () => {
    expect(gridLayout(4, 1600)).toEqual({ columns: 2, rows: 2 });
    expect(gridLayout(2, 700)).toEqual({ columns: 1, rows: 2 });
    expect(gridLayout(9, 800)).toEqual({ columns: 2, rows: 5 });
    expect(gridLayout(3, undefined)).toEqual({ columns: 2, rows: 2 });
  });

  it("stops both the agent CLI and the chat of a session", () => {
    const idleThread = { ...thread, status: "idle" } as ThreadProjection;
    expect(sessionStopCommands({ terminal: agentTerminal, thread: idleThread })).toEqual([
      { type: "terminal.stop", terminalId: agentTerminal.terminalId },
      { type: "thread.stop", threadId },
    ]);
    expect(
      sessionStopCommands({
        terminal: { ...agentTerminal, status: "exited" },
        thread: { ...thread, status: "stopped" } as ThreadProjection,
      }),
    ).toEqual([]);
    const [session] = deriveSessions({ terminals: [{ ...agentTerminal, status: "exited" }], threads: [idleThread] });
    expect(session?.status).toBe("ready");
  });

  it("forgets every layout trace of a deleted session", () => {
    const state = parseWorkbenchState(
      JSON.stringify({
        closed: ["a", "b"],
        modes: { a: "chat", b: "terminal" },
        pending: [{ sessionId: "a", worktreeId, provider: "droid", mode: "chat" }],
        activeSessionId: "a",
        maximizedSessionId: "a",
      }),
    );
    const next = forgetSession(state, "a");
    expect(next.closed).toEqual(["b"]);
    expect(next.modes).toEqual({ b: "terminal" });
    expect(next.pending).toEqual([]);
    expect(next.activeSessionId).toBeUndefined();
    expect(next.maximizedSessionId).toBeUndefined();
  });

  it("drops malformed workbench state from storage", () => {
    const state = parseWorkbenchState(
      JSON.stringify({ closed: ["a", 3], modes: { a: "chat", b: "x" }, pending: [{ sessionId: 1 }], drawerHeight: 20 }),
    );
    expect(state.closed).toEqual(["a"]);
    expect(state.modes).toEqual({ a: "chat" });
    expect(state.pending).toEqual([]);
    expect(state.drawerHeight).toBe(280);
    expect(parseWorkbenchState("{not json").sidebarOpen).toBe(true);
  });
});
