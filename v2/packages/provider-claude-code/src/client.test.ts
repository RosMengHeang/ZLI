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
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
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
    child.stdout.emit("data", '{"type":"system","subtype":"init",');
    child.stdout.emit("data", '"session_id":"sess-9"}\r\n');
    child.stderr.emit("data", "debug line\n");
    const client = await pending;
    const events: ClaudeProviderEvent[] = [];
    client.subscribe((event) => events.push(event));
    const turn = await client.sendTurn({ text: "Hello" });
    child.stdout.emit("data", line({ type: "result", subtype: "success", result: "Hi" }));

    expect(command).toBe("/usr/bin/claude");
    expect(args[0]).toBe("-p");
    expect(args).toContain("-p");
    expect(args).toEqual(CLAUDE_SESSION_ARGS);
    expect(calls[0]).toMatchObject({ cwd: "/work/tree", shell: false, windowsHide: true });
    expect(calls[0]?.env.PWD).toBe("/work/tree");
    expect(calls[0]?.env.CLAUDECODE).toBeUndefined();
    expect(calls[0]?.env.PATH).toBe("/usr/bin");
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
    child.stdout.emit("data", line({ type: "system", subtype: "init", session_id: "sess-s" }));
    await pending;
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "acceptEdits",
      "--permission-prompt-tool",
      "stdio",
      "--model",
      "sonnet",
    ]);
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
    child.stdout.emit("data", line({ type: "system", subtype: "init", session_id: "sess-m" }));
    await pending;
    expect(args.slice(-4)).toEqual(["--model", "sonnet", "--mcp-config", "/data/mcp/claude-wt.json"]);
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

  it("reports nothing when a result has no usage", async () => {
    const { client, peer, events } = await startedClient();
    await client.sendTurn({ text: "One" });
    peer.emit({ type: "result", subtype: "success", result: "A" });
    expect(events.some((event) => event.type === "usage.updated")).toBe(false);
  });
});
