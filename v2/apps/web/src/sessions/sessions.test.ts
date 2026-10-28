import type {
  RuntimeProjection,
  TerminalProjection,
  ThreadActivityProjection,
  ThreadMessageProjection,
  ThreadProjection,
} from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import {
  agentNameProblem,
  buildTimeline,
  changedFiles,
  deriveSessions,
  gridColumns,
  gridLayout,
  relativeTime,
  sessionAgentName,
  sessionChats,
  sessionParents,
  sessionRenameCommand,
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
    expect(session?.mode).toBe("chat");
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
    expect(session?.mode).toBe("terminal");
  });

  it("shows the one started last when an older session has both a terminal and a chat", () => {
    const laterTerminal = { ...agentTerminal, createdAt: "2026-01-01T11:00:00.000Z" };
    const [session] = deriveSessions({ terminals: [laterTerminal], threads: [thread] });
    expect(session?.mode).toBe("terminal");
    // The chat it no longer shows still counts, so a quit or update still warns while it works.
    expect(session?.status).toBe("working");
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

  it("splits a reply where each call started and puts later calls after it", () => {
    const at = (id: string, textOffset: number, kind: ThreadActivityProjection["kind"] = "file-read") => ({
      ...activity(id, "t1", kind, kind === "file-edit" ? ["a.ts"] : undefined),
      textOffset,
    });
    const messages = [
      { messageId: "m1", threadId, turnId: "t1", role: "user" as const, text: "fix it" },
      { messageId: "m2", threadId, turnId: "t1", role: "assistant" as const, text: "Reading. Editing. Done." },
    ] as RuntimeProjection["messages"] & object;
    const steps = [at("r1", 0), at("r2", 0), at("e1", 9, "file-edit"), at("c1", 23, "command")];
    const first = buildTimeline(messages, steps);
    const shape = (items: typeof first) =>
      items.map((item) =>
        item.kind === "work" ? `work:${item.activities.map((entry) => entry.activityId).join("+")}` : item.message.text,
      );
    expect(shape(first)).toEqual(["fix it", "work:r1+r2", "Reading. ", "work:e1", "Editing. Done.", "work:c1"]);
    const work = first.filter((item) => item.kind === "work");
    expect(work.map((item) => item.changedFiles)).toEqual([[], [], ["a.ts"]]);

    const longer = [messages[0], { ...messages[1], text: "Reading. Editing. Done. All good." }] as typeof messages;
    const second = buildTimeline(longer, steps, first);
    expect(shape(second)).toEqual([
      "fix it",
      "work:r1+r2",
      "Reading. ",
      "work:e1",
      "Editing. Done.",
      "work:c1",
      " All good.",
    ]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);
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
    expect(gridLayout(4, 1600)).toEqual({ columns: 2, rows: 2, tall: 0 });
    expect(gridLayout(2, 700)).toEqual({ columns: 1, rows: 2, tall: 0 });
    expect(gridLayout(9, 800)).toEqual({ columns: 2, rows: 5, tall: 1 });
    expect(gridLayout(3, undefined)).toEqual({ columns: 2, rows: 2, tall: 1 });
  });

  it("makes the first tiles span two rows so the grid has no empty cells", () => {
    const cells = (count: number) => {
      const { columns, rows, tall } = gridLayout(count, undefined);
      return { columns, rows, tall, filled: count + tall };
    };
    expect(cells(1)).toEqual({ columns: 1, rows: 1, tall: 0, filled: 1 });
    expect(cells(2)).toEqual({ columns: 2, rows: 1, tall: 0, filled: 2 });
    expect(cells(3)).toEqual({ columns: 2, rows: 2, tall: 1, filled: 4 });
    expect(cells(5)).toEqual({ columns: 3, rows: 2, tall: 1, filled: 6 });
    expect(cells(7)).toEqual({ columns: 3, rows: 3, tall: 2, filled: 9 });
    expect(cells(9)).toEqual({ columns: 3, rows: 3, tall: 0, filled: 9 });
    expect(cells(10)).toEqual({ columns: 4, rows: 3, tall: 2, filled: 12 });
    expect(cells(11)).toEqual({ columns: 4, rows: 3, tall: 1, filled: 12 });
    expect(cells(13)).toEqual({ columns: 4, rows: 4, tall: 3, filled: 16 });
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
        pending: [{ sessionId: "a", worktreeId, provider: "droid", mode: "chat" }],
        activeSessionId: "a",
        maximizedSessionId: "a",
      }),
    );
    const next = forgetSession(state, "a");
    expect(next.closed).toEqual(["b"]);
    expect(next.pending).toEqual([]);
    expect(next.activeSessionId).toBeUndefined();
    expect(next.maximizedSessionId).toBeUndefined();
  });

  it("drops malformed workbench state from storage", () => {
    const state = parseWorkbenchState(
      JSON.stringify({ closed: ["a", 3], pending: [{ sessionId: 1 }], drawerHeight: 20 }),
    );
    expect(state.closed).toEqual(["a"]);
    expect(state.pending).toEqual([]);
    expect(state.drawerHeight).toBe(280);
    expect(parseWorkbenchState("{not json").sidebarOpen).toBe(true);
  });
});

