import type { RuntimeProjection, ThreadCheckpoint } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import {
  forkPointAfter,
  keepRunCleanup,
  parseRunGroups,
  planRuns,
  type RunGroup,
  resizeRuns,
  runPosition,
  runReplied,
  runState,
  runSummary,
  withoutRun,
} from "./bestOf.js";
import type { AgentSession } from "./sessions.js";

const group: RunGroup = {
  groupId: "g",
  sourceSessionId: "source",
  label: "fix-login",
  prompt: "Fix the login form",
  sessionIds: ["a", "b", "c"],
  createdAt: "2026-01-01T00:00:00.000Z",
};

function session(sessionId: string, worktreeId: string, status: AgentSession["status"] = "ready"): AgentSession {
  return { sessionId, worktreeId, provider: "codex", status, defaultMode: "chat" };
}

function checkpoint(id: string, turnId: string, files: string[], additions: number, deletions: number) {
  return {
    checkpointId: id,
    threadId: "t1",
    worktreeId: "w1",
    turnId,
    startTree: "a".repeat(40),
    endTree: "b".repeat(40),
    files: files.map((path) => ({ path, kind: "modified", additions: 1, deletions: 0, binary: false })),
    fileCount: files.length,
    additions,
    deletions,
  } as unknown as ThreadCheckpoint;
}

describe("planRuns", () => {
  it("names one branch per run after the chat's branch and keeps each run's agent", () => {
    const plan = planRuns(
      "fix-login",
      [{ provider: "codex" }, { provider: "claude-code", model: "claude-sonnet-4-5" }, { provider: "codex" }],
      ["main", "fix-login"],
    );
    expect(plan).toEqual([
      { index: 1, branch: "fix-login-run1", agent: { provider: "codex" } },
      { index: 2, branch: "fix-login-run2", agent: { provider: "claude-code", model: "claude-sonnet-4-5" } },
      { index: 3, branch: "fix-login-run3", agent: { provider: "codex" } },
    ]);
  });

  it("moves the whole set to a free prefix when a run branch is taken", () => {
    const plan = planRuns("main", [{ provider: "codex" }, { provider: "codex" }], ["main-run2", "main-2-run1"]);
    expect(plan.map((run) => run.branch)).toEqual(["main-3-run1", "main-3-run2"]);
  });

  it("cleans the branch name, names a detached checkout, and caps the count", () => {
    expect(
      planRuns(" feature/fix login ", [{ provider: "codex" }, { provider: "codex" }], []).map((run) => run.branch),
    ).toEqual(["feature/fix-login-run1", "feature/fix-login-run2"]);
    expect(planRuns("HEAD", [{ provider: "codex" }, { provider: "codex" }], [])[0]?.branch).toBe("best-of-run1");
    expect(
      planRuns(
        "x",
        Array.from({ length: 9 }, () => ({ provider: "codex" })),
        [],
      ),
    ).toHaveLength(4);
    expect(planRuns("x", [{ provider: "codex" }], [])).toHaveLength(2);
  });
});

describe("resizeRuns", () => {
  it("keeps picked agents and fills new rows with the current agent", () => {
    const picked = [{ provider: "claude-code" }, { provider: "codex" }];
    expect(resizeRuns(picked, 3, { provider: "droid" })).toEqual([...picked, { provider: "droid" }]);
    expect(resizeRuns(picked, 1, { provider: "droid" })).toEqual(picked);
  });
});

describe("run groups", () => {
  it("finds the position of a run", () => {
    expect(runPosition([group], "b")).toEqual({ group, index: 2, count: 3 });
    expect(runPosition([group], "source")).toBeUndefined();
  });

  it("drops a run and dissolves a group left with one", () => {
    expect(withoutRun([group], "a")).toEqual([{ ...group, sessionIds: ["b", "c"] }]);
    expect(withoutRun([{ ...group, sessionIds: ["a", "b"] }], "a")).toEqual([]);
    expect(withoutRun([group], "source")).toEqual([group]);
  });

  it("parses only well-formed groups", () => {
    expect(
      parseRunGroups([
        { ...group, notified: true },
        { ...group, groupId: "x", sessionIds: ["only"] },
        { groupId: 3 },
        { groupId: "old", label: "y", sessionIds: ["a", "b"] },
        null,
      ]),
    ).toEqual([{ ...group, notified: true }]);
    expect(parseRunGroups(undefined)).toEqual([]);
  });
});

