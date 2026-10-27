import { ThreadId } from "@zli-v2/contracts";
import {
  type AcpPermissionAnswer,
  type AcpProviderEvent,
  AcpProviderError,
  type AcpTranscriptTurn,
} from "@zli-v2/provider-acp";
import { describe, expect, it } from "vitest";

import { AcpProviderAdapter, type AcpProviderConfig, acpActivity } from "./AcpProviderAdapter.js";
import { type ProviderEvent, ProviderRegistry, ProviderService } from "./ProviderService.js";

const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000931");
const turnId = "00000000-0000-4000-8000-000000000932";

const config: AcpProviderConfig = {
  provider: "opencode",
  displayName: "OpenCode",
  resolveCommand: async () => "/usr/bin/opencode",
  acpArgs: ["acp"],
  authHint: "Sign in to OpenCode in a terminal first (run `opencode auth login`).",
};

class FakeClient {
  readonly calls: Array<{ method: string; value: unknown }> = [];
  private readonly listeners = new Set<(event: AcpProviderEvent) => void>();
  turns: AcpTranscriptTurn[] = [];
  agentSessionId?: string;

  async sendTurn(input: unknown) {
    this.calls.push({ method: "turn", value: input });
    return { providerTurnId: turnId };
  }

  async interruptTurn(providerTurnId?: string) {
    this.calls.push({ method: "interrupt", value: providerTurnId });
  }

  async respondToPermission(requestId: string, answer: AcpPermissionAnswer) {
    this.calls.push({ method: "permission", value: { requestId, answer } });
  }

  transcript(): readonly AcpTranscriptTurn[] {
    return this.turns;
  }

  async close() {
    this.calls.push({ method: "close", value: undefined });
  }

