import { describe, expect, it } from "vitest";

import { CodexAppServerClient, type CodexPeer, type CodexProviderEvent } from "./client.js";

class FakePeer implements CodexPeer {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ requestId: string | number; result: unknown }> = [];
  private readonly listeners = new Set<(message: unknown) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  /** Messages the server sends while a request is still being answered. */
  readonly during = new Map<string, () => void>();

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    this.during.get(method)?.();
    switch (method) {
      case "initialize":
        return { serverInfo: { name: "codex", version: "test" } };
      case "thread/start":
        return { thread: { id: "provider-thread-1" } };
      case "thread/resume":
        return { thread: { id: (params as { threadId: string }).threadId, turns: [{ id: "old-turn", items: [] }] } };
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
      changes: [
        { path: "/work/src/a.ts", kind: { type: "update" }, diff: "@@ -1,2 +1,2 @@\n keep\n-old\n+new\n" },
        { path: "/work/src/b.ts", kind: { type: "add" }, diff: "one\ntwo\n" },
      ],
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
          lines: { added: 3, removed: 1 },
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

  it("sends per-thread config overrides with thread/start", async () => {
    const peer = new FakePeer();
    const client = await CodexAppServerClient.connect({ peer });
    await client.startSession({
      cwd: "/work",
      config: { "mcp_servers.zli-browser.env": { ZLI_WORKTREE_ID: "wt-1" } },
    });
    expect(peer.requests[1]).toEqual({
      method: "thread/start",
      params: { cwd: "/work", config: { "mcp_servers.zli-browser.env": { ZLI_WORKTREE_ID: "wt-1" } } },
    });
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

describe("CodexAppServerClient token usage", () => {
  it("turns the running thread total into usage for each turn", async () => {
    const peer = new FakePeer();
    const client = await CodexAppServerClient.connect({ peer });
    const events: CodexProviderEvent[] = [];
    client.subscribe((event) => events.push(event));
    const report = (turnId: string, total: Record<string, number>, last: Record<string, number>) =>
      peer.emit({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: { threadId: "t1", turnId, tokenUsage: { total, last, modelContextWindow: 272_000 } },
      });

    report(
      "turn-1",
      { totalTokens: 1_200, inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 200 },
      { totalTokens: 1_200, inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 200 },
    );
    report(
      "turn-1",
      { totalTokens: 3_000, inputTokens: 2_500, cachedInputTokens: 1_400, outputTokens: 500 },
      { totalTokens: 1_800, inputTokens: 1_500, cachedInputTokens: 1_000, outputTokens: 300 },
    );
    report(
      "turn-2",
      { totalTokens: 5_000, inputTokens: 4_200, cachedInputTokens: 2_400, outputTokens: 800 },
      { totalTokens: 2_000, inputTokens: 1_700, cachedInputTokens: 1_000, outputTokens: 300 },
    );

    const turn = (providerTurnId: string, usage: Record<string, number>) => ({
      type: "usage.updated",
      providerThreadId: "t1",
      providerTurnId,
      usage: { ...usage, contextWindow: 272_000 },
    });
    expect(events).toEqual([
      turn("turn-1", { inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 200, contextTokens: 1_200 }),
      turn("turn-1", { inputTokens: 2_500, cachedInputTokens: 1_400, outputTokens: 500, contextTokens: 1_800 }),
      turn("turn-2", { inputTokens: 1_700, cachedInputTokens: 1_000, outputTokens: 300, contextTokens: 2_000 }),
    ]);
  });
});

describe("CodexAppServerClient resume", () => {
  const usage = (threadId: string, turnId: string, total: Record<string, number>) => ({
    jsonrpc: "2.0",
    method: "thread/tokenUsage/updated",
    params: { threadId, turnId, tokenUsage: { total, last: total } },
  });

  it("continues a thread with thread/resume and the same per-thread settings as thread/start", async () => {
    const peer = new FakePeer();
    const client = await CodexAppServerClient.connect({ peer });
    await expect(
      client.resumeSession({
        providerThreadId: "earlier-thread",
        cwd: "/work",
        model: "gpt-5.2",
        approvalPolicy: "on-request",
        sandboxPolicy: "read-only",
        config: { "mcp_servers.zli-browser.env": { ZLI_WORKTREE_ID: "wt-1" } },
      }),
    ).resolves.toEqual({ providerThreadId: "earlier-thread" });
    expect(peer.requests.slice(1)).toEqual([
      {
        method: "thread/resume",
        params: {
          threadId: "earlier-thread",
          cwd: "/work",
          model: "gpt-5.2",
          approvalPolicy: "on-request",
          sandbox: "read-only",
          config: { "mcp_servers.zli-browser.env": { ZLI_WORKTREE_ID: "wt-1" } },
        },
      },
    ]);
  });

  it("does not replay restored history, and counts the next turn from the restored total", async () => {
    const peer = new FakePeer();
    const client = await CodexAppServerClient.connect({ peer });
    const events: CodexProviderEvent[] = [];
    client.subscribe((event) => events.push(event));
    peer.during.set("thread/resume", () =>
      peer.emit(usage("earlier-thread", "old-turn", { inputTokens: 9_000, outputTokens: 1_000 })),
    );

    await client.resumeSession({ providerThreadId: "earlier-thread", cwd: "/work" });
    peer.emit(usage("earlier-thread", "old-turn", { inputTokens: 9_000, outputTokens: 1_000 }));
    peer.emit({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "earlier-thread", turn: { id: "old-turn", status: "completed" } },
    });
    expect(events).toEqual([]);

    peer.emit({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "earlier-thread", turnId: "new-turn" } });
    peer.emit(usage("earlier-thread", "new-turn", { inputTokens: 9_500, outputTokens: 1_200 }));
    expect(events).toEqual([
      { type: "turn.started", providerThreadId: "earlier-thread", providerTurnId: "new-turn" },
      {
        type: "usage.updated",
        providerThreadId: "earlier-thread",
        providerTurnId: "new-turn",
        usage: { inputTokens: 500, outputTokens: 200, contextTokens: 10_700 },
      },
    ]);
  });

  it("surfaces a failed resume instead of starting a new thread", async () => {
    const peer = new FakePeer();
    const client = await CodexAppServerClient.connect({ peer });
    peer.during.set("thread/resume", () => {
      throw new Error("no rollout found for thread id earlier-thread");
    });
    await expect(client.resumeSession({ providerThreadId: "earlier-thread", cwd: "/work" })).rejects.toThrow(
      "Codex request failed: thread/resume.",
    );
    expect(peer.requests.map((request) => request.method)).toEqual(["initialize", "thread/resume"]);
  });
});

describe("CodexAppServerClient plan limits", () => {
  it("reads the plan's rate limits with no params", async () => {
    const peer = new FakePeer();
    const client = await CodexAppServerClient.connect({ peer });
    await client.readRateLimits();
    expect(peer.requests.at(-1)).toEqual({ method: "account/rateLimits/read", params: undefined });
  });
});
