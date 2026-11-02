import { RuntimeProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { ids, sampleProjection } from "./fixtures.js";
import { agentFromLink, agentLink, liveCommand, liveStatus } from "./liveStatus.js";

function withRequests(projection: RuntimeProjection, requests: unknown[]): RuntimeProjection {
  return RuntimeProjection.parse({ ...projection, requests });
}

describe("liveStatus", () => {
  it("features the agent asking for approval, with Approve and Reject", () => {
    expect(liveStatus(sampleProjection())).toEqual({
      threadId: ids.waiting,
      needsYou: true,
      agent: "Claude Code",
      state: "Asks to continue",
      detail: "Run a command: rm -rf build",
      badge: "Needs you",
      others: "Also 1 working",
      count: 2,
      actions: [
        { target: "respond/r1/approve", label: "Approve", kind: "approve" },
        { target: "respond/r1/reject", label: "Reject", kind: "reject" },
      ],
    });
  });

  it("shows what a working agent is doing when nobody needs you", () => {
    expect(liveStatus({ ...sampleProjection(), requests: [] })).toEqual({
      threadId: ids.working,
      needsYou: false,
      agent: "Codex",
      state: "Working",
      detail: "npm test",
      badge: "Working",
      others: undefined,
      count: 1,
      actions: [{ target: `stop/${ids.working}`, label: "Stop", kind: "stop" }],
    });
  });

  it("puts an approval ahead of an older question", () => {
    const projection = withRequests(sampleProjection(), [
      { requestId: "q1", threadId: ids.working, kind: "user-input", payload: { question: "Which port?" } },
      ...(sampleProjection().requests ?? []),
    ]);
    const status = liveStatus(projection);
    expect(status?.threadId).toBe(ids.waiting);
    expect(status?.others).toBe("Also 1 needs you");
    expect(status?.count).toBe(2);
  });

  it("offers Stop for a question, which needs typing on the phone", () => {
    const projection = withRequests(sampleProjection(), [
      { requestId: "q1", threadId: ids.working, kind: "user-input", payload: { question: "Which port?" } },
    ]);
    expect(liveStatus(projection)).toMatchObject({
      threadId: ids.working,
      state: "Has a question",
      detail: "Which port?",
      actions: [{ target: `stop/${ids.working}`, label: "Stop", kind: "stop" }],
    });
  });

  it("uses the provider's own approve and decline choices", () => {
    const projection = withRequests(sampleProjection(), [
      { requestId: "c1", threadId: ids.working, kind: "approval", payload: { command: ["npm", "publish"] } },
    ]);
    expect(liveStatus(projection)?.actions).toEqual([
      { target: "respond/c1/accept", label: "Approve", kind: "approve" },
      { target: "respond/c1/decline", label: "Decline", kind: "reject" },
    ]);
  });

  it("finds the refusal among ACP options", () => {
    const projection = withRequests(sampleProjection(), [
      {
        requestId: "a1",
        threadId: ids.waiting,
        kind: "approval",
        payload: {
          toolName: "Edit",
          options: [
            { optionId: "always", name: "Always allow", kind: "allow_always" },
            { optionId: "once", name: "Allow once", kind: "allow_once" },
            { optionId: "no", name: "Reject", kind: "reject_once" },
          ],
        },
      },
    ]);
    expect(liveStatus(projection)?.actions).toEqual([
      { target: "respond/a1/once", label: "Allow once", kind: "approve" },
      { target: "respond/a1/no", label: "Reject", kind: "reject" },
    ]);
  });

  it("counts a waiting agent as needing you", () => {
    const base = { ...sampleProjection(), requests: [] };
    const projection = {
      ...base,
      threads: base.threads.map((thread) =>
        thread.threadId === ids.waiting ? { ...thread, status: "waiting" as const } : thread,
      ),
    };
    expect(liveStatus(projection)).toMatchObject({
      threadId: ids.waiting,
      needsYou: true,
      state: "Needs you",
      detail: "On feature/login",
      others: "Also 1 working",
    });
  });

  it("features the busy agent that changed last and counts the rest", () => {
    const base = { ...sampleProjection(), requests: [] };
    const projection = {
      ...base,
      threads: base.threads.map((thread) =>
        thread.threadId === ids.waiting
          ? { ...thread, status: "starting" as const, updatedAt: "2026-01-02T00:00:00Z" }
          : { ...thread, updatedAt: "2026-01-01T00:00:00Z" },
      ),
    };
    expect(liveStatus(projection)).toMatchObject({
      threadId: ids.waiting,
      state: "Starting",
      badge: "2 working",
      others: "Also 1 working",
      count: 2,
    });
  });

  it("is empty when no agent works or waits", () => {
    const base = { ...sampleProjection(), requests: [] };
    const idle = {
      ...base,
      threads: base.threads.map((thread) =>
        thread.status === "working" ? { ...thread, status: "idle" as const } : thread,
      ),
    };
    expect(liveStatus(idle)).toBeUndefined();
    expect(liveStatus(undefined)).toBeUndefined();
  });
});

describe("liveCommand", () => {
  it("answers a request that is still open", () => {
    expect(liveCommand(sampleProjection(), "respond/r1/reject")).toEqual({
      type: "thread.respond",
      threadId: ids.waiting,
      requestId: "r1",
      decision: { approved: false },
    });
  });

  it("drops an answer to a request that is already gone", () => {
    expect(liveCommand({ ...sampleProjection(), requests: [] }, "respond/r1/approve")).toBeUndefined();
    expect(liveCommand(sampleProjection(), "respond/r1/missing")).toBeUndefined();
  });

  it("stops an agent that is still running", () => {
    expect(liveCommand(sampleProjection(), `stop/${ids.working}`)).toEqual({
      type: "thread.stop",
      threadId: ids.working,
    });
    expect(liveCommand(sampleProjection(), `stop/${ids.stopped}`)).toBeUndefined();
  });

  it("ignores targets it did not make", () => {
    expect(liveCommand(sampleProjection(), "__expo_widgets_target_0")).toBeUndefined();
    expect(liveCommand(sampleProjection(), "stop/%E0%A4%A")).toBeUndefined();
    expect(liveCommand(undefined, `stop/${ids.working}`)).toBeUndefined();
  });
});

describe("agentLink", () => {
  it("round-trips the agent id", () => {
    expect(agentLink(ids.working)).toBe(`zli-remote://agent/${ids.working}`);
    expect(agentFromLink(agentLink(ids.working))).toBe(ids.working);
  });

  it("ignores other links", () => {
    expect(agentFromLink("zli-remote://settings")).toBeUndefined();
    expect(agentFromLink("https://example.com/agent/1")).toBeUndefined();
    expect(agentFromLink(null)).toBeUndefined();
  });
});
