import { RuntimeProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { agentAlerts, answeredAlertKeys, shouldShowAlert } from "./alerts.js";
import { ids, sampleProjection } from "./fixtures.js";

function withThread(
  projection: RuntimeProjection,
  threadId: string,
  patch: Partial<RuntimeProjection["threads"][number]>,
): RuntimeProjection {
  return {
    ...projection,
    threads: projection.threads.map((thread) => (thread.threadId === threadId ? { ...thread, ...patch } : thread)),
  };
}

describe("agentAlerts", () => {
  it("treats the first projection as the baseline", () => {
    expect(agentAlerts(undefined, sampleProjection())).toEqual([]);
  });

  it("announces a new approval with the agent's name and what it wants to run", () => {
    const before = { ...sampleProjection(), requests: [] };
    expect(agentAlerts(before, sampleProjection())).toEqual([
      {
        key: "request:r1",
        kind: "approval",
        threadId: ids.waiting,
        title: "Claude Code asks to continue",
        body: "Run a command: rm -rf build",
      },
    ]);
  });

  it("announces a question with its text", () => {
    const before = sampleProjection();
    const after = RuntimeProjection.parse({
      ...before,
      requests: [
        ...(before.requests ?? []),
        {
          requestId: "q1",
          threadId: ids.working,
          kind: "user-input",
          payload: {
            questions: [
              { id: "db", question: "Which database should the tests use?" },
              { id: "seed", question: "Seed it?" },
            ],
          },
        },
      ],
    });
    expect(agentAlerts(before, after)).toEqual([
      {
        key: "request:q1",
        kind: "question",
        threadId: ids.working,
        title: "Codex has a question",
        body: "Which database should the tests use? (2 questions)",
      },
    ]);
  });

  it("does not repeat a request it already announced", () => {
    expect(agentAlerts(sampleProjection(), sampleProjection())).toEqual([]);
  });

  it("announces a finished turn with the agent's last reply", () => {
    const before = sampleProjection();
    const after = withThread(before, ids.working, { status: "idle", name: "Login fix" });
    expect(agentAlerts(before, after)).toEqual([
      {
        key: `thread:${ids.working}`,
        kind: "finished",
        threadId: ids.working,
        title: "Login fix finished",
        body: "Looking at it. Running tests now",
      },
    ]);
  });

  it("stays quiet when a turn ends on a question, because the request says it", () => {
    const before = sampleProjection();
    const after = withThread(before, ids.waiting, { status: "working" });
    expect(agentAlerts(after, before)).toEqual([]);
  });

  it("announces a failure with the agent's error", () => {
    const before = sampleProjection();
    const after = withThread(before, ids.working, { status: "failed", errorMessage: "codex exited with code 1" });
    expect(agentAlerts(before, after)).toMatchObject([
      { kind: "failed", title: "Codex failed", body: "codex exited with code 1" },
    ]);
  });

  it("announces a stop with the branch, but not a stop right after a failure", () => {
    const before = sampleProjection();
    const stopped = withThread(before, ids.working, { status: "stopped" });
    expect(agentAlerts(before, stopped)).toMatchObject([
      { kind: "stopped", title: "Codex stopped", body: "On feature/login" },
    ]);
    const failed = withThread(before, ids.working, { status: "failed" });
    expect(agentAlerts(failed, withThread(failed, ids.working, { status: "stopped" }))).toEqual([]);
  });
});

describe("answeredAlertKeys", () => {
  it("lists requests that left the projection", () => {
    const answered = { ...sampleProjection(), requests: [] };
    expect(answeredAlertKeys(sampleProjection(), answered)).toEqual(["request:r1"]);
    expect(answeredAlertKeys(undefined, answered)).toEqual([]);
  });
});

describe("shouldShowAlert", () => {
  const alert = { key: "k", kind: "finished", threadId: ids.working, title: "t", body: "b" } as const;

  it("shows everything while the app is in the background", () => {
    expect(shouldShowAlert({ ...alert, kind: "stopped" }, { active: false, openThreadId: ids.working })).toBe(true);
  });

  it("skips the agent whose conversation is open, and stops while on screen", () => {
    expect(shouldShowAlert(alert, { active: true, openThreadId: ids.working })).toBe(false);
    expect(shouldShowAlert(alert, { active: true, openThreadId: ids.waiting })).toBe(true);
    expect(shouldShowAlert({ ...alert, kind: "stopped" }, { active: true, openThreadId: undefined })).toBe(false);
  });
});