describe("chat history", () => {
  const older = {
    ...thread,
    threadId: "00000000-0000-4000-8000-000000000402",
    status: "stopped",
    createdAt: "2026-01-01T09:00:00.000Z",
    updatedAt: "2026-01-01T09:30:00.000Z",
  } as ThreadProjection;
  const messages = [
    { messageId: "m1", threadId: older.threadId, role: "user", text: "Fix the login form" },
    { messageId: "m2", threadId, role: "user", text: "Now add a test" },
  ] as never;

  it("keeps every chat in a session and shows the latest unless one was picked", () => {
    const [latest] = deriveSessions({ terminals: [], threads: [older, thread] });
    expect(latest?.threads?.map((entry) => entry.threadId)).toEqual([older.threadId, threadId]);
    expect(latest?.thread?.threadId).toBe(threadId);
    expect(latest?.status).toBe("working");
    const [picked] = deriveSessions({ terminals: [], threads: [older, thread] }, [], { [sessionId]: older.threadId });
    expect(picked?.thread?.threadId).toBe(older.threadId);
    expect(picked?.status).toBe("ended");
    const [missing] = deriveSessions({ terminals: [], threads: [older, thread] }, [], { [sessionId]: "gone" });
    expect(missing?.thread?.threadId).toBe(threadId);
  });

  it("lists chats newest first with their own titles and marks the one shown", () => {
    const [session] = deriveSessions({ terminals: [], threads: [older, thread] });
    if (!session) throw new Error("no session");
    expect(sessionChats(session, messages, [])).toEqual([
      { threadId, title: "Now add a test", updatedAt: thread.updatedAt, status: "working", current: true },
      {
        threadId: older.threadId,
        title: "Fix the login form",
        updatedAt: older.updatedAt,
        status: "stopped",
        current: false,
      },
    ]);
    expect(sessionChats(session, [], [])[0]?.title).toBe("New chat");
  });

  it("remembers the picked chat and forgets it with the session", () => {
    const state = parseWorkbenchState(JSON.stringify({ chats: { [sessionId]: older.threadId, other: 3 } }));
    expect(state.chats).toEqual({ [sessionId]: older.threadId });
    expect(forgetSession(state, sessionId).chats).toEqual({});
  });
});

