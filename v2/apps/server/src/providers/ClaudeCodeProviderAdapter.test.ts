import { ThreadId } from "@zli-v2/contracts";
import type { ClaudeProviderEvent, ClaudeTranscriptTurn } from "@zli-v2/provider-claude-code";
import { ClaudeProviderError } from "@zli-v2/provider-claude-code";
import { describe, expect, it } from "vitest";

import { ClaudeCodeProviderAdapter } from "./ClaudeCodeProviderAdapter.js";
import { type ProviderEvent, ProviderRegistry, ProviderService } from "./ProviderService.js";

const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000811");

class FakeClient {
  readonly calls: Array<{ method: string; value: unknown }> = [];
  private readonly listeners = new Set<(event: ClaudeProviderEvent) => void>();
  turns: ClaudeTranscriptTurn[] = [];

  async sendTurn(input: { text: string; model?: string }) {
    this.calls.push({ method: "turn", value: input });
    return { providerTurnId: "00000000-0000-4000-8000-000000000812" };
  }

  async interruptTurn(providerTurnId?: string) {
    this.calls.push({ method: "interrupt", value: providerTurnId });
  }

  transcript(): readonly ClaudeTranscriptTurn[] {
    return this.turns;
  }

  async close() {
    this.calls.push({ method: "close", value: undefined });
  }

