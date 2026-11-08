import { describe, expect, it } from "vitest";

import { type AlertProjection, alertState, detectAgentAlerts, waitingAgentCount } from "./agentAlerts.js";

const worktreeId = "00000000-0000-4000-8000-000000000101";

type ThreadInput = {
  threadId: string;
  status: string;
  name?: string;
  sessionId?: string;
  activeTurnId?: string;
  errorMessage?: string;
};
type TerminalInput = {
  terminalId: string;
  status: string;
  kind?: "agent" | "shell";
  title?: string;
  name?: string;
  errorMessage?: string;
};

function projection(
  input: {
    threads?: ThreadInput[];
    terminals?: TerminalInput[];
    requests?: {
      requestId: string;
      threadId: string;
      kind: "approval" | "user-input";
      payload?: Record<string, unknown>;
    }[];
  } = {},
): AlertProjection {
  return {
    worktrees: [{ worktreeId, projectId: "p", path: "/repo", branch: "feature-login", status: "ready" }],
    threads: (input.threads ?? []).map((thread) => ({
      worktreeId,
      provider: "codex",
      capabilities: {},
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...thread,
    })),
    terminals: (input.terminals ?? []).map((terminal) => ({
      worktreeId,
      title: "Claude Code",
      lastSequence: 0,
      kind: "agent",
      ...terminal,
    })),
    requests: (input.requests ?? []).map((request) => ({ payload: {}, ...request })),
    messages: [{ messageId: "m1", threadId: "t1", role: "user", text: "Fix the login form\nand add tests" }],
    providers: [{ provider: "codex", displayName: "Codex", status: "found", path: "/bin/codex" }],
  } as unknown as AlertProjection;
}

describe("agent alerts", () => {
  it("raises one alert when a chat turn finishes", () => {
    const before = alertState(projection({ threads: [{ threadId: "t1", status: "working", activeTurnId: "turn-1" }] }));
    const after = projection({
      threads: [{ threadId: "t1", status: "idle", activeTurnId: "turn-1", sessionId: "s1" }],
    });

    expect(detectAgentAlerts(before, after)).toEqual([
      {
        key: "thread:t1:finished:turn-1",
        kind: "finished",
        sessionId: "s1",
        title: "Codex finished",
        body: "Fix the login form · feature-login",
      },
    ]);
    expect(detectAgentAlerts(alertState(after), after)).toEqual([]);
  });

  it("stays silent for a session that becomes ready or for threads it has not seen before", () => {
    const before = alertState(projection({ threads: [{ threadId: "t1", status: "starting" }] }));
    const after = projection({
      threads: [
        { threadId: "t1", status: "idle" },
        { threadId: "t2", status: "failed", errorMessage: "old failure" },
      ],
    });
    expect(detectAgentAlerts(before, after)).toEqual([]);
  });

  it("alerts for new approval and input requests with the request summary", () => {
    const before = alertState(projection({ threads: [{ threadId: "t1", status: "working" }] }));
    const after = projection({
      threads: [{ threadId: "t1", status: "waiting" }],
      requests: [
        { requestId: "r1", threadId: "t1", kind: "approval", payload: { command: "rm -rf build" } },
        { requestId: "r2", threadId: "t1", kind: "user-input", payload: { title: "Which branch?" } },
      ],
    });
    const alerts = detectAgentAlerts(before, after);
    expect(alerts.map(({ key, kind, title, body }) => ({ key, kind, title, body }))).toEqual([
      { key: "request:r1", kind: "approval", title: "Codex needs approval", body: "rm -rf build · feature-login" },
      { key: "request:r2", kind: "user-input", title: "Codex needs input", body: "Which branch? · feature-login" },
    ]);
    expect(alerts.every((alert) => alert.sessionId === "t1")).toBe(true);
  });

  it("alerts when a chat thread or an agent terminal fails", () => {
    const before = alertState(
      projection({
        threads: [{ threadId: "t1", status: "working" }],
        terminals: [
          { terminalId: "a1", status: "running" },
          { terminalId: "sh1", status: "running", kind: "shell" },
        ],
      }),
    );
    const after = projection({
      threads: [{ threadId: "t1", status: "failed", errorMessage: "Provider exited with code 1" }],
      terminals: [
        { terminalId: "a1", status: "failed", errorMessage: "claude was not found" },
        { terminalId: "sh1", status: "failed" },
      ],
    });
    expect(
      detectAgentAlerts(before, after).map(({ kind, title, body, sessionId }) => ({ kind, title, body, sessionId })),
    ).toEqual([
      { kind: "failed", title: "Codex stopped with an error", body: "Provider exited with code 1", sessionId: "t1" },
      { kind: "failed", title: "Claude Code stopped with an error", body: "claude was not found", sessionId: "a1" },
    ]);
  });

  it("uses the name the person gave an agent", () => {
    const before = alertState(
      projection({
        threads: [{ threadId: "t1", status: "working", name: "Bob" }],
        terminals: [{ terminalId: "a1", status: "running", name: "John" }],
      }),
    );
    const after = projection({
      threads: [{ threadId: "t1", status: "waiting", name: "Bob" }],
      terminals: [{ terminalId: "a1", status: "failed", name: "John" }],
      requests: [{ requestId: "r1", threadId: "t1", kind: "approval", payload: { command: "npm publish" } }],
    });
    expect(detectAgentAlerts(before, after).map((alert) => alert.title)).toEqual([
      "Bob needs approval",
      "John stopped with an error",
    ]);
  });

  it("does not alert when the person stops an agent", () => {
    const before = alertState(
      projection({
        threads: [{ threadId: "t1", status: "working" }],
        terminals: [{ terminalId: "a1", status: "running" }],
      }),
    );
    const after = projection({
      threads: [{ threadId: "t1", status: "stopped" }],
      terminals: [{ terminalId: "a1", status: "exited" }],
    });
    expect(detectAgentAlerts(before, after)).toEqual([]);
  });

  it("counts agents with open requests once each", () => {
    expect(
      waitingAgentCount(
        projection({
          threads: [
            { threadId: "t1", status: "waiting" },
            { threadId: "t2", status: "waiting" },
          ],
          requests: [
            { requestId: "r1", threadId: "t1", kind: "approval" },
            { requestId: "r2", threadId: "t1", kind: "user-input" },
            { requestId: "r3", threadId: "t2", kind: "approval" },
            { requestId: "r4", threadId: "gone", kind: "approval" },
          ],
        }),
      ),
    ).toBe(2);
    expect(waitingAgentCount(projection())).toBe(0);
  });
});
