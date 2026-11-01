import type { RpcResponse, ThreadProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { sendToWorktreeAgent, worktreeChatAgent } from "./sendToAgent.js";

const thread = (threadId: string, status: ThreadProjection["status"], updatedAt: string, worktreeId = "wt-1") =>
  ({ threadId, worktreeId, status, updatedAt, createdAt: updatedAt }) as unknown as ThreadProjection;

function runtime(threads: ThreadProjection[], response: RpcResponse | undefined = { accepted: true } as RpcResponse) {
  const sent: { command: Record<string, unknown> }[] = [];
  return {
    sent,
    projection: { threads },
    dispatch: async (request: unknown) => {
      sent.push(request as { command: Record<string, unknown> });
      return response;
    },
  };
}

describe("sending to the worktree's agent", () => {
  it("picks the most recently active agent in the worktree that can take a message", () => {
    const threads = [
      thread("old", "idle", "2026-01-01T00:00:00.000Z"),
      thread("new", "working", "2026-01-02T00:00:00.000Z"),
      thread("ended", "exited" as ThreadProjection["status"], "2026-01-03T00:00:00.000Z"),
      thread("other", "idle", "2026-01-04T00:00:00.000Z", "wt-2"),
    ];
    expect(worktreeChatAgent({ threads }, "wt-1")?.threadId).toBe("new");
    expect(worktreeChatAgent({ threads }, "wt-3")).toBeUndefined();
  });

  it("sends to an idle agent, queues behind a busy one, and says when there is none", async () => {
    const idle = runtime([thread("t1", "idle", "2026-01-01T00:00:00.000Z")]);
    await expect(sendToWorktreeAgent(idle, "wt-1", "The app crashed.")).resolves.toBe(true);
    expect(idle.sent[0]?.command).toEqual({ type: "thread.send", threadId: "t1", text: "The app crashed." });

    const busy = runtime([thread("t1", "working", "2026-01-01T00:00:00.000Z")]);
    await sendToWorktreeAgent(busy, "wt-1", "The build failed.");
    expect(busy.sent[0]?.command).toMatchObject({ type: "thread.queue", threadId: "t1", text: "The build failed." });

    await expect(sendToWorktreeAgent(runtime([]), "wt-1", "Hello")).resolves.toBe(false);
  });

  it("throws with the runtime's reason when it refuses", async () => {
    const refused = runtime([thread("t1", "idle", "2026-01-01T00:00:00.000Z")], {
      accepted: false,
      error: { message: "The agent stopped." },
    } as RpcResponse);
    await expect(sendToWorktreeAgent(refused, "wt-1", "Hello")).rejects.toThrow("The agent stopped.");
  });
});