describe("agent names", () => {
  const projectId = "00000000-0000-4000-8000-000000000021";
  const named = {
    worktrees: [{ worktreeId, projectId }],
    threads: [{ ...thread, name: "Bob" }],
    terminals: [{ ...agentTerminal, name: "John" }],
  } as unknown as Pick<RuntimeProjection, "worktrees" | "threads" | "terminals">;

  it("reads and renames the record the tile shows", () => {
    const [session] = deriveSessions(named);
    if (!session) throw new Error("no session");
    expect(session.mode).toBe("chat");
    expect(sessionAgentName(session)).toBe("Bob");
    expect(sessionRenameCommand(session, "Ann")).toEqual({ type: "thread.rename", threadId, name: "Ann" });
    const asTerminal = { ...session, mode: "terminal" as const };
    expect(sessionAgentName(asTerminal)).toBe("John");
    expect(sessionRenameCommand(asTerminal, null)).toEqual({
      type: "terminal.rename",
      terminalId: agentTerminal.terminalId,
      name: null,
    });
  });

  it("uses the pending name until the agent starts, and cannot rename it yet", () => {
    const pending = { sessionId, worktreeId, provider: "codex", mode: "chat" as const, name: "Ann", createdAt: "" };
    const [session] = deriveSessions({ threads: [], terminals: [] }, [pending]);
    if (!session) throw new Error("no session");
    expect(sessionAgentName(session)).toBe("Ann");
    expect(sessionRenameCommand(session, "Bob")).toBeUndefined();
  });

  it("explains a bad or taken name, and lets an agent keep its own", () => {
    const [session] = deriveSessions(named);
    expect(agentNameProblem(named, projectId, "   ")).toBeUndefined();
    expect(agentNameProblem(named, projectId, "-bob")).toMatch(/starting with a letter or digit/u);
    expect(agentNameProblem(named, projectId, "a/b")).toMatch(/^Use letters/u);
    expect(agentNameProblem(named, projectId, "bob")).toBe("Another agent in this project is already called bob.");
    expect(agentNameProblem(named, projectId, "BOB", session)).toBeUndefined();
    expect(agentNameProblem(named, "00000000-0000-4000-8000-000000000099", "Bob")).toBeUndefined();
  });
});

describe("sub-agents", () => {
  it("finds the session of the agent that started each sub-agent, even after it opened a new chat", () => {
    const child = "00000000-0000-4000-8000-000000000202";
    const grandchild = "00000000-0000-4000-8000-000000000203";
    const sessions = deriveSessions({
      terminals: [
        {
          ...agentTerminal,
          terminalId: "00000000-0000-4000-8000-000000000302",
          sessionId: grandchild,
          startedBy: "00000000-0000-4000-8000-000000000402",
        },
      ],
      threads: [
        thread,
        { ...thread, threadId: "00000000-0000-4000-8000-000000000409", createdAt: "2026-01-01T11:00:00.000Z" },
        {
          ...thread,
          threadId: "00000000-0000-4000-8000-000000000402",
          sessionId: child,
          startedBy: threadId,
        },
        {
          ...thread,
          threadId: "00000000-0000-4000-8000-000000000403",
          sessionId: "00000000-0000-4000-8000-000000000204",
          startedBy: "00000000-0000-4000-8000-000000000499",
        },
      ],
    } as unknown as Pick<RuntimeProjection, "terminals" | "threads">);
    const parents = sessionParents(sessions);
    expect(parents.get(child)?.sessionId).toBe(sessionId);
    expect(parents.get(grandchild)?.sessionId).toBe(child);
    expect(parents.has(sessionId)).toBe(false);
    expect(parents.has("00000000-0000-4000-8000-000000000204")).toBe(false);
  });

  it("titles a sub-agent by its task, not the line that says who started it", () => {
    const text =
      "Task from Lead, the agent in ZLI that started you, working on branch main. You are Helper in ZLI. Reply to Lead when you finish or get stuck:\n\nWrite the API docs";
    const message = { messageId: "m1", threadId, role: "user", text } as ThreadMessageProjection;
    const sub = { provider: "codex", thread: { ...thread, startedBy: "00000000-0000-4000-8000-000000000499" } };
    expect(sessionTitle(sub, [message], undefined)).toBe("Write the API docs");
    expect(sessionTitle({ provider: "codex", thread }, [message], undefined)).toMatch(/^Task from Lead/u);
  });

  it("titles a chat whose first message came from a huddle by that message", () => {
    const text =
      'Huddle "Login plan", message 1: The person running ZLI asks everyone:\n\nHow should we split the work?';
    const message = { messageId: "m1", threadId, role: "user", text } as ThreadMessageProjection;
    expect(sessionTitle({ provider: "codex", thread }, [message], undefined)).toBe("How should we split the work?");
  });
});