  subscribe(listener: (event: ClaudeProviderEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: ClaudeProviderEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

describe("ClaudeCodeProviderAdapter", () => {
  it("keeps capability flags narrower than Codex and maps a live turn", async () => {
    const client = new FakeClient();
    const adapter = new ClaudeCodeProviderAdapter({ createClient: async () => client });
    const events: ProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    expect(adapter.capabilities).toEqual({
      exactResume: false,
      structuredApproval: true,
      structuredUserInput: false,
      conversationRollback: false,
      modelSwitch: "in-session",
    });
    await expect(adapter.startSession({ threadId, cwd: "/work/tree" })).resolves.toMatchObject({
      threadId,
      provider: "claude-code",
      cwd: "/work/tree",
      status: "idle",
    });
    await expect(adapter.sendTurn({ threadId, text: "hello" })).resolves.toEqual({
      turnId: "00000000-0000-4000-8000-000000000812",
    });
    client.emit({ type: "turn.started", providerTurnId: "00000000-0000-4000-8000-000000000812" });
    client.emit({
      type: "assistant.delta",
      providerTurnId: "00000000-0000-4000-8000-000000000812",
      text: "world",
    });
    client.emit({
      type: "turn.completed",
      providerTurnId: "00000000-0000-4000-8000-000000000812",
      status: "completed",
    });
    client.turns = [
      {
        providerTurnId: "00000000-0000-4000-8000-000000000812",
        text: "world",
        status: "completed",
      },
    ];

    expect(events).toEqual([
      { type: "turn.started", threadId, turnId: "00000000-0000-4000-8000-000000000812" },
      { type: "assistant.delta", threadId, turnId: "00000000-0000-4000-8000-000000000812", text: "world" },
      {
        type: "turn.completed",
        threadId,
        turnId: "00000000-0000-4000-8000-000000000812",
        status: "completed",
      },
    ]);
    await expect(adapter.readThread({ threadId })).resolves.toEqual({ threadId, turns: client.turns });
    await expect(adapter.respondToRequest({ threadId, requestId: "1", decision: {} })).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(
      adapter.respondToUserInput({ threadId, requestId: "1", answers: { answer: "no" } }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(adapter.rollbackThread({ threadId, numTurns: 1 })).rejects.toMatchObject({ code: "unsupported" });
    expect(client.calls.map((call) => call.method)).toEqual(["turn"]);
  });

  it("closes the CLI process on stop and surfaces a missing CLI through the provider service", async () => {
    const client = new FakeClient();
    const adapter = new ClaudeCodeProviderAdapter({ createClient: async () => client });
    await adapter.startSession({ threadId, cwd: "/work/tree" });
    await adapter.stopSession({ threadId });
    expect(client.calls.map((call) => call.method)).toEqual(["close"]);
    expect(adapter.hasSession({ threadId })).toBe(false);
    expect(adapter.listSessions()).toEqual([]);

    const dropped = new FakeClient();
    const live = new ClaudeCodeProviderAdapter({ createClient: async () => dropped });
    const liveEvents: ProviderEvent[] = [];
    live.subscribe((event) => liveEvents.push(event));
    await live.startSession({ threadId, cwd: "/work/tree" });
    dropped.emit({
      type: "protocol.error",
      message: "Claude Code requested tool approval, which this adapter does not support.",
    });
    dropped.emit({ type: "session.closed", reason: "Claude Code process closed." });
    expect(liveEvents).toEqual([
      {
        type: "provider.error",
        message: "Claude Code requested tool approval, which this adapter does not support.",
      },
      { type: "session.closed", threadId, reason: "Claude Code process closed." },
    ]);
    expect(liveEvents.some((event) => event.type === "provider.error" && event.threadId === threadId)).toBe(false);
    expect(live.hasSession({ threadId })).toBe(false);
    expect(live.listSessions()).toEqual([]);
    expect(dropped.calls.map((call) => call.method)).toEqual(["close"]);

    const missing = new ClaudeCodeProviderAdapter({
      createClient: async () => {
        throw new ClaudeProviderError(
          "cli_missing",
          "Claude Code CLI was not found on PATH or in known install locations.",
        );
      },
    });
    const service = new ProviderService(new ProviderRegistry([missing]));
    await expect(service.startSession({ provider: "claude-code", threadId, cwd: "/work/tree" })).rejects.toMatchObject({
      code: "cli_missing",
      message: "Claude Code CLI was not found on PATH or in known install locations.",
    });
    expect(service.listSessions()).toEqual([]);
    await expect(service.rollbackThread({ threadId, numTurns: 1 })).rejects.toMatchObject({ code: "session_missing" });
  });
});

describe("ClaudeCodeProviderAdapter resume", () => {
  it("resumes the given conversation and reports its id", async () => {
    const client = Object.assign(new FakeClient(), { sessionId: "sess-old" });
    const starts: unknown[] = [];
    const adapter = new ClaudeCodeProviderAdapter({
      createClient: async (input) => {
        starts.push(input);
        return client;
      },
    });
    await expect(
      adapter.startSession({ threadId, cwd: "/work/tree", resumeSessionId: "sess-old" }),
    ).resolves.toMatchObject({ threadId, providerSessionId: "sess-old" });
    expect(starts).toEqual([{ cwd: "/work/tree", resumeSessionId: "sess-old" }]);
  });

  it("starts without a resume id for a new conversation", async () => {
    const client = Object.assign(new FakeClient(), { sessionId: "sess-new" });
    const starts: unknown[] = [];
    const adapter = new ClaudeCodeProviderAdapter({
      createClient: async (input) => {
        starts.push(input);
        return client;
      },
    });
    await expect(adapter.startSession({ threadId, cwd: "/work/tree" })).resolves.toMatchObject({
      providerSessionId: "sess-new",
    });
    expect(starts).toEqual([{ cwd: "/work/tree" }]);
  });

  it("emits session.identified when the CLI reports a new conversation id", async () => {
    const client = Object.assign(new FakeClient(), { sessionId: "sess-1" });
    const adapter = new ClaudeCodeProviderAdapter({ createClient: async () => client });
    const events: ProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.startSession({ threadId, cwd: "/work/tree" });
    client.emit({ type: "session.identified", sessionId: "sess-2" });
    expect(events).toEqual([{ type: "session.identified", threadId, providerSessionId: "sess-2" }]);
    expect(adapter.listSessions()).toMatchObject([{ threadId, providerSessionId: "sess-2" }]);
  });

  it("lets a failed resume surface as a start failure", async () => {
    const adapter = new ClaudeCodeProviderAdapter({
      createClient: async () => {
        throw new ClaudeProviderError(
          "request_failed",
          "Claude Code CLI exited before the session started: No conversation found with session ID: sess-gone",
        );
      },
    });
    const service = new ProviderService(new ProviderRegistry([adapter]));
    await expect(
      service.startSession({ provider: "claude-code", threadId, cwd: "/work/tree", resumeSessionId: "sess-gone" }),
    ).rejects.toMatchObject({ code: "request_failed" });
    expect(adapter.hasSession({ threadId })).toBe(false);
  });
});
