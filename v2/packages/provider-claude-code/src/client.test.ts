import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type ClaudeChild,
  ClaudeCodeClient,
  type ClaudePeer,
  type ClaudeProviderEvent,
  type ClaudeSpawnOptions,
} from "./client.js";
import { CLAUDE_SESSION_ARGS, claudeSessionArgs } from "./protocol.js";

class FakePeer implements ClaudePeer {
  readonly written: string[] = [];
  closed = false;
  private readonly listeners = new Set<(message: unknown) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();

  write(line: string): void {
    this.written.push(line);
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
    this.closed = true;
  }

  emit(message: unknown): void {
    for (const listener of this.listeners) listener(message);
  }

  die(error?: Error): void {
    for (const listener of this.closeListeners) listener(error);
  }
}

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

class FakeProcess implements ClaudeChild {
  readonly written: string[] = [];
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  killed = false;
  private readonly events = new EventEmitter();
  readonly stdin = {
    destroyed: false,
    write: (data: string) => {
      this.written.push(data);
      return true;
    },
    on: () => undefined,
  };

  once(event: "error" | "close", listener: (...args: never[]) => void): void {
    this.events.once(event, listener as (...args: unknown[]) => void);
  }

  kill(): boolean {
    this.killed = true;
    this.stdin.destroyed = true;
    this.events.emit("close", null, "SIGTERM");
    return true;
  }

  fail(error: Error): void {
    this.events.emit("error", error);
  }