describe("run state", () => {
  const messages = [
    { messageId: "1", threadId: "t1", role: "user", text: "Fix it" },
    { messageId: "2", threadId: "t1", role: "assistant", text: "Fixed" },
    { messageId: "3", threadId: "t2", role: "user", text: "Fix it" },
  ] as RuntimeProjection["messages"];

  it("counts a run as done only after it answered the first message", () => {
    expect(runReplied(messages, "t1")).toBe(true);
    expect(runReplied(messages, "t2")).toBe(false);
    expect(runState(session("a", "w", "ready"), true)).toBe("done");
    expect(runState(session("a", "w", "ready"), false)).toBe("running");
    expect(runState(session("a", "w", "working"), true)).toBe("running");
    expect(runState(session("a", "w", "ended"), false)).toBe("failed");
    expect(runState(session("a", "w", "failed"), true)).toBe("failed");
    expect(runState(undefined, false)).toBe("failed");
  });
});

describe("keepRunCleanup", () => {
  it("removes the other runs with their own worktrees and leaves the kept one and the source", () => {
    const projection = {
      worktrees: [
        { worktreeId: "wa", kind: "worktree", branch: "main-run1" },
        { worktreeId: "wb", kind: "worktree", branch: "main-run2" },
        { worktreeId: "wc", kind: "worktree", branch: "main-run3" },
        { worktreeId: "main", kind: "checkout", branch: "main" },
      ],
    } as unknown as Pick<RuntimeProjection, "worktrees">;
    const sessions = [session("source", "main"), session("a", "wa"), session("b", "wb"), session("c", "wc")];
    const cleanup = keepRunCleanup(projection, sessions, group, "b");
    expect(cleanup.map((entry) => [entry.session.sessionId, entry.worktree?.branch])).toEqual([
      ["a", "main-run1"],
      ["c", "main-run3"],
    ]);
  });

  it("keeps a worktree that a chat outside the group also uses", () => {
    const projection = {
      worktrees: [
        { worktreeId: "wa", kind: "worktree", branch: "main-run1" },
        { worktreeId: "wb", kind: "worktree", branch: "main-run2" },
      ],
    } as unknown as Pick<RuntimeProjection, "worktrees">;
    const sessions = [session("a", "wa"), session("b", "wb"), session("other", "wa")];
    const cleanup = keepRunCleanup(projection, sessions, { ...group, sessionIds: ["a", "b"] }, "b");
    expect(cleanup).toEqual([{ session: sessions[0], worktree: undefined }]);
  });
});

describe("runSummary", () => {
  it("adds up changed files, lines, cost, time, and checks for one run", () => {
    const projection = {
      threads: [
        {
          threadId: "t1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:02:30.000Z",
        },
      ],
      checkpoints: [checkpoint("c1", "turn-1", ["a.ts", "b.ts"], 10, 2), checkpoint("c2", "turn-2", ["a.ts"], 3, 1)],
      usage: [
        { threadId: "t1", usage: { costUsd: 0.25 } },
        { threadId: "t1", usage: { costUsd: 0.5 } },
        { threadId: "t2", usage: { costUsd: 9 } },
      ],
      activities: [
        { threadId: "t1", kind: "command", title: "pnpm test", status: "completed" },
        { threadId: "t1", kind: "command", title: "pnpm run lint", status: "failed" },
        { threadId: "t1", kind: "command", title: "ls", status: "completed" },
        { threadId: "t1", kind: "file-read", title: "Read test.ts", status: "completed" },
      ],
    } as unknown as Parameters<typeof runSummary>[0];
    expect(runSummary(projection, "t1")).toEqual({
      files: 2,
      additions: 13,
      deletions: 3,
      costUsd: 0.75,
      durationMs: 150_000,
      checks: { passed: 1, failed: 1 },
    });
    expect(runSummary(projection, "t9")).toEqual({ files: 0, additions: 0, deletions: 0 });
  });
});

describe("forkPointAfter", () => {
  it("picks the first saved turn at or after the message", () => {
    const early = checkpoint("c1", "turn-1", ["a.ts"], 1, 0);
    const late = checkpoint("c2", "turn-2", ["b.ts"], 1, 0);
    const placed = new Map([
      [2, [early]],
      [6, [late]],
    ]);
    expect(forkPointAfter(0, placed)).toBe(early);
    expect(forkPointAfter(3, placed)).toBe(late);
    expect(forkPointAfter(7, placed)).toBeUndefined();
  });
});
