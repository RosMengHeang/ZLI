import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type AcpChild,
  AcpClient,
  type AcpClientOptions,
  type AcpProviderEvent,
  type AcpSpawnOptions,
} from "./client.js";

type Message = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};
type Handler = (params: Record<string, unknown>) => unknown;

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

class RpcFailure {
  constructor(
    readonly code: number,
    readonly message: string,
    readonly data?: unknown,
  ) {}
}

/** A scripted ACP agent. Requests are answered asynchronously, like a real process. */
class FakeAgent implements AcpChild {
  readonly pid = undefined;
  readonly received: Message[] = [];
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly handlers = new Map<string, Handler>();
  /** Prompts stay open until the test answers them. */
  readonly prompts: Array<{ id: number | string; params: Record<string, unknown> }> = [];
  killed = false;
  private readonly events = new EventEmitter();
  readonly stdin = {
    destroyed: false,
    write: (data: string) => {
      for (const line of data.split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Message;
        this.received.push(message);
        if (message.method && message.id !== undefined) this.answer(message);
      }
      return true;
    },
    end: () => undefined,
    on: () => undefined,
  };

  constructor(
    initialize: Record<string, unknown> = { protocolVersion: 1 },
    session: Record<string, unknown> = { sessionId: "s1" },
  ) {
    this.handlers.set("initialize", () => initialize);
    this.handlers.set("session/new", () => session);
  }

  once(event: "error" | "close", listener: (...args: never[]) => void): void {
    this.events.once(event, listener as (...args: unknown[]) => void);
  }

  kill(): boolean {
    this.killed = true;
    this.stdin.destroyed = true;
    this.events.emit("close", null, "SIGTERM");
    return true;
  }

  exit(code: number): void {
    this.stdin.destroyed = true;
    this.events.emit("close", code, null);
  }

  send(value: unknown): void {
    this.stdout.emit("data", `${JSON.stringify(value)}\n`);
  }

  update(update: Record<string, unknown>, sessionId = "s1"): void {
    this.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }

  finishPrompt(stopReason = "end_turn", index = this.prompts.length - 1): void {
    const prompt = this.prompts[index];
    if (!prompt) throw new Error("no prompt");
    this.send({ jsonrpc: "2.0", id: prompt.id, result: { stopReason } });
  }

  failPrompt(code: number, message: string, index = this.prompts.length - 1): void {
    const prompt = this.prompts[index];
    if (!prompt) throw new Error("no prompt");
    this.send({ jsonrpc: "2.0", id: prompt.id, error: { code, message } });
  }

  requests(method: string): Message[] {
    return this.received.filter((message) => message.method === method);
  }

  responseTo(id: number | string): Message | undefined {
    return this.received.find((message) => message.id === id && message.method === undefined);
  }

  private answer(message: Message): void {
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (message.method === "session/prompt") {
      this.prompts.push({ id: message.id as number, params });
      return;
    }
    const handler = this.handlers.get(message.method as string);
    setImmediate(() => {
      if (!handler) {
        this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
        return;
      }
      const result = handler(params);
      if (result instanceof RpcFailure) {
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: result.code, message: result.message, ...(result.data ? { data: result.data } : {}) },
        });
      } else {
        this.send({ jsonrpc: "2.0", id: message.id, result });
      }
    });
  }
}