  exit(code: number): void {
    this.events.emit("close", code, null);
  }
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** What the CLI prints when it accepts the initialize request written first on stdin. */
function initializeReply(written: readonly string[]): string {
  const request = JSON.parse(written[0] ?? "{}") as { request_id?: string };
  return line({ type: "control_response", response: { subtype: "success", request_id: request.request_id } });
}

async function startedClient(): Promise<{ client: ClaudeCodeClient; peer: FakePeer; events: ClaudeProviderEvent[] }> {
  const peer = new FakePeer();
  const pending = ClaudeCodeClient.start({ peer, cwd: "/work/tree" });
  peer.emit({ type: "system", subtype: "init", session_id: "sess-1" });
  const client = await pending;
  const events: ClaudeProviderEvent[] = [];
  client.subscribe((event) => events.push(event));
  return { client, peer, events };
}

describe("ClaudeCodeClient", () => {
  it("starts a session from CLI init, sends a turn, and normalizes stream events", async () => {
    const { client, peer, events } = await startedClient();
    const turn = await client.sendTurn({ text: "Fix the bug" });

    peer.emit({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
    });
    peer.emit({
      type: "assistant",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    });
    peer.emit({
      type: "stream_event",
      parent_tool_use_id: "toolu_sub",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hidden" } },
    });
    peer.emit({ type: "result", subtype: "success", is_error: false, result: "hello", session_id: "sess-1" });

    const user = JSON.parse(peer.written[1] ?? "{}") as {
      type: string;
      session_id: string;
      message: { role: string; content: string };
    };
    expect(JSON.parse(peer.written[0] ?? "{}")).toMatchObject({
      type: "control_request",
      request: { subtype: "initialize", hooks: null },
    });
    expect(user).toMatchObject({
      type: "user",
      session_id: "sess-1",
      parent_tool_use_id: null,
      message: { role: "user", content: "Fix the bug" },
    });
    expect(turn.providerTurnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "hello" },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "completed" },
    ]);
    expect(client.transcript()).toEqual([{ providerTurnId: turn.providerTurnId, text: "hello", status: "completed" }]);
  });

  it("streams main-conversation thinking and skips subagent and redacted thinking", async () => {
    const { client, peer, events } = await startedClient();
    const turn = await client.sendTurn({ text: "Think" });
    const stream = (event: unknown, parent: string | null = null) =>
      peer.emit({ type: "stream_event", parent_tool_use_id: parent, event });
    stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check " } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "tests." } });
    stream(
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hidden" } },
      "toolu_sub",
    );
    stream({ type: "content_block_stop", index: 0 });
    peer.emit({
      type: "assistant",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "thinking", thinking: "Check tests.", signature: "sig" }] },
    });
    stream({ type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "x" } });
    stream({ type: "content_block_stop", index: 1 });
    // A block left open when the turn ends is closed with it.
    stream({ type: "content_block_start", index: 2, content_block: { type: "thinking", thinking: "" } });
    peer.emit({ type: "result", subtype: "success", is_error: false, result: "", session_id: "sess-1" });

    const id = turn.providerTurnId;
    expect(events.filter((event) => event.type.startsWith("reasoning."))).toEqual([
      { type: "reasoning.delta", providerTurnId: id, reasoningId: `${id}-thinking-1`, text: "" },
      { type: "reasoning.delta", providerTurnId: id, reasoningId: `${id}-thinking-1`, text: "Check " },
      { type: "reasoning.delta", providerTurnId: id, reasoningId: `${id}-thinking-1`, text: "tests." },
      { type: "reasoning.completed", providerTurnId: id, reasoningId: `${id}-thinking-1` },
      { type: "reasoning.delta", providerTurnId: id, reasoningId: `${id}-thinking-2`, text: "" },
      { type: "reasoning.completed", providerTurnId: id, reasoningId: `${id}-thinking-2` },
    ]);
    expect(events.at(-1)).toEqual({ type: "turn.completed", providerTurnId: id, status: "completed" });
  });

  it("reports whole thinking blocks when the CLI does not stream them", async () => {
    const { client, peer, events } = await startedClient();
    const turn = await client.sendTurn({ text: "Think" });
    peer.emit({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "First idea." },
          { type: "redacted_thinking", data: "x" },
          { type: "text", text: "Answer" },
        ],
      },
    });
    expect(events.filter((event) => event.type === "reasoning.completed")).toEqual([
      {
        type: "reasoning.completed",
        providerTurnId: turn.providerTurnId,
        reasoningId: `${turn.providerTurnId}-thinking-1`,
        text: "First idea.",
      },
    ]);
  });

  it("uses the assistant message when the CLI does not stream deltas", async () => {
    const { client, peer, events } = await startedClient();
    const turn = await client.sendTurn({ text: "Hi" });
    peer.emit({
      type: "assistant",
      message: { role: "assistant", content: "Hello from Claude" },
    });
    peer.emit({ type: "result", subtype: "success", result: "Hello from Claude" });
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "Hello from Claude" },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "completed" },
    ]);
  });

  it("reports a failed turn without treating the error text as assistant output", async () => {
    const { client, peer, events } = await startedClient();
    const turn = await client.sendTurn({ text: "Hi" });
    peer.emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in" });
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "turn.failed", providerTurnId: turn.providerTurnId, message: "Not logged in" },
    ]);
  });

  it("clears the active turn on interrupt so the next send can start", async () => {
    const { client, peer, events } = await startedClient();
    const turn = await client.sendTurn({ text: "Run tests" });
    await client.interruptTurn(turn.providerTurnId);
    const next = await client.sendTurn({ text: "Continue" });
    expect(JSON.parse(peer.written.at(-2) ?? "{}")).toMatchObject({
      type: "control_request",
      request: { subtype: "interrupt" },
    });
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "interrupted" },
      { type: "turn.started", providerTurnId: next.providerTurnId },
    ]);
  });

  it("denies tool approval without a thread-fatal session error", async () => {
    const { client, peer, events } = await startedClient();
    await client.sendTurn({ text: "Run tests" });
    peer.emit({
      type: "control_request",
      request_id: "req-tool",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } },
    });
    expect(JSON.parse(peer.written.at(-1) ?? "{}")).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-tool",
        response: {
          behavior: "deny",
          message: "Claude Code adapter does not support tool approvals.",
        },
      },
    });
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: expect.any(String) },
      {
        type: "protocol.error",
        message: "Claude Code requested tool approval, which this adapter does not support.",
      },
    ]);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
  });

  it("fails the active turn when the CLI process closes", async () => {
    const { client, peer, events } = await startedClient();
    const turn = await client.sendTurn({ text: "Run tests" });
    peer.die(new Error("Claude Code CLI exited (1)."));
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "turn.failed", providerTurnId: turn.providerTurnId, message: "Claude Code CLI exited (1)." },
      { type: "session.closed", reason: "Claude Code CLI exited (1)." },
    ]);
  });

  it("switches models with set_model before the turn and rejects a second turn while one is still running", async () => {
    const { client, peer } = await startedClient();
    await client.sendTurn({ text: "Hi", model: "opus" });
    expect(JSON.parse(peer.written[1] ?? "{}")).toMatchObject({
      type: "control_request",
      request: { subtype: "set_model", model: "opus" },
    });
    expect(JSON.parse(peer.written[2] ?? "{}")).toMatchObject({ type: "user", message: { content: "Hi" } });
    await expect(client.sendTurn({ text: "Again", model: "opus" })).rejects.toMatchObject({
      code: "request_failed",
      message: "Claude Code already has a turn in progress.",
    });
    expect(peer.written).toHaveLength(3);
  });

  it("sets the reasoning level only when it changes and clears it for a turn without one", async () => {
    const { client, peer } = await startedClient();
    await client.sendTurn({ text: "Hi", reasoningEffort: "max" });
    expect(JSON.parse(peer.written[1] ?? "{}")).toMatchObject({
      type: "control_request",
      request: { subtype: "apply_flag_settings", settings: { effortLevel: "max" } },
    });
    peer.emit({ type: "result", subtype: "success", result: "ok" });
    await client.sendTurn({ text: "Same", reasoningEffort: "max" });
    expect(JSON.parse(peer.written[3] ?? "{}")).toMatchObject({ type: "user", message: { content: "Same" } });
    peer.emit({ type: "result", subtype: "success", result: "ok" });
    await client.sendTurn({ text: "Default" });
    expect(JSON.parse(peer.written[4] ?? "{}")).toMatchObject({
      request: { subtype: "apply_flag_settings", settings: { effortLevel: null } },
    });
    expect(peer.written).toHaveLength(6);
  });

  it("starts on the initialize reply, because the CLI prints its init record only after the first message", async () => {
    const peer = new FakePeer();
    const pending = ClaudeCodeClient.start({ peer, cwd: "/work/tree", initTimeoutMs: 1_000 });
    peer.emit(JSON.parse(initializeReply(peer.written)));
    const client = await pending;
    const events: ClaudeProviderEvent[] = [];
    client.subscribe((event) => events.push(event));
    expect(client.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

    await client.sendTurn({ text: "Hi" });
    expect(JSON.parse(peer.written.at(-1) ?? "{}")).toMatchObject({ type: "user", session_id: client.sessionId });
    peer.emit({ type: "system", subtype: "init", session_id: client.sessionId });
    expect(events).toEqual([{ type: "turn.started", providerTurnId: expect.any(String) }]);
  });

  it("does not hang when session init never arrives", async () => {
    const peer = new FakePeer();
    const started = Date.now();
    await expect(ClaudeCodeClient.start({ peer, cwd: "/work/tree", initTimeoutMs: 30 })).rejects.toMatchObject({
      code: "request_failed",
      message: "Claude Code CLI did not start a session.",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(peer.closed).toBe(true);
  });

  it("rejects a session init that has no session id and ignores malformed noise afterward", async () => {
    const peer = new FakePeer();
    const pending = ClaudeCodeClient.start({ peer, cwd: "/work/tree", initTimeoutMs: 1_000 });
    const initRequest = JSON.parse(peer.written[0] ?? "{}") as { request_id?: string };
    peer.emit({
      type: "control_response",
      response: { subtype: "error", request_id: initRequest.request_id, error: "bad handshake" },
    });
    await expect(pending).rejects.toMatchObject({
      code: "request_failed",
      message: "bad handshake",
    });

    const session = await startedClient();
    session.peer.emit("not-json");
    session.peer.emit({ type: "system", subtype: "init" });
    session.peer.emit({ type: "rate_limit_event", status: "ok" });
    expect(session.events).toEqual([
      { type: "protocol.error", message: "Malformed Claude Code message." },
      { type: "protocol.error", message: "Malformed Claude Code message." },
    ]);
  });

  it("names ZLI as the entrypoint over an inherited one and keeps the user's tool search choice", async () => {
    const saved = { entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT, toolSearch: process.env.ENABLE_TOOL_SEARCH };
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    process.env.ENABLE_TOOL_SEARCH = "false";
    const envFor = async (env?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> => {
      const child = new FakeProcess();
      let spawned: NodeJS.ProcessEnv = {};
      const pending = ClaudeCodeClient.start({
        command: "/usr/bin/claude",
        cwd: "/work/tree",
        ...(env ? { env } : {}),
        spawnProcess: (_command, _args, options) => {
          spawned = options.env;
          return child;
        },
      });
      child.stdout.emit("data", initializeReply(child.written));
      await (await pending).close();
      return spawned;
    };
    try {
      const inherited = await envFor();
      expect(inherited.CLAUDE_CODE_ENTRYPOINT).toBe("zli");
      expect(inherited.ENABLE_TOOL_SEARCH).toBe("false");
      const chosen = await envFor({ CLAUDE_CODE_ENTRYPOINT: "custom", ENABLE_TOOL_SEARCH: "auto" });
      expect(chosen.CLAUDE_CODE_ENTRYPOINT).toBe("custom");
      expect(chosen.ENABLE_TOOL_SEARCH).toBe("auto");
    } finally {
      for (const [name, value] of [
        ["CLAUDE_CODE_ENTRYPOINT", saved.entrypoint],
        ["ENABLE_TOOL_SEARCH", saved.toolSearch],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("spawns the documented session args in the worktree and frames split stdout", async () => {
    const child = new FakeProcess();
    const calls: ClaudeSpawnOptions[] = [];
    let command = "";
    let args: readonly string[] = [];
    const pending = ClaudeCodeClient.start({
      command: "/usr/bin/claude",
      cwd: "/work/tree",
      env: { CLAUDECODE: "1", PATH: "/usr/bin" },
      spawnProcess: (spawnedCommand, spawnedArgs, options) => {
        command = spawnedCommand;
        args = spawnedArgs;
        calls.push(options);
        return child;
      },
    });
    const reply = initializeReply(child.written);
    child.stdout.emit("data", reply.slice(0, 20));
    child.stdout.emit("data", `${reply.slice(20, -1)}\r\n`);
    child.stderr.emit("data", "debug line\n");
    const client = await pending;
    const events: ClaudeProviderEvent[] = [];
    client.subscribe((event) => events.push(event));
    const turn = await client.sendTurn({ text: "Hello" });
    child.stdout.emit("data", line({ type: "result", subtype: "success", result: "Hi" }));

    expect(command).toBe("/usr/bin/claude");
    expect(args[0]).toBe("-p");
    expect(args).toContain("-p");
    expect(args).toEqual([...CLAUDE_SESSION_ARGS, "--session-id", client.sessionId]);
    expect(calls[0]).toMatchObject({ cwd: "/work/tree", shell: false, windowsHide: true });
    expect(calls[0]?.env.PWD).toBe("/work/tree");
    expect(calls[0]?.env.CLAUDECODE).toBeUndefined();
    expect(calls[0]?.env.PATH).toBe("/usr/bin");
    expect(calls[0]?.env.CLAUDE_CODE_ENTRYPOINT).toBe("zli");
    expect(calls[0]?.env.ENABLE_TOOL_SEARCH).toBe("true");
    // A new conversation has nothing to resume, so MCP servers keep connecting in the background.
    expect(calls[0]?.env.MCP_CONNECTION_NONBLOCKING).toBe(process.env.MCP_CONNECTION_NONBLOCKING);
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "Hi" },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "completed" },
    ]);
    child.fail(new Error("Claude Code CLI exited (1)."));
    expect(events.at(-1)).toEqual({ type: "session.closed", reason: "Claude Code CLI exited (1)." });
  });

  it("fails fast with a typed error when the Claude CLI path does not exist", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "zli-claude-"));
    const started = Date.now();
    await expect(
      ClaudeCodeClient.start({
        command: join(cwd, "missing-claude"),
        cwd,
        initTimeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({
      code: "cli_missing",
      message: `Claude Code CLI was not found at ${join(cwd, "missing-claude")}.`,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("fails fast when a PATH command cannot be spawned", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "zli-claude-"));
    const started = Date.now();
    await expect(
      ClaudeCodeClient.start({
        command: "claude-zli-not-installed-4409",
        cwd,
        initTimeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({
      code: "cli_missing",
      message: "Claude Code CLI was not found at claude-zli-not-installed-4409.",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reports a missing worktree without blaming the CLI", async () => {
    const cwd = join(mkdtempSync(join(tmpdir(), "zli-claude-")), "missing-tree");
    await expect(
      ClaudeCodeClient.start({ command: join(cwd, "claude"), cwd, initTimeoutMs: 1_000 }),
    ).rejects.toMatchObject({
      code: "request_failed",
      message: `Claude Code working directory does not exist: ${cwd}.`,
    });
  });
});

describe("ClaudeCodeClient tool activity and supervised approvals", () => {
  it("reports tool_use blocks as running and tool_result blocks as completed or failed", async () => {
    const { client, peer, events } = await startedClient();
    const turn = await client.sendTurn({ text: "Run the tests" });
    peer.emit({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Running tests." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test", description: "Run tests" } },
        ],
      },
    });
    peer.emit({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "1 failed", is_error: true }],
      },
    });
    peer.emit({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/work/tree/src/app.ts" } }],
      },
    });
    peer.emit({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "export {}" }] }],
      },
    });
    peer.emit({
      type: "assistant",
      parent_tool_use_id: "toolu_task",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_sub", name: "Grep", input: {} }] },
    });
    peer.emit({ type: "user", message: { role: "user", content: [{ type: "tool_result" }] } });

    expect(events.filter((event) => event.type === "tool.updated")).toEqual([
      {
        type: "tool.updated",
        providerTurnId: turn.providerTurnId,
        tool: {
          callId: "toolu_1",
          name: "Bash",
          input: { command: "npm test", description: "Run tests" },
          status: "running",
        },
      },
      {
        type: "tool.updated",
        providerTurnId: turn.providerTurnId,
        tool: {
          callId: "toolu_1",
          name: "Bash",
          input: { command: "npm test", description: "Run tests" },
          status: "failed",
          output: "1 failed",
        },
      },
      {
        type: "tool.updated",
        providerTurnId: turn.providerTurnId,
        tool: { callId: "toolu_2", name: "Read", input: { file_path: "/work/tree/src/app.ts" }, status: "running" },
      },
      {
        type: "tool.updated",
        providerTurnId: turn.providerTurnId,
        tool: {
          callId: "toolu_2",
          name: "Read",
          input: { file_path: "/work/tree/src/app.ts" },
          status: "completed",
          output: "export {}",
        },
      },
    ]);
  });

  it("starts read-only sessions in plan mode with stdio prompts", () => {
    expect(claudeSessionArgs({ permissionMode: "read-only" }).slice(-4)).toEqual([
      "--permission-mode",
      "plan",
      "--permission-prompt-tool",
      "stdio",
    ]);
  });

  it("starts supervised sessions accepting edits with stdio prompts and the chosen model", async () => {
    const child = new FakeProcess();
    let args: readonly string[] = [];
    const pending = ClaudeCodeClient.start({
      command: "/usr/bin/claude",
      cwd: "/work/tree",
      permissionMode: "supervised",
      model: "sonnet",
      spawnProcess: (_command, spawnedArgs) => {
        args = spawnedArgs;
        return child;
      },
    });
    child.stdout.emit("data", initializeReply(child.written));
    const client = await pending;
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--thinking",
      "adaptive",
      "--thinking-display",
      "summarized",
      "--permission-mode",
      "acceptEdits",
      "--permission-prompt-tool",
      "stdio",
      "--model",
      "sonnet",
      "--session-id",
      client.sessionId,
    ]);
  });

  it("names the session, sets auto-compact and ZLI's instructions, and waits for MCP servers on resume", async () => {
    const child = new FakeProcess();
    let args: readonly string[] = [];
    let env: NodeJS.ProcessEnv = {};
    const saved = process.env.MCP_CONNECTION_NONBLOCKING;
    delete process.env.MCP_CONNECTION_NONBLOCKING;
    try {
      const pending = ClaudeCodeClient.start({
        command: "/usr/bin/claude",
        cwd: "/work/tree",
        resumeSessionId: "sess-old",
        name: "Fix login",
        autoCompactTokens: 200_000,
        appendSystemPromptFile: "/data/instructions/claude-zli-instructions.md",
        mcpConfig: "/data/mcp/claude.json",
        spawnProcess: (_command, spawnedArgs, options) => {
          args = spawnedArgs;
          env = options.env;
          return child;
        },
      });
      child.stdout.emit("data", initializeReply(child.written));
      await (await pending).close();
    } finally {
      if (saved === undefined) delete process.env.MCP_CONNECTION_NONBLOCKING;
      else process.env.MCP_CONNECTION_NONBLOCKING = saved;
    }
    expect(args.slice(-10)).toEqual([
      "--resume",
      "sess-old",
      "--name",
      "Fix login",
      "--autocompact",
      "200000",
      "--append-system-prompt-file",
      "/data/instructions/claude-zli-instructions.md",
      "--mcp-config",
      "/data/mcp/claude.json",
    ]);
    expect(env.MCP_CONNECTION_NONBLOCKING).toBe("0");
  });

  it("adds a per-session MCP config last, after the other flags", async () => {
    const child = new FakeProcess();
    let args: readonly string[] = [];
    const pending = ClaudeCodeClient.start({
      command: "/usr/bin/claude",
      cwd: "/work/tree",
      model: "sonnet",
      mcpConfig: "/data/mcp/claude-wt.json",
      spawnProcess: (_command, spawnedArgs) => {
        args = spawnedArgs;
        return child;
      },
    });
    child.stdout.emit("data", initializeReply(child.written));
    const client = await pending;
    expect(args.slice(-6)).toEqual([
      "--model",
      "sonnet",
      "--session-id",
      client.sessionId,
      "--mcp-config",
      "/data/mcp/claude-wt.json",
    ]);
    expect(args).toContain("bypassPermissions");
  });

  it("surfaces can_use_tool as an approval and answers allow or deny", async () => {
    const peer = new FakePeer();
    const pending = ClaudeCodeClient.start({ peer, cwd: "/work/tree", permissionMode: "supervised" });
    peer.emit({ type: "system", subtype: "init", session_id: "sess-a" });
    const client = await pending;
    const events: ClaudeProviderEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.sendTurn({ text: "Clean up" });
    peer.emit({
      type: "control_request",
      request_id: "req-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf dist" },
        tool_use_id: "toolu_9",
      },
    });
    peer.emit({
      type: "control_request",
      request_id: "req-2",
      request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "a.txt" } },
    });
    expect(events.filter((event) => event.type === "approval.requested")).toEqual([
      {
        type: "approval.requested",
        requestId: "req-1",
        payload: { toolName: "Bash", input: { command: "rm -rf dist" }, toolUseId: "toolu_9" },
      },
      { type: "approval.requested", requestId: "req-2", payload: { toolName: "Write", input: { file_path: "a.txt" } } },
    ]);
    await client.respondToApproval("req-1", true);
    await client.respondToApproval("req-2", false);
    expect(peer.written.slice(-2).map((entry) => JSON.parse(entry))).toEqual([
      {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "req-1",
          response: { behavior: "allow", updatedInput: { command: "rm -rf dist" } },
        },
      },
      {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "req-2",
          response: { behavior: "deny", message: "The user declined this tool call." },
        },
      },
    ]);
    await expect(client.respondToApproval("req-1", true)).rejects.toMatchObject({ code: "request_failed" });
  });

  it("allows a tool for the rest of the session without asking again", async () => {
    const peer = new FakePeer();
    const pending = ClaudeCodeClient.start({ peer, cwd: "/work/tree", permissionMode: "supervised" });
    peer.emit({ type: "system", subtype: "init", session_id: "sess-s" });
    const client = await pending;
    const events: ClaudeProviderEvent[] = [];
    client.subscribe((event) => events.push(event));
    await client.sendTurn({ text: "Run the tests" });
    const ask = (requestId: string, toolName: string) =>
      peer.emit({
        type: "control_request",
        request_id: requestId,
        request: { subtype: "can_use_tool", tool_name: toolName, input: { command: "pnpm test" } },
      });
    ask("req-1", "Bash");
    await client.respondToApproval("req-1", true, { forSession: true });
    ask("req-2", "Bash");
    ask("req-3", "Write");
    expect(events.filter((event) => event.type === "approval.requested").map((event) => event.requestId)).toEqual([
      "req-1",
      "req-3",
    ]);
    expect(JSON.parse(peer.written.at(-1) ?? "{}")).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-2",
        response: { behavior: "allow", updatedInput: { command: "pnpm test" } },
      },
    });
  });
});

