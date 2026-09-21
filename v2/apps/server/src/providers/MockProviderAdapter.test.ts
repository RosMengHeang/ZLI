import { describe, expect, it, vi } from "vitest";

import { ThreadId } from "@zli-v2/contracts";

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
});