async function harness(
  agent = new FakeAgent(),
  options: Partial<AcpClientOptions> = {},
): Promise<{
  client: AcpClient;
  agent: FakeAgent;
  events: AcpProviderEvent[];
  calls: Array<{ command: string; args: readonly string[]; options: AcpSpawnOptions }>;
}> {
  const calls: Array<{ command: string; args: readonly string[]; options: AcpSpawnOptions }> = [];
  const client = await AcpClient.start({
    command: "/usr/bin/opencode",
    args: ["acp"],
    cwd: "/work/tree",
    displayName: "OpenCode",
    authHint: "Sign in to OpenCode in a terminal first (run `opencode auth login`).",
    env: { PATH: "/usr/bin" },
    spawnProcess: (command, args, spawnOptions) => {
      calls.push({ command, args, options: spawnOptions });
      return agent;
    },
    ...options,
  });
  const events: AcpProviderEvent[] = [];
  client.subscribe((event) => events.push(event));
  return { client, agent, events, calls };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("AcpClient handshake", () => {
  it("spawns the ACP command in the worktree, initializes, and opens a session", async () => {
    const agent = new FakeAgent({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } });
    const { client, calls } = await harness(agent);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "/usr/bin/opencode", args: ["acp"] });
    expect(calls[0]?.options).toMatchObject({ cwd: "/work/tree", shell: false, windowsHide: true });
    expect(calls[0]?.options.env.PWD).toBe("/work/tree");
    expect(calls[0]?.options.env.PATH).toBe("/usr/bin");
    expect(agent.received.map((message) => message.method)).toEqual(["initialize", "session/new"]);
    expect(agent.received[0]?.params).toEqual({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    expect(agent.received[1]?.params).toEqual({ cwd: "/work/tree", mcpServers: [] });
    expect(client.agentSessionId).toBe("s1");
    expect(client.supportsImages).toBe(true);
  });

  it("offers the session's MCP servers in session/new", async () => {
    const agent = new FakeAgent();
    const server = {
      name: "zli-browser",
      command: "C:\\ZLI\\ZLI.exe",
      args: ["C:\\ZLI\\resources\\zli-browser.js", "mcp"],
      env: [
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        { name: "ZLI_WORKTREE_ID", value: "wt-1" },
      ],
    };
    await harness(agent, { mcpServers: [server] });
    expect(agent.received[1]?.params).toEqual({ cwd: "/work/tree", mcpServers: [server] });
  });

  it("turns an auth failure on session/new into a sign-in hint and stops the agent", async () => {
    const agent = new FakeAgent();
    agent.handlers.set("session/new", () => new RpcFailure(-32000, "Authentication required"));
    await expect(harness(agent)).rejects.toMatchObject({
      code: "auth_required",
      message: "Sign in to OpenCode in a terminal first (run `opencode auth login`).",
    });
    expect(agent.killed).toBe(true);
  });

  it("falls back to the advertised auth method when no hint is configured", async () => {
    const agent = new FakeAgent({
      protocolVersion: 1,
      authMethods: [{ id: "login", name: "Login", description: "Run `kimi login` in a terminal." }],
    });
    agent.handlers.set("session/new", () => new RpcFailure(-32603, "Not logged in"));
    await expect(harness(agent, { authHint: "", displayName: "Kimi Code" })).rejects.toMatchObject({
      code: "auth_required",
      message: "Kimi Code reported: Not logged in Sign in to Kimi Code first: Run `kimi login` in a terminal.",
    });
  });

  it("treats an empty model picker as signed out", async () => {
    const agent = new FakeAgent();
    agent.handlers.set("session/new", () => ({
      sessionId: "s1",
      configOptions: [{ id: "model", category: "model", type: "select", currentValue: "", options: [] }],
    }));
    await expect(harness(agent)).rejects.toMatchObject({
      code: "auth_required",
      message: "OpenCode has no model set up. Sign in to OpenCode in a terminal first (run `opencode auth login`).",
    });
  });

  it("rejects an unsupported protocol version", async () => {
    const agent = new FakeAgent({ protocolVersion: 2 });
    await expect(harness(agent)).rejects.toMatchObject({ code: "unsupported" });
    expect(agent.killed).toBe(true);
  });

  it("reports the agent's exit and stderr when it dies during the handshake", async () => {
    const agent = new FakeAgent();
    agent.handlers.delete("initialize");
    const original = agent.stdin.write;
    agent.stdin.write = (data: string) => {
      setImmediate(() => {
        agent.stderr.emit("data", "fatal: config is broken\n");
        agent.exit(3);
      });
      return original(data.replace(/"method":"initialize"/u, '"method":"ignored"'));
    };
    await expect(harness(agent)).rejects.toMatchObject({
      message: "OpenCode exited (3): fatal: config is broken",
    });
  });

  it("selects the requested model through session config options", async () => {
    const agent = new FakeAgent(
      { protocolVersion: 1 },
      {
        sessionId: "s1",
        configOptions: [
          { id: "model", category: "model", type: "select", currentValue: "opencode/big-pickle", options: [] },
          { id: "mode", category: "mode", type: "select", currentValue: "build", options: [] },
        ],
      },
    );
    agent.handlers.set("session/set_config_option", (params) => ({
      configOptions: [{ id: "model", category: "model", currentValue: params.value }],
    }));
    const { client } = await harness(agent, { model: "openai/gpt-5" });
    expect(agent.requests("session/set_config_option")[0]?.params).toEqual({
      sessionId: "s1",
      configId: "model",
      value: "openai/gpt-5",
    });
    await client.sendTurn({ text: "hi", model: "openai/gpt-5" });
    expect(agent.requests("session/set_config_option")).toHaveLength(1);
  });

  it("uses session/set_model when only the legacy models list is advertised", async () => {
    const agent = new FakeAgent(
      { protocolVersion: 1 },
      { sessionId: "s1", models: { currentModelId: "a", availableModels: [{ modelId: "a" }, { modelId: "b" }] } },
    );
    agent.handlers.set("session/set_model", () => ({}));
    const { client } = await harness(agent);
    await client.sendTurn({ text: "hi", model: "b" });
    expect(agent.requests("session/set_model")[0]?.params).toEqual({ sessionId: "s1", modelId: "b" });
    agent.finishPrompt();
    await tick();
    await client.sendTurn({ text: "again", model: "b" });
    expect(agent.requests("session/set_model")).toHaveLength(1);
  });

  it("tolerates agents without a model API and fails on a rejected model id", async () => {
    const quiet = new FakeAgent();
    const { client } = await harness(quiet, { model: "any" });
    expect(quiet.requests("session/set_model")).toHaveLength(1);
    await client.sendTurn({ text: "hi", model: "other" });
    expect(quiet.requests("session/set_model")).toHaveLength(1);

    const strict = new FakeAgent(
      { protocolVersion: 1 },
      { sessionId: "s1", configOptions: [{ id: "model", category: "model", currentValue: "x" }] },
    );
    strict.handlers.set(
      "session/set_config_option",
      () => new RpcFailure(-32602, "Invalid params: model not found: nope/x"),
    );
    await expect(harness(strict, { model: "nope/x" })).rejects.toMatchObject({
      code: "request_failed",
      message: "OpenCode could not switch to model nope/x: Invalid params: model not found: nope/x",
    });
  });
});