describe("ClaudeCodeClient usage", () => {
  it("reports each turn's tokens and context, and the cost added since the previous turn", async () => {
    const { client, peer, events } = await startedClient();
    const first = await client.sendTurn({ text: "One" });
    peer.emit({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "A" }],
        usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 },
      },
    });
    peer.emit({
      type: "assistant",
      parent_tool_use_id: "toolu_sub",
      message: { role: "assistant", content: [], usage: { input_tokens: 99_999, output_tokens: 1 } },
    });
    peer.emit({
      type: "result",
      subtype: "success",
      result: "A",
      total_cost_usd: 0.05,
      usage: { input_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 1_800, output_tokens: 80 },
      modelUsage: { "claude-sonnet": { contextWindow: 200_000 }, "claude-haiku": { contextWindow: 100_000 } },
    });
    const second = await client.sendTurn({ text: "Two" });
    peer.emit({ type: "result", subtype: "success", result: "B", total_cost_usd: 0.08, usage: { output_tokens: 10 } });

    expect(events.filter((event) => event.type === "usage.updated")).toEqual([
      {
        type: "usage.updated",
        providerTurnId: first.providerTurnId,
        usage: {
          inputTokens: 1_920,
          cachedInputTokens: 1_800,
          outputTokens: 80,
          costUsd: 0.05,
          contextTokens: 1_060,
          contextWindow: 200_000,
        },
      },
      {
        type: "usage.updated",
        providerTurnId: second.providerTurnId,
        usage: { outputTokens: 10, costUsd: expect.closeTo(0.03, 9) },
      },
    ]);
  });

  it("reports when the prompt cache runs out, from the last main request and the tier a request wrote", async () => {
    let clock = 1_000_000;
    const peer = new FakePeer();
    const pending = ClaudeCodeClient.start({ peer, cwd: "/work/tree", now: () => clock });
    peer.emit({ type: "system", subtype: "init", session_id: "sess-1" });
    const client = await pending;
    const events: ClaudeProviderEvent[] = [];
    client.subscribe((event) => events.push(event));
    const messageStart = (cacheCreation: Record<string, number>, parent: string | null = null) => ({
      type: "stream_event",
      parent_tool_use_id: parent,
      event: { type: "message_start", message: { usage: { cache_creation: cacheCreation } } },
    });
    const expiries = () =>
      events.flatMap((event) => (event.type === "usage.updated" ? [event.usage.promptCacheExpiresAt] : []));

    await client.sendTurn({ text: "One" });
    peer.emit(messageStart({ ephemeral_1h_input_tokens: 5_000, ephemeral_5m_input_tokens: 0 }));
    clock += 30_000;
    peer.emit({ type: "result", subtype: "success", result: "A", usage: { output_tokens: 5 } });
    // A read-only request keeps the 1h tier and restarts the clock; a subagent's request does not count.
    await client.sendTurn({ text: "Two" });
    clock += 600_000;
    peer.emit(messageStart({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }));
    clock += 60_000;
    peer.emit(messageStart({ ephemeral_5m_input_tokens: 100 }, "toolu_sub"));
    peer.emit({ type: "result", subtype: "success", result: "B", usage: { output_tokens: 5 } });

    expect(expiries()).toEqual([1_000_000 + 3_600_000, 1_630_000 + 3_600_000]);
  });

  it("fails a turn the usage limit refused and says when the limit resets", async () => {
    const { client, peer, events } = await startedClient();
    await client.sendTurn({ text: "One" });
    peer.emit({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1_800_000_000 },
    });
    peer.emit({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 3pm" });
    expect(events.find((event) => event.type === "turn.failed")).toMatchObject({
      message: "You've hit your limit · resets 3pm",
      usageLimit: { resetsAt: new Date(1_800_000_000_000).toISOString() },
    });
  });

  it("does not treat a limit that extra usage covers, or a later allowed report, as a stop", async () => {
    const { client, peer, events } = await startedClient();
    await client.sendTurn({ text: "One" });
    peer.emit({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 1_800_000_000, overageStatus: "allowed" },
    });
    peer.emit({ type: "result", subtype: "success", result: "A" });
    await client.sendTurn({ text: "Two" });
    peer.emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_800_000_000 } });
    peer.emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
    peer.emit({ type: "result", subtype: "success", result: "B" });
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
  });

  it("reports nothing when a result has no usage", async () => {
    const { client, peer, events } = await startedClient();
    await client.sendTurn({ text: "One" });
    peer.emit({ type: "result", subtype: "success", result: "A" });
    expect(events.some((event) => event.type === "usage.updated")).toBe(false);
  });
});