  subscribe(listener: (event: AcpProviderEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AcpProviderEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

describe("AcpProviderAdapter", () => {
  it("reports its provider and capabilities and forwards session options", async () => {
    const client = new FakeClient();
    const starts: unknown[] = [];
    const adapter = new AcpProviderAdapter(config, {
      createClient: async (input) => {
        starts.push(input);
        return client;
      },
    });
    expect(adapter.provider).toBe("opencode");
    expect(adapter.capabilities).toEqual({
      exactResume: false,
      structuredApproval: true,
      structuredUserInput: false,
      conversationRollback: false,
      modelSwitch: "in-session",
    });
    await expect(
      adapter.startSession({ threadId, cwd: "/work/tree", permissionMode: "supervised", model: "openai/gpt-5" }),
    ).resolves.toEqual({ threadId, provider: "opencode", cwd: "/work/tree", status: "idle" });
    expect(starts).toEqual([{ cwd: "/work/tree", permissionMode: "supervised", model: "openai/gpt-5" }]);

    await adapter.sendTurn({
      threadId,
      text: "Look at [image: /store/a.png]",
      model: "openai/gpt-5",
      attachments: [{ name: "a.png", mimeType: "image/png", path: "/store/a.png" }],
    });
    await adapter.sendTurn({ threadId, text: "plain" });
    await adapter.interruptTurn({ threadId, turnId });
    expect(client.calls).toEqual([
      {
        method: "turn",
        value: {
          text: "Look at [image: /store/a.png]",
          model: "openai/gpt-5",
          attachments: [{ mimeType: "image/png", path: "/store/a.png" }],
        },
      },
      { method: "turn", value: { text: "plain" } },
      { method: "interrupt", value: turnId },
    ]);
  });

  it("returns the agent's session id and passes a resume id to the client", async () => {
    const starts: unknown[] = [];
    const adapter = new AcpProviderAdapter(config, {
      createClient: async (input) => {
        starts.push(input);
        const client = new FakeClient();
        client.agentSessionId = input.resumeSessionId ?? "s-new";
        return client;
      },
    });
    await expect(adapter.startSession({ threadId, cwd: "/work/tree" })).resolves.toEqual({
      threadId,
      provider: "opencode",
      cwd: "/work/tree",
      status: "idle",
      providerSessionId: "s-new",
    });
    await adapter.stopSession({ threadId });
    await expect(adapter.startSession({ threadId, cwd: "/work/tree", resumeSessionId: "s-old" })).resolves.toEqual({
      threadId,
      provider: "opencode",
      cwd: "/work/tree",
      status: "idle",
      providerSessionId: "s-old",
    });
    expect(starts).toEqual([{ cwd: "/work/tree" }, { cwd: "/work/tree", resumeSessionId: "s-old" }]);
  });

  it("fails the start when the client cannot resume, so the caller can start fresh", async () => {
    const adapter = new AcpProviderAdapter(config, {
      createClient: async () => {
        throw new AcpProviderError("unsupported", "OpenCode cannot resume earlier sessions.");
      },
    });
    await expect(adapter.startSession({ threadId, cwd: "/work/tree", resumeSessionId: "s-old" })).rejects.toMatchObject(
      { code: "unsupported" },
    );
    expect(adapter.hasSession({ threadId })).toBe(false);
  });

  it("maps turn, tool, approval, and error events onto the thread", async () => {
    const client = new FakeClient();
    const adapter = new AcpProviderAdapter(config, { createClient: async () => client });
    const events: ProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.startSession({ threadId, cwd: "/work/tree" });

    client.emit({ type: "turn.started", providerTurnId: turnId });
    client.emit({ type: "assistant.delta", providerTurnId: turnId, text: "Hi" });
    client.emit({
      type: "tool.updated",
      providerTurnId: turnId,
      tool: {
        callId: "call-1",
        name: "Edit",
        title: "Write hello.txt",
        input: { paths: ["/work/tree/hello.txt"] },
        status: "completed",
      },
    });
    client.emit({
      type: "approval.requested",
      providerTurnId: turnId,
      requestId: "req-1",
      payload: { toolName: "rm -rf build", input: { command: "rm -rf build" } },
    });
    client.emit({ type: "turn.completed", providerTurnId: turnId, status: "completed" });
    client.emit({ type: "turn.failed", providerTurnId: turnId, message: "Sign in first." });
    client.emit({ type: "protocol.error", message: "Malformed OpenCode session update." });

    expect(events).toEqual([
      { type: "turn.started", threadId, turnId },
      { type: "assistant.delta", threadId, turnId, text: "Hi" },
      {
        type: "activity",
        threadId,
        turnId,
        activity: {
          activityId: "call-1",
          kind: "file-edit",
          title: "Edit hello.txt",
          status: "completed",
          files: ["hello.txt"],
        },
      },
      {
        type: "approval.requested",
        threadId,
        requestId: "req-1",
        payload: { toolName: "rm -rf build", input: { command: "rm -rf build" } },
      },
      { type: "turn.completed", threadId, turnId, status: "completed" },
      { type: "provider.error", threadId, message: "Sign in first." },
      { type: "provider.error", message: "Malformed OpenCode session update." },
    ]);
  });

  it("answers approvals with the UI decision or an explicit ACP option", async () => {
    const client = new FakeClient();
    const adapter = new AcpProviderAdapter(config, { createClient: async () => client });
    await adapter.startSession({ threadId, cwd: "/work/tree" });
    await adapter.respondToRequest({ threadId, requestId: "a", decision: { approved: true } });
    await adapter.respondToRequest({ threadId, requestId: "b", decision: { approved: false } });
    await adapter.respondToRequest({ threadId, requestId: "c", decision: { decision: "accept", optionId: "always" } });
    expect(client.calls).toEqual([
      { method: "permission", value: { requestId: "a", answer: { allow: true } } },
      { method: "permission", value: { requestId: "b", answer: { allow: false } } },
      { method: "permission", value: { requestId: "c", answer: { allow: true, optionId: "always" } } },
    ]);
    await expect(adapter.respondToUserInput({ threadId, requestId: "x", answers: {} })).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(adapter.rollbackThread({ threadId, numTurns: 1 })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("drops a session the agent closed and closes the client on stop", async () => {
    const dropped = new FakeClient();
    const adapter = new AcpProviderAdapter(config, { createClient: async () => dropped });
    const events: ProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.startSession({ threadId, cwd: "/work/tree" });
    dropped.turns = [{ providerTurnId: turnId, text: "Hi", status: "completed", sessionId: "s1" }];
    await expect(adapter.readThread({ threadId })).resolves.toEqual({ threadId, turns: dropped.turns });
    dropped.emit({ type: "session.closed", reason: "OpenCode exited (1)." });
    expect(events).toEqual([{ type: "session.closed", threadId, reason: "OpenCode exited (1)." }]);
    expect(adapter.hasSession({ threadId })).toBe(false);
    expect(dropped.calls.map((call) => call.method)).toEqual(["close"]);

    const stopped = new FakeClient();
    const other = new AcpProviderAdapter(config, { createClient: async () => stopped });
    await other.startSession({ threadId, cwd: "/work/tree" });
    await other.stopSession({ threadId });
    expect(stopped.calls.map((call) => call.method)).toEqual(["close"]);
    expect(other.listSessions()).toEqual([]);
  });

  it("surfaces a missing CLI as cli_missing through the provider service", async () => {
    const missing = new AcpProviderAdapter(
      { ...config, provider: "goose", displayName: "Goose" },
      {
        createClient: async () => {
          throw new AcpProviderError("cli_missing", "Goose CLI was not found on PATH or in known install locations.");
        },
      },
    );
    const service = new ProviderService(new ProviderRegistry([missing]));
    await expect(service.startSession({ provider: "goose", threadId, cwd: "/work/tree" })).rejects.toMatchObject({
      code: "cli_missing",
      message: "Goose CLI was not found on PATH or in known install locations.",
    });
  });
});

describe("acpActivity", () => {
  it("keeps the classifier title when it is specific and falls back to the ACP title otherwise", () => {
    expect(
      acpActivity(
        { callId: "1", name: "Execute", title: "Run tests", input: { command: "npm test" }, status: "running" },
        "/work/tree",
      ),
    ).toMatchObject({ kind: "command", title: "npm test" });
    expect(
      acpActivity({ callId: "2", name: "Execute", title: "Run the test suite", status: "running" }, "/work/tree"),
    ).toMatchObject({ kind: "command", title: "Run the test suite" });
    expect(
      acpActivity({ callId: "3", name: "Read", title: "Read package.json", status: "completed" }, "/work/tree"),
    ).toMatchObject({ kind: "file-read", title: "Read package.json" });
    expect(
      acpActivity({ callId: "4", name: "Think", title: "Planning the change", status: "completed" }, "/work/tree"),
    ).toMatchObject({ kind: "tool", title: "Planning the change" });
  });
});
