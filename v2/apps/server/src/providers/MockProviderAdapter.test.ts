import { ThreadId } from "@zli-v2/contracts";
import { describe, expect, it, vi } from "vitest";

import { MockProviderAdapter } from "./MockProviderAdapter.js";
import type { ProviderEvent } from "./ProviderService.js";

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

  it("plays a showcase turn with thinking, every kind of step, sources, and a nearly full context", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new MockProviderAdapter();
      const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000004");
      const events: ProviderEvent[] = [];
      adapter.subscribe((event) => events.push(event));
      await adapter.startSession({ threadId, cwd: "C:/repo" });
      await adapter.sendTurn({ threadId, text: "[showcase]" });
      await vi.advanceTimersByTimeAsync(1_000);
      // Partway through, the thinking is still arriving and the turn has not ended.
      expect(events.some((event) => event.type === "reasoning.delta")).toBe(true);
      expect(events.some((event) => event.type === "turn.completed")).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(events[0]?.type).toBe("turn.started");
      expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "completed" });
      const deltas = events.filter((event) => event.type === "reasoning.delta");
      expect(deltas.length).toBeGreaterThanOrEqual(5);
      expect(events.filter((event) => event.type === "reasoning.completed")).toHaveLength(2);
      const finished = events.flatMap((event) =>
        event.type === "activity" && event.activity.status !== "running" ? [event.activity] : [],
      );
      expect(new Set(finished.map((activity) => activity.kind))).toEqual(
        new Set(["file-read", "search", "command", "tool", "web", "file-edit"]),
      );
      const build = finished.find((activity) => activity.command === "npm run build");
      expect(build?.detail?.split("\n").length).toBeGreaterThanOrEqual(35);
      expect(finished.find((activity) => activity.kind === "tool")?.input?.length).toBeGreaterThan(0);
      const pages = finished.find((activity) => activity.kind === "web")?.urls ?? [];
      expect(pages).toHaveLength(3);
      const failed = finished.find((activity) => activity.status === "failed");
      expect(failed?.detail).toContain("node_modules/");
      const reply = events.flatMap((event) => (event.type === "assistant.delta" ? [event.text] : [])).join("");
      expect(reply).toContain(`](${pages[0]?.url})`);
      const usage = events.find((event) => event.type === "usage");
      expect(
        usage?.type === "usage" && (usage.usage.contextTokens ?? 0) / (usage.usage.contextWindow ?? 1),
      ).toBeCloseTo(0.8, 1);
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
