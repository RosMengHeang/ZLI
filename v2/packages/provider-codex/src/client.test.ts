import { describe, expect, it } from "vitest";

import { CodexAppServerClient, type CodexPeer, type CodexProviderEvent } from "./client.js";

class FakePeer implements CodexPeer {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ requestId: string | number; result: unknown }> = [];
  private readonly listeners = new Set<(message: unknown) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    switch (method) {
      case "initialize":
        return { serverInfo: { name: "codex", version: "test" } };
      case "thread/start":
        return { thread: { id: "provider-thread-1" } };
      case "turn/start":
        return { turn: { id: "provider-turn-1" } };
      case "thread/read":
        return { thread: { id: "provider-thread-1", turns: [] } };
      case "thread/rollback":
        return { thread: { id: "provider-thread-1", turns: [] } };
      default:
        return {};
    }
  }

  respond(requestId: string | number, result: unknown): Promise<void> {
    this.responses.push({ requestId, result });
    return Promise.resolve();
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    for (const listener of this.closeListeners) listener();
  }

  emit(message: unknown): void {
    for (const listener of this.listeners) listener(message);
  }

  die(message = "Codex exited"): void {
    const error = new Error(message);
    for (const listener of this.closeListeners) listener(error);
  }
}

describe("CodexAppServerClient", () => {
  it("initializes once, starts a session, sends turns, and normalizes structured events", async () => {
    const peer = new FakePeer();
    const client = await CodexAppServerClient.connect({ peer });
    const events: CodexProviderEvent[] = [];
    client.subscribe((event) => events.push(event));

    await expect(client.startSession({ cwd: "C:/workspace/tree" })).resolves.toEqual({
      providerThreadId: "provider-thread-1",
    });
    await expect(client.sendTurn({ providerThreadId: "provider-thread-1", text: "Fix the bug" })).resolves.toEqual({
      providerTurnId: "provider-turn-1",
    });
    peer.emit({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "provider-thread-1", turnId: "provider-turn-1" },
    });
    peer.emit({
      jsonrpc: "2.0",
      method: "item/agentMessage/delta",
      params: { threadId: "provider-thread-1", turnId: "provider-turn-1", delta: "hello" },
    });
    peer.emit({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "provider-thread-1", turnId: "provider-turn-1", status: "completed" },
    });

    expect(peer.requests.map((request) => request.method)).toEqual(["initialize", "thread/start", "turn/start"]);
    expect(events).toEqual([
      { type: "turn.started", providerThreadId: "provider-thread-1", providerTurnId: "provider-turn-1" },
      {
        type: "assistant.delta",
        providerThreadId: "provider-thread-1",
        providerTurnId: "provider-turn-1",
        text: "hello",
      },
      {
        type: "turn.completed",
        providerThreadId: "provider-thread-1",
        providerTurnId: "provider-turn-1",
        status: "completed",
      },
    ]);
  });

  it("reads the nested app-server v2 turn shape", async () => {
    const peer = new FakePeer();
    const client = await CodexAppServerClient.connect({ peer });
    const events: CodexProviderEvent[] = [];
    client.subscribe((event) => events.push(event));

    peer.emit({
      jsonrpc: "2.0",
      method: "turn/started",
      params: { threadId: "provider-thread-1", turn: { id: "provider-turn-2", status: "inProgress" } },
    });
    peer.emit({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "provider-thread-1", turn: { id: "provider-turn-2", status: "completed" } },
    });

    expect(events).toEqual([
      { type: "turn.started", providerThreadId: "provider-thread-1", providerTurnId: "provider-turn-2" },
      {
        type: "turn.completed",
        providerThreadId: "provider-thread-1",
        providerTurnId: "provider-turn-2",
        status: "completed",
      },
    ]);
  });

  it("responds to structured approval requests and reports process death", async () => {
    const peer = new FakePeer();
    const client = await CodexAppServerClient.connect({ peer });
    const events: CodexProviderEvent[] = [];
    client.subscribe((event) => events.push(event));

    peer.emit({
      jsonrpc: "2.0",
      id: 18,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "provider-thread-1", turnId: "provider-turn-1", command: "git status" },
    });
    await client.respondToRequest(18, { decision: "accept" });
    peer.die("Codex process lost");

    expect(peer.responses).toEqual([{ requestId: 18, result: { decision: "accept" } }]);
    expect(events).toEqual([
      {
        type: "approval.requested",
        requestId: "18",
        providerThreadId: "provider-thread-1",
        providerTurnId: "provider-turn-1",
        payload: { threadId: "provider-thread-1", turnId: "provider-turn-1", command: "git status" },
      },
      { type: "session.closed", reason: "Codex process lost" },
    ]);
  });

  it("does not crash on malformed protocol messages", async () => {
    const peer = new FakePeer();
    const client = await CodexAppServerClient.connect({ peer });
    const events: CodexProviderEvent[] = [];
    client.subscribe((event) => events.push(event));
    peer.emit({ jsonrpc: "2.0", method: "turn/started", params: { threadId: 42 } });
    peer.emit("not-json-rpc");
    expect(events).toEqual([
      { type: "protocol.error", message: "Malformed Codex server message." },
      { type: "protocol.error", message: "Malformed Codex server message." },
    ]);
  });
});

