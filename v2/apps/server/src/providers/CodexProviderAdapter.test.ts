import { describe, expect, it } from "vitest";

import { ThreadId } from "@zli-v2/contracts";

import { CodexProviderAdapter } from "./CodexProviderAdapter.js";

const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000701");

class FakeClient {
  readonly calls: Array<{ method: string; value: unknown }> = [];
  private readonly listeners = new Set<(event: any) => void>();

  async startSession(input: { cwd: string }) {
    this.calls.push({ method: "start", value: input });
    return { providerThreadId: "codex-thread-1" };
  }
  async sendTurn(input: { providerThreadId: string; text: string }) {
    this.calls.push({ method: "turn", value: input });
    return { providerTurnId: "codex-turn-1" };
  }
  async interruptTurn(threadId: string, turnId: string) {
    this.calls.push({ method: "interrupt", value: { threadId, turnId } });
  }
  async respondToRequest(requestId: string, result: unknown) {
    this.calls.push({ method: "respond", value: { requestId, result } });
  }
  async readThread(providerThreadId: string) {
    this.calls.push({ method: "read", value: providerThreadId });
    return { providerThreadId, turns: ["turn"] };
  }
  async rollbackThread(providerThreadId: string, numTurns: number) {
    this.calls.push({ method: "rollback", value: { providerThreadId, numTurns } });
    return { providerThreadId, turns: [] };
  }
  async close() {
    this.calls.push({ method: "close", value: undefined });
  }
  subscribe(listener: (event: any) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: any) {
    for (const listener of this.listeners) listener(event);
  }
}

describe("CodexProviderAdapter", () => {
  it("maps provider-native identifiers and structured events into the neutral adapter", async () => {
    const client = new FakeClient();
    const adapter = new CodexProviderAdapter({ createClient: async () => client });
    const events: any[] = [];
    adapter.subscribe((event) => events.push(event));

    await expect(adapter.startSession({ threadId, cwd: "C:/workspace/tree" })).resolves.toMatchObject({
      threadId,
      provider: "codex",
    });
    await expect(adapter.sendTurn({ threadId, text: "hello" })).resolves.toEqual({ turnId: "codex-turn-1" });
    client.emit({
      type: "assistant.delta",
      providerThreadId: "codex-thread-1",
      providerTurnId: "codex-turn-1",
      text: "world",
    });
    client.emit({
      type: "approval.requested",
      requestId: "42",
      providerThreadId: "codex-thread-1",
      providerTurnId: "codex-turn-1",
      payload: { command: "git status" },
    });
    await adapter.respondToRequest({ threadId, requestId: "42", decision: { decision: "accept" } });

    expect(events).toEqual([
      { type: "assistant.delta", threadId, turnId: "codex-turn-1", text: "world" },
      { type: "approval.requested", threadId, requestId: "42", payload: { command: "git status" } },
    ]);
    expect(client.calls).toContainEqual({
      method: "respond",
      value: { requestId: "42", result: { decision: "accept" } },
    });
  });

  it("reports native thread reads and closes every Codex client on stop-all", async () => {
    const client = new FakeClient();
    const adapter = new CodexProviderAdapter({ createClient: async () => client });
    await adapter.startSession({ threadId, cwd: "C:/workspace/tree" });
    await expect(adapter.readThread({ threadId })).resolves.toEqual({ threadId, turns: ["turn"] });
    await adapter.stopAll();
    expect(client.calls.map((call) => call.method)).toEqual(["start", "read", "close"]);
  });
});