describe("AcpClient turns", () => {
  it("streams text and tool calls, then completes on end_turn", async () => {
    const { client, agent, events } = await harness();
    const turn = await client.sendTurn({ text: "Create hello.txt" });
    expect(agent.prompts[0]?.params).toEqual({ sessionId: "s1", prompt: [{ type: "text", text: "Create hello.txt" }] });

    agent.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
    agent.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Creating " } });
    agent.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the file." } });
    agent.update({ sessionUpdate: "plan", entries: [] });
    agent.update({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Write hello.txt",
      kind: "edit",
      status: "pending",
      locations: [{ path: "/work/tree/hello.txt" }],
      rawInput: { filePath: "/work/tree/hello.txt" },
    });
    agent.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      content: [{ type: "diff", path: "/work/tree/hello.txt", oldText: null, newText: "hi" }],
    });
    agent.update({
      sessionUpdate: "tool_call",
      toolCallId: "call-2",
      title: "npm test",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "npm test" },
    });
    agent.update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-2",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "1 failing" } }],
    });
    agent.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ignored" } }, "other-session");
    agent.finishPrompt("end_turn");
    await tick();

    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "Creating " },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "the file." },
      {
        type: "tool.updated",
        providerTurnId: turn.providerTurnId,
        tool: {
          callId: "call-1",
          name: "Edit",
          title: "Write hello.txt",
          input: { filePath: "/work/tree/hello.txt", paths: ["/work/tree/hello.txt"] },
          status: "running",
        },
      },
      {
        type: "tool.updated",
        providerTurnId: turn.providerTurnId,
        tool: {
          callId: "call-1",
          name: "Edit",
          title: "Write hello.txt",
          input: { filePath: "/work/tree/hello.txt", paths: ["/work/tree/hello.txt"] },
          status: "completed",
        },
      },
      {
        type: "tool.updated",
        providerTurnId: turn.providerTurnId,
        tool: {
          callId: "call-2",
          name: "Execute",
          title: "npm test",
          input: { command: "npm test" },
          status: "running",
        },
      },
      {
        type: "tool.updated",
        providerTurnId: turn.providerTurnId,
        tool: {
          callId: "call-2",
          name: "Execute",
          title: "npm test",
          input: { command: "npm test" },
          status: "failed",
          output: "1 failing",
        },
      },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "completed" },
    ]);
    expect(client.transcript()).toEqual([
      { providerTurnId: turn.providerTurnId, text: "Creating the file.", status: "completed", sessionId: "s1" },
    ]);
  });

  it("rejects a second turn while one is running", async () => {
    const { client } = await harness();
    await client.sendTurn({ text: "one" });
    await expect(client.sendTurn({ text: "two" })).rejects.toMatchObject({
      code: "request_failed",
      message: "OpenCode already has a turn in progress.",
    });
  });

  it("maps other stop reasons onto the completed status", async () => {
    const { client, agent, events } = await harness();
    const turn = await client.sendTurn({ text: "go" });
    agent.finishPrompt("max_tokens");
    await tick();
    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      providerTurnId: turn.providerTurnId,
      status: "max_tokens",
    });
  });

  it("fails the turn with the sign-in hint when the prompt needs auth", async () => {
    const { client, agent, events } = await harness();
    const turn = await client.sendTurn({ text: "go" });
    agent.failPrompt(-32000, "Authentication required");
    await tick();
    expect(events.at(-1)).toEqual({
      type: "turn.failed",
      providerTurnId: turn.providerTurnId,
      message: "Sign in to OpenCode in a terminal first (run `opencode auth login`).",
    });
    const next = await client.sendTurn({ text: "retry" });
    agent.failPrompt(-32603, "Internal error");
    await tick();
    expect(events.at(-1)).toEqual({
      type: "turn.failed",
      providerTurnId: next.providerTurnId,
      message: "OpenCode turn failed: Internal error",
    });
    const expired = await client.sendTurn({ text: "again" });
    agent.failPrompt(-32603, "Internal error: This API key has expired.");
    await tick();
    expect(events.at(-1)).toEqual({
      type: "turn.failed",
      providerTurnId: expired.providerTurnId,
      message:
        "OpenCode reported: Internal error: This API key has expired. Sign in to OpenCode in a terminal first (run `opencode auth login`).",
    });
  });

  it("sends image blocks only when the agent supports images", async () => {
    const reads: string[] = [];
    const readAttachment = async (path: string) => {
      reads.push(path);
      if (path.endsWith("missing.png")) throw new Error("ENOENT");
      return Buffer.from("png-bytes");
    };
    const images = new FakeAgent({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } });
    const { client } = await harness(images, { readAttachment });
    await client.sendTurn({
      text: "look",
      attachments: [
        { mimeType: "image/png", path: "/store/a.png" },
        { mimeType: "image/png", path: "/store/missing.png" },
      ],
    });
    expect(images.prompts[0]?.params.prompt).toEqual([
      { type: "text", text: "look" },
      { type: "image", mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64") },
    ]);

    const textOnly = new FakeAgent();
    const plain = await harness(textOnly, { readAttachment });
    await plain.client.sendTurn({ text: "look", attachments: [{ mimeType: "image/png", path: "/store/b.png" }] });
    expect(textOnly.prompts[0]?.params.prompt).toEqual([{ type: "text", text: "look" }]);
    expect(reads).toEqual(["/store/a.png", "/store/missing.png"]);
  });

  it("cancels on interrupt and waits for the cancelled prompt before the next one", async () => {
    const { client, agent, events } = await harness();
    const turn = await client.sendTurn({ text: "long job" });
    await client.interruptTurn(turn.providerTurnId);
    expect(agent.requests("session/cancel")).toEqual([
      { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s1" } },
    ]);
    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      providerTurnId: turn.providerTurnId,
      status: "interrupted",
    });

    const next = client.sendTurn({ text: "next" });
    await tick();
    expect(agent.prompts).toHaveLength(1);
    agent.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } });
    agent.finishPrompt("cancelled", 0);
    const started = await next;
    expect(agent.prompts).toHaveLength(2);
    expect(events.filter((event) => event.type === "assistant.delta")).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "turn.started", providerTurnId: started.providerTurnId });
    await expect(client.interruptTurn("someone-else")).rejects.toMatchObject({ code: "request_failed" });
  });

  it("fails the turn, rejects pending requests, and closes the session when the agent exits", async () => {
    const agent = new FakeAgent();
    const { client, events } = await harness(agent);
    const turn = await client.sendTurn({ text: "go" });
    agent.stderr.emit("data", "panic: out of memory\n");
    agent.exit(1);
    await tick();
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      {
        type: "turn.failed",
        providerTurnId: turn.providerTurnId,
        message: "OpenCode exited (1): panic: out of memory",
      },
      { type: "session.closed", reason: "OpenCode exited (1): panic: out of memory" },
    ]);
    await expect(client.sendTurn({ text: "again" })).rejects.toMatchObject({ code: "closed" });
  });

  it("kills the agent on close", async () => {
    const { client, agent, events } = await harness();
    await client.sendTurn({ text: "go" });
    await client.close();
    await tick();
    expect(agent.killed).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["turn.started"]);
    await expect(client.sendTurn({ text: "next" })).rejects.toMatchObject({ code: "closed" });
  });
});

