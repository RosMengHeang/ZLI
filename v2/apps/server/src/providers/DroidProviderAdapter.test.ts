import { ThreadId } from "@zli-v2/contracts";
import type { DroidProviderEvent, DroidTranscriptTurn } from "@zli-v2/provider-droid";
import { DroidProviderError } from "@zli-v2/provider-droid";
import { describe, expect, it } from "vitest";

import { DroidProviderAdapter } from "./DroidProviderAdapter.js";
import { type ProviderEvent, ProviderRegistry, ProviderService } from "./ProviderService.js";

const PROTOCOL_MESSAGE = "Malformed Droid CLI message.";
const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000921");

class FakeClient {
  readonly calls: Array<{ method: string; value: unknown }> = [];
  private readonly listeners = new Set<(event: DroidProviderEvent) => void>();
  turns: DroidTranscriptTurn[] = [];

  async sendTurn(input: { text: string; model?: string }) {
    this.calls.push({ method: "turn", value: input });
    return { providerTurnId: "00000000-0000-4000-8000-000000000922" };
  }

  async interruptTurn(providerTurnId?: string) {
    this.calls.push({ method: "interrupt", value: providerTurnId });
  }

  transcript(): readonly DroidTranscriptTurn[] {
    return this.turns;
  }

  async close() {
    this.calls.push({ method: "close", value: undefined });
  }

  subscribe(listener: (event: DroidProviderEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: DroidProviderEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

describe("DroidProviderAdapter", () => {
  it("keeps capability flags honest and maps a live turn, including turn.started", async () => {
    const client = new FakeClient();
    const adapter = new DroidProviderAdapter({ createClient: async () => client });
    const events: ProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    expect(adapter.capabilities).toEqual({
      exactResume: false,
      structuredApproval: false,
      structuredUserInput: false,
      conversationRollback: false,
      modelSwitch: "in-session",
      permissionSwitch: "in-session",
    });
    await expect(adapter.startSession({ threadId, cwd: "/work/tree" })).resolves.toMatchObject({
      threadId,
      provider: "droid",
      cwd: "/work/tree",
      status: "idle",
    });
    await expect(adapter.sendTurn({ threadId, text: "hello" })).resolves.toEqual({
      turnId: "00000000-0000-4000-8000-000000000922",
    });
    client.emit({ type: "turn.started", providerTurnId: "00000000-0000-4000-8000-000000000922" });
    client.emit({
      type: "assistant.delta",
      providerTurnId: "00000000-0000-4000-8000-000000000922",
      text: "world",
    });
    client.emit({
      type: "turn.completed",
      providerTurnId: "00000000-0000-4000-8000-000000000922",
      status: "completed",
    });
    client.turns = [
      {
        providerTurnId: "00000000-0000-4000-8000-000000000922",
        text: "world",
        status: "completed",
        sessionId: "sess-1",
      },
    ];

    expect(events).toEqual([
      { type: "turn.started", threadId, turnId: "00000000-0000-4000-8000-000000000922" },
      { type: "assistant.delta", threadId, turnId: "00000000-0000-4000-8000-000000000922", text: "world" },
      {
        type: "turn.completed",
        threadId,
        turnId: "00000000-0000-4000-8000-000000000922",
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

  it("closes the CLI on stop, keeps protocol errors off the thread, and drops only a dead session", async () => {
    const client = new FakeClient();
    const adapter = new DroidProviderAdapter({ createClient: async () => client });
    await adapter.startSession({ threadId, cwd: "/work/tree" });
    await adapter.stopSession({ threadId });
    expect(client.calls.map((call) => call.method)).toEqual(["close"]);
    expect(adapter.hasSession({ threadId })).toBe(false);
    expect(adapter.listSessions()).toEqual([]);

    const dropped = new FakeClient();
    const live = new DroidProviderAdapter({ createClient: async () => dropped });
    const liveEvents: ProviderEvent[] = [];
    live.subscribe((event) => liveEvents.push(event));
    await live.startSession({ threadId, cwd: "/work/tree" });
    dropped.emit({ type: "protocol.error", message: PROTOCOL_MESSAGE });
    dropped.emit({
      type: "turn.failed",
      providerTurnId: "00000000-0000-4000-8000-000000000922",
      message: "Not logged in",
    });
    expect(live.hasSession({ threadId })).toBe(true);
    dropped.emit({ type: "session.closed", reason: "Droid CLI process closed." });
    expect(liveEvents).toEqual([
      { type: "provider.error", message: PROTOCOL_MESSAGE },
      { type: "provider.error", threadId, message: "Not logged in" },
      { type: "session.closed", threadId, reason: "Droid CLI process closed." },
    ]);
    expect(
      liveEvents.some(
        (event) => event.type === "provider.error" && event.message === PROTOCOL_MESSAGE && event.threadId === threadId,
      ),
    ).toBe(false);
    expect(live.hasSession({ threadId })).toBe(false);
    expect(live.listSessions()).toEqual([]);
    expect(dropped.calls.map((call) => call.method)).toEqual(["close"]);

    const missing = new DroidProviderAdapter({
      createClient: async () => {
        throw new DroidProviderError("cli_missing", "Droid CLI was not found on PATH or in known install locations.");
      },
    });
    const service = new ProviderService(new ProviderRegistry([missing]));
    await expect(service.startSession({ provider: "droid", threadId, cwd: "/work/tree" })).rejects.toMatchObject({
      code: "cli_missing",
      message: "Droid CLI was not found on PATH or in known install locations.",
    });
    expect(service.listSessions()).toEqual([]);
    await expect(service.rollbackThread({ threadId, numTurns: 1 })).rejects.toMatchObject({ code: "session_missing" });
  });

  it("hands a resumed id to the client and reports the id the CLI confirms", async () => {
    const client = new FakeClient();
    const starts: unknown[] = [];
    const adapter = new DroidProviderAdapter({
      createClient: async (input) => {
        starts.push(input);
        return client;
      },
    });
    const events: ProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    await expect(
      adapter.startSession({ threadId, cwd: "/work/tree", resumeSessionId: "sess-old" }),
    ).resolves.toMatchObject({ providerSessionId: "sess-old" });
    expect(starts).toEqual([{ cwd: "/work/tree", resumeSessionId: "sess-old" }]);

    client.emit({ type: "session.identified", sessionId: "sess-new" });
    expect(events).toEqual([{ type: "session.identified", threadId, providerSessionId: "sess-new" }]);
    expect(adapter.listSessions()[0]?.providerSessionId).toBe("sess-new");
  });

  it("starts without a provider session id and reports it once the first turn names it", async () => {
    const client = new FakeClient();
    const starts: unknown[] = [];
    const adapter = new DroidProviderAdapter({
      createClient: async (input) => {
        starts.push(input);
        return client;
      },
    });
    const events: ProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));

    const session = await adapter.startSession({ threadId, cwd: "/work/tree" });
    expect(session.providerSessionId).toBeUndefined();
    expect(starts).toEqual([{ cwd: "/work/tree" }]);
    client.emit({ type: "session.identified", sessionId: "sess-1" });
    expect(events).toEqual([{ type: "session.identified", threadId, providerSessionId: "sess-1" }]);
  });
});
