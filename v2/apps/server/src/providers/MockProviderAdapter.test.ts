import { ThreadId } from "@zli-v2/contracts";
import { describe, expect, it, vi } from "vitest";

import { MockProviderAdapter } from "./MockProviderAdapter.js";

describe("MockProviderAdapter", () => {
  it("emits a deterministic structured turn without an external provider", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new MockProviderAdapter();
      const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000001");
      const events: unknown[] = [];
      adapter.subscribe((event) => events.push(event));
      await adapter.startSession({ threadId, cwd: "C:/repo" });
      const result = await adapter.sendTurn({ threadId, text: "hello" });

      await vi.advanceTimersByTimeAsync(10);

      expect(result.turnId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(events).toEqual([
        { type: "turn.started", threadId, turnId: result.turnId },
        { type: "assistant.delta", threadId, turnId: result.turnId, text: "Mock response: hello" },
        { type: "turn.completed", threadId, turnId: result.turnId, status: "completed" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets the session before reporting a crash, and resumes the same conversation", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new MockProviderAdapter();
      const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000003");
      const closed: boolean[] = [];
      adapter.subscribe((event) => {
        if (event.type === "session.closed") closed.push(adapter.hasSession({ threadId }));
      });
      const conversation = (await adapter.startSession({ threadId, cwd: "C:/repo" })).providerSessionId ?? "";
      expect(conversation).toMatch(/^mock-/u);
      await adapter.sendTurn({ threadId, text: "[crash] go" });
      await vi.advanceTimersByTimeAsync(10);
      expect(closed).toEqual([false]);

      const resumed = await adapter.startSession({ threadId, cwd: "C:/repo", resumeSessionId: conversation });
      expect(resumed.providerSessionId).toBe(conversation);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes a turn paused on an approval once it is answered", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new MockProviderAdapter();
      const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000002");
      const events: Array<{ type: string; turnId?: string; requestId?: string }> = [];
      adapter.subscribe((event) => events.push(event));
      await adapter.startSession({ threadId, cwd: "C:/repo" });
      const result = await adapter.sendTurn({ threadId, text: "[approval] clean up" });
      await vi.advanceTimersByTimeAsync(10);
      const requestId = events[0]?.requestId ?? "";
      expect(events.map((event) => event.type)).toEqual(["approval.requested"]);

      await adapter.respondToRequest({ threadId, requestId, decision: { approved: true } });
      await vi.advanceTimersByTimeAsync(10);
      expect(events.at(-1)).toEqual({ type: "turn.completed", threadId, turnId: result.turnId, status: "completed" });
    } finally {
      vi.useRealTimers();
    }
  });
});