describe("AcpClient agent requests", () => {
  const options = [
    { optionId: "once", name: "Allow once", kind: "allow_once" },
    { optionId: "always", name: "Always allow", kind: "allow_always" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ];
  const permission = (id: number) => ({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId: "s1",
      toolCall: { toolCallId: "call-9", title: "rm -rf build", kind: "execute", rawInput: { command: "rm -rf build" } },
      options,
    },
  });

  it("auto-approves with allow_always in full access and refuses fs and terminal methods", async () => {
    const { client, agent, events } = await harness();
    await client.sendTurn({ text: "go" });
    agent.send(permission(100));
    agent.send({ jsonrpc: "2.0", id: 101, method: "fs/read_text_file", params: { path: "/etc/passwd" } });
    agent.send({ jsonrpc: "2.0", id: "t1", method: "terminal/create", params: {} });
    expect(agent.responseTo(100)).toEqual({
      jsonrpc: "2.0",
      id: 100,
      result: { outcome: { outcome: "selected", optionId: "always" } },
    });
    expect(agent.responseTo(101)).toMatchObject({ error: { code: -32601 } });
    expect(agent.responseTo("t1")).toMatchObject({ error: { code: -32601 } });
    expect(events.some((event) => event.type === "approval.requested")).toBe(false);
  });

  it("surfaces approvals in supervised mode and answers with the chosen option", async () => {
    const { client, agent, events } = await harness(new FakeAgent(), { permissionMode: "supervised" });
    const turn = await client.sendTurn({ text: "go" });
    agent.send(permission(200));
    agent.send(permission(201));
    agent.send(permission(202));
    const requests = events.flatMap((event) => (event.type === "approval.requested" ? [event] : []));
    expect(requests).toHaveLength(3);
    expect(requests[0]).toMatchObject({
      providerTurnId: turn.providerTurnId,
      payload: {
        toolName: "rm -rf build",
        input: { command: "rm -rf build" },
        toolCallId: "call-9",
        kind: "execute",
        options,
      },
    });
    expect(agent.responseTo(200)).toBeUndefined();

    await client.respondToPermission(requests[0]?.requestId ?? "", { allow: true });
    await client.respondToPermission(requests[1]?.requestId ?? "", { allow: false });
    expect(agent.responseTo(200)?.result).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    expect(agent.responseTo(201)?.result).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    await expect(client.respondToPermission(requests[0]?.requestId ?? "", { allow: true })).rejects.toMatchObject({
      code: "request_failed",
    });

    agent.finishPrompt();
    await tick();
    expect(agent.responseTo(202)?.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("cancels a permission request that arrives with no turn running", async () => {
    const { agent } = await harness(new FakeAgent(), { permissionMode: "supervised" });
    agent.send(permission(300));
    expect(agent.responseTo(300)?.result).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

describe("AcpClient framing", () => {
  it("joins split lines and skips stdout noise", async () => {
    const { client, agent, events } = await harness();
    const turn = await client.sendTurn({ text: "go" });
    const line = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } },
      },
    });
    agent.stdout.emit("data", "Starting agent...\n");
    agent.stdout.emit("data", "{not json\n");
    agent.stdout.emit("data", line.slice(0, 20));
    agent.stdout.emit("data", `${line.slice(20)}\r\n`);
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "Hi" },
    ]);
  });

  it("reports a malformed session update without failing the turn", async () => {
    const { client, agent, events } = await harness();
    await client.sendTurn({ text: "go" });
    agent.send({ jsonrpc: "2.0", method: "session/update", params: { update: {} } });
    agent.update({ sessionUpdate: "tool_call", title: "no id" });
    expect(events.slice(1)).toEqual([
      { type: "protocol.error", message: "Malformed OpenCode session update." },
      { type: "protocol.error", message: "Malformed OpenCode session update." },
    ]);
  });
});

describe("AcpClient startup checks", () => {
  it("fails fast when the CLI path does not exist", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "zli-acp-"));
    await expect(
      AcpClient.start({ command: join(cwd, "missing-agent"), args: ["acp"], cwd, displayName: "OpenCode" }),
    ).rejects.toMatchObject({
      code: "cli_missing",
      message: `OpenCode CLI was not found at ${join(cwd, "missing-agent")}.`,
    });
  });

  it("reports a missing worktree without blaming the CLI", async () => {
    const cwd = join(mkdtempSync(join(tmpdir(), "zli-acp-")), "missing-tree");
    await expect(AcpClient.start({ command: join(cwd, "agent"), cwd, displayName: "Goose" })).rejects.toMatchObject({
      code: "request_failed",
      message: `Goose working directory does not exist: ${cwd}.`,
    });
  });
});
