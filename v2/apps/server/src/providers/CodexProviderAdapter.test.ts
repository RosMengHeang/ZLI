import { ThreadId } from "@zli-v2/contracts";
import type { CodexProviderEvent } from "@zli-v2/provider-codex";
import { describe, expect, it } from "vitest";

import { CodexProviderAdapter, codexApprovalDecision, codexUserInputAnswers } from "./CodexProviderAdapter.js";
import type { ProviderEvent } from "./ProviderService.js";

const threadId = ThreadId.parse("00000000-0000-4000-8000-000000000701");

class FakeClient {
  readonly calls: Array<{ method: string; value: unknown }> = [];
  private readonly listeners = new Set<(event: CodexProviderEvent) => void>();

  resumeError: Error | undefined;

  async startSession(input: { cwd: string }) {
    this.calls.push({ method: "start", value: input });
    return { providerThreadId: "codex-thread-1" };
  }
  async resumeSession(input: { providerThreadId: string; cwd: string }) {
    this.calls.push({ method: "resume", value: input });
    if (this.resumeError) throw this.resumeError;
    return { providerThreadId: input.providerThreadId };
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
  subscribe(listener: (event: CodexProviderEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: CodexProviderEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

describe("CodexProviderAdapter", () => {
  it("maps provider-native identifiers and structured events into the neutral adapter", async () => {
    const client = new FakeClient();
    const adapter = new CodexProviderAdapter({ createClient: async () => client });
    const events: ProviderEvent[] = [];
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

  it("adds per-thread config overrides built from the session start", async () => {
    const client = new FakeClient();
    const adapter = new CodexProviderAdapter({
      createClient: async () => client,
      threadConfig: (input) => ({ "mcp_servers.zli-browser.env": { ZLI_WORKTREE_ID: input.worktreeId } }),
    });
    await adapter.startSession({ threadId, cwd: "C:/workspace/tree", worktreeId: "wt-1" });
    expect(client.calls[0]).toEqual({
      method: "start",
      value: { cwd: "C:/workspace/tree", config: { "mcp_servers.zli-browser.env": { ZLI_WORKTREE_ID: "wt-1" } } },
    });
  });
});

describe("CodexProviderAdapter resume", () => {
  it("returns the Codex thread id of a fresh session so it can be resumed later", async () => {
    const client = new FakeClient();
    const adapter = new CodexProviderAdapter({ createClient: async () => client });
    await expect(adapter.startSession({ threadId, cwd: "/tree" })).resolves.toMatchObject({
      providerSessionId: "codex-thread-1",
    });
  });

  it("continues the earlier Codex thread with the same settings a fresh start uses", async () => {
    const client = new FakeClient();
    const adapter = new CodexProviderAdapter({
      createClient: async () => client,
      threadConfig: () => ({ "mcp_servers.zli-browser.env": { ZLI_WORKTREE_ID: "wt-1" } }),
    });
    await expect(
      adapter.startSession({
        threadId,
        cwd: "/tree",
        model: "gpt-5.2",
        permissionMode: "supervised",
        resumeSessionId: "codex-thread-earlier",
      }),
    ).resolves.toMatchObject({ threadId, providerSessionId: "codex-thread-earlier" });
    expect(client.calls).toEqual([
      {
        method: "resume",
        value: {
          providerThreadId: "codex-thread-earlier",
          cwd: "/tree",
          config: { "mcp_servers.zli-browser.env": { ZLI_WORKTREE_ID: "wt-1" } },
          model: "gpt-5.2",
          approvalPolicy: "on-request",
          sandboxPolicy: "workspace-write",
        },
      },
    ]);

    await adapter.sendTurn({ threadId, text: "and now?" });
    expect(client.calls.at(-1)).toEqual({
      method: "turn",
      value: { providerThreadId: "codex-thread-earlier", text: "and now?" },
    });
  });

  it("throws when the resume fails and keeps no session, so the caller can start over", async () => {
    const client = new FakeClient();
    client.resumeError = new Error("Codex request failed: thread/resume.");
    const adapter = new CodexProviderAdapter({ createClient: async () => client });
    await expect(
      adapter.startSession({ threadId, cwd: "/tree", resumeSessionId: "codex-thread-gone" }),
    ).rejects.toThrow("thread/resume");
    expect(adapter.hasSession({ threadId })).toBe(false);
    expect(client.calls.map((call) => call.method)).toEqual(["resume"]);
  });
});

describe("codexApprovalDecision", () => {
  it("maps UI approvals onto Codex decisions", () => {
    expect(codexApprovalDecision({ approved: true })).toEqual({ decision: "accept" });
    expect(codexApprovalDecision({ approved: false })).toEqual({ decision: "decline" });
    expect(codexApprovalDecision({ decision: "cancel" })).toEqual({ decision: "cancel" });
    expect(codexApprovalDecision({ approved: true, scope: "session" })).toEqual({ decision: "acceptForSession" });
    expect(codexApprovalDecision({ decision: "acceptForSession" })).toEqual({ decision: "acceptForSession" });
  });
});

describe("codexUserInputAnswers", () => {
  it("keys each answer by question id as a list, the shape item/tool/requestUserInput expects", () => {
    expect(codexUserInputAnswers({ q1: "Postgres", q2: "yes" })).toEqual({
      answers: { q1: { answers: ["Postgres"] }, q2: { answers: ["yes"] } },
    });
  });
});

describe("CodexProviderAdapter accounts", () => {
  it("runs each account on its own app server and closes it when its last thread stops", async () => {
    const created: Array<{ accountId: string | undefined; client: FakeClient }> = [];
    const adapter = new CodexProviderAdapter({
      createClient: async ({ account }) => {
        const client = new FakeClient();
        created.push({ accountId: account?.accountId, client });
        return client;
      },
    });
    const work = { accountId: "work", env: { CODEX_HOME: "/zli/accounts/work" } };
    const second = ThreadId.parse("00000000-0000-4000-8000-000000000702");
    const third = ThreadId.parse("00000000-0000-4000-8000-000000000703");
    await adapter.startSession({ threadId, cwd: "/tree" });
    await adapter.startSession({ threadId: second, cwd: "/tree", account: work });
    await adapter.startSession({ threadId: third, cwd: "/tree", account: work });
    expect(created.map((entry) => entry.accountId)).toEqual([undefined, "work"]);

    await adapter.sendTurn({ threadId: second, text: "hi" });
    expect(created[1]?.client.calls.map((call) => call.method)).toEqual(["start", "start", "turn"]);
    expect(created[0]?.client.calls.map((call) => call.method)).toEqual(["start"]);

    await adapter.stopSession({ threadId: second });
    expect(created[1]?.client.calls.map((call) => call.method)).not.toContain("close");
    await adapter.stopSession({ threadId: third });
    expect(created[1]?.client.calls.at(-1)?.method).toBe("close");
    await adapter.stopSession({ threadId });
    expect(created[0]?.client.calls.map((call) => call.method)).not.toContain("close");
  });

  it("closes only the sessions of the app server that exited", async () => {
    const clients: FakeClient[] = [];
    const adapter = new CodexProviderAdapter({
      createClient: async () => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
    });
    const events: ProviderEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    const second = ThreadId.parse("00000000-0000-4000-8000-000000000704");
    await adapter.startSession({ threadId, cwd: "/tree" });
    await adapter.startSession({ threadId: second, cwd: "/tree", account: { accountId: "work", env: {} } });
    clients[1]?.emit({ type: "session.closed", reason: "exited" } as CodexProviderEvent);
    expect(events).toEqual([{ type: "session.closed", threadId: second, reason: "exited" }]);
    expect(adapter.hasSession({ threadId })).toBe(true);
    expect(adapter.hasSession({ threadId: second })).toBe(false);
  });
});