describe("CodexAppServerClient tool items", () => {
  const ids = { threadId: "provider-thread-1", turnId: "provider-turn-1" };

  it("normalizes item/started and item/completed tool items and skips message items", async () => {
    const peer = new FakePeer();
    const client = await CodexAppServerClient.connect({ peer });
    const events: CodexProviderEvent[] = [];
    client.subscribe((event) => events.push(event));
    const notify = (method: string, item: Record<string, unknown>) =>
      peer.emit({ jsonrpc: "2.0", method, params: { ...ids, item } });

    notify("item/started", {
      type: "commandExecution",
      id: "cmd-1",
      command: "npm test",
      cwd: "/work",
      status: "inProgress",
    });
    notify("item/completed", {
      type: "commandExecution",
      id: "cmd-1",
      command: "npm test",
      cwd: "/work",
      status: "completed",
      aggregatedOutput: "1 failing",
      exitCode: 1,
    });
    notify("item/completed", {
      type: "fileChange",
      id: "fc-1",
      status: "completed",
      changes: [{ path: "/work/src/a.ts", kind: { type: "update" } }, { path: "/work/src/b.ts" }],
    });
    notify("item/completed", {
      type: "mcpToolCall",
      id: "mcp-1",
      server: "github",
      tool: "search_issues",
      status: "completed",
      arguments: { query: "bug" },
      result: { content: [{ type: "text", text: "3 issues" }] },
    });
    notify("item/started", { type: "webSearch", id: "web-1", query: "vitest docs" });
    notify("item/completed", { type: "agentMessage", id: "msg-1", text: "hi" });
    peer.emit({ jsonrpc: "2.0", method: "item/completed", params: { ...ids, item: "bad" } });

    expect(events.filter((event) => event.type === "tool.updated")).toEqual([
      {
        type: "tool.updated",
        providerThreadId: "provider-thread-1",
        providerTurnId: "provider-turn-1",
        tool: {
          callId: "cmd-1",
          name: "commandExecution",
          input: { command: "npm test", cwd: "/work" },
          status: "running",
        },
      },
      {
        type: "tool.updated",
        providerThreadId: "provider-thread-1",
        providerTurnId: "provider-turn-1",
        tool: {
          callId: "cmd-1",
          name: "commandExecution",
          input: { command: "npm test", cwd: "/work" },
          status: "failed",
          output: "1 failing",
        },
      },
      {
        type: "tool.updated",
        providerThreadId: "provider-thread-1",
        providerTurnId: "provider-turn-1",
        tool: {
          callId: "fc-1",
          name: "fileChange",
          input: { paths: ["/work/src/a.ts", "/work/src/b.ts"] },
          status: "completed",
        },
      },
      {
        type: "tool.updated",
        providerThreadId: "provider-thread-1",
        providerTurnId: "provider-turn-1",
        tool: {
          callId: "mcp-1",
          name: "github.search_issues",
          input: { query: "bug" },
          status: "completed",
          output: "3 issues",
        },
      },
      {
        type: "tool.updated",
        providerThreadId: "provider-thread-1",
        providerTurnId: "provider-turn-1",
        tool: { callId: "web-1", name: "webSearch", input: { query: "vitest docs" }, status: "running" },
      },
    ]);
    expect(events.some((event) => event.type === "protocol.error")).toBe(false);
  });

  it("starts supervised threads with the requested policy and sends images as localImage input", async () => {
    const peer = new FakePeer();
    const client = await CodexAppServerClient.connect({ peer });
    await client.startSession({
      cwd: "/work",
      model: "gpt-5.2",
      approvalPolicy: "on-request",
      sandboxPolicy: "workspace-write",
    });
    await client.sendTurn({ providerThreadId: "provider-thread-1", text: "Look", imagePaths: ["/tmp/shot.png"] });
    expect(peer.requests.slice(1)).toEqual([
      {
        method: "thread/start",
        params: { cwd: "/work", model: "gpt-5.2", approvalPolicy: "on-request", sandbox: "workspace-write" },
      },
      {
        method: "turn/start",
        params: {
          threadId: "provider-thread-1",
          input: [
            { type: "text", text: "Look" },
            { type: "localImage", path: "/tmp/shot.png" },
          ],
        },
      },
    ]);
  });
});