describe("ClaudeCodeClient resume", () => {
  it("resumes an earlier conversation with --resume placed before the variadic --mcp-config", async () => {
    const child = new FakeProcess();
    let args: readonly string[] = [];
    const pending = ClaudeCodeClient.start({
      command: "/usr/bin/claude",
      cwd: "/work/tree",
      model: "sonnet",
      resumeSessionId: " sess-old ",
      mcpConfig: "/data/mcp/claude-wt.json",
      spawnProcess: (_command, spawnedArgs) => {
        args = spawnedArgs;
        return child;
      },
    });
    child.stdout.emit("data", initializeReply(child.written));
    const client = await pending;
    expect(args).not.toContain("--session-id");
    expect(args.slice(-6)).toEqual([
      "--model",
      "sonnet",
      "--resume",
      "sess-old",
      "--mcp-config",
      "/data/mcp/claude-wt.json",
    ]);
    expect(client.sessionId).toBe("sess-old");
  });

  it("passes its own --session-id instead of --resume for a new conversation", async () => {
    const child = new FakeProcess();
    let args: readonly string[] = [];
    const pending = ClaudeCodeClient.start({
      command: "/usr/bin/claude",
      cwd: "/work/tree",
      resumeSessionId: "  ",
      mcpConfig: "/data/mcp/claude-wt.json",
      spawnProcess: (_command, spawnedArgs) => {
        args = spawnedArgs;
        return child;
      },
    });
    child.stdout.emit("data", initializeReply(child.written));
    const client = await pending;
    expect(args).not.toContain("--resume");
    expect(args[args.indexOf("--session-id") + 1]).toBe(client.sessionId);
  });

  it("reports a changed conversation id from a later init and sends turns under it", async () => {
    const { client, peer, events } = await startedClient();
    expect(client.sessionId).toBe("sess-1");
    peer.emit({ type: "system", subtype: "init", session_id: "sess-1" });
    peer.emit({ type: "system", subtype: "init", session_id: "sess-2" });
    expect(events).toEqual([{ type: "session.identified", sessionId: "sess-2" }]);
    expect(client.sessionId).toBe("sess-2");
    await client.sendTurn({ text: "Continue" });
    expect(JSON.parse(peer.written.at(-1) ?? "{}")).toMatchObject({ type: "user", session_id: "sess-2" });
  });

  it("does not replay history the CLI prints before the first turn", async () => {
    const { client, peer, events } = await startedClient();
    peer.emit({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Old reply" },
          { type: "tool_use", id: "toolu_old", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    peer.emit({ type: "result", subtype: "success", result: "Old reply", total_cost_usd: 0.5 });
    expect(events).toEqual([]);
    expect(client.transcript()).toEqual([]);
  });

  it("fails to start when the CLI cannot find the conversation to resume", async () => {
    const child = new FakeProcess();
    const pending = ClaudeCodeClient.start({
      command: "/usr/bin/claude",
      cwd: "/work/tree",
      resumeSessionId: "sess-gone",
      spawnProcess: () => child,
    });
    child.stderr.emit("data", "No conversation found with session ID: sess-gone\n");
    child.exit(1);
    await expect(pending).rejects.toMatchObject({
      code: "request_failed",
      message:
        "Claude Code CLI exited before the session started: Claude Code CLI exited (1): No conversation found with session ID: sess-gone",
    });
  });
});
