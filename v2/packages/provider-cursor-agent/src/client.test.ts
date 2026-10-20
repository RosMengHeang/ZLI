import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CursorAgentClient, type CursorChild, type CursorProviderEvent, type CursorSpawnOptions } from "./client.js";
import { CURSOR_TOOL_DENY_MESSAGE } from "./schema.js";

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

class FakeProcess implements CursorChild {
  readonly written: string[] = [];
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  ended = false;
  killed = false;
  private readonly events = new EventEmitter();
  readonly stdin = {
    destroyed: false,
    write: (data: string) => {
      this.written.push(data);
      return true;
    },
    end: () => {
      this.ended = true;
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

  exit(code: number): void {
    this.events.emit("close", code, null);
  }
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function harness(): Promise<{
  client: CursorAgentClient;
  children: FakeProcess[];
  calls: Array<{ command: string; args: readonly string[]; options: CursorSpawnOptions }>;
  events: CursorProviderEvent[];
}> {
  const children: FakeProcess[] = [];
  const calls: Array<{ command: string; args: readonly string[]; options: CursorSpawnOptions }> = [];
  const client = await CursorAgentClient.start({
    command: "/usr/bin/cursor-agent",
    cwd: "/work/tree",
    env: { PATH: "/usr/bin" },
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new FakeProcess();
      children.push(child);
      return child;
    },
  });
  const events: CursorProviderEvent[] = [];
  client.subscribe((event) => events.push(event));
  return { client, children, calls, events };
}

const printArgs = [
  "-p",
  "--output-format",
  "stream-json",
  "--stream-partial-output",
  "--trust",
  "--force",
  "--workspace",
  "/work/tree",
];

describe("CursorAgentClient", () => {
  it("spawns print mode in the worktree, streams one turn, and resumes the chat id", async () => {
    const { client, children, calls, events } = await harness();
    expect(calls).toHaveLength(0);

    const turn = await client.sendTurn({ text: "Fix the bug" });
    const child = children[0];
    expect(child).toBeDefined();
    child?.stdout.emit("data", line({ type: "system", subtype: "init", session_id: "sess-1", cwd: "/work/tree" }));
    child?.stdout.emit(
      "data",
      line({
        type: "user",
        session_id: "sess-1",
        message: { role: "user", content: [{ type: "text", text: "Fix the bug" }] },
      }),
    );
    child?.stdout.emit(
      "data",
      line({
        type: "assistant",
        timestamp_ms: 10,
        session_id: "sess-1",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      }),
    );
    child?.stdout.emit(
      "data",
      line({
        type: "assistant",
        timestamp_ms: 11,
        model_call_id: "call-1",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      }),
    );
    child?.stdout.emit(
      "data",
      line({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      }),
    );
    child?.stdout.emit(
      "data",
      line({ type: "result", subtype: "success", is_error: false, result: "hello", session_id: "sess-1" }),
    );

    expect(calls[0]?.command).toBe("/usr/bin/cursor-agent");
    expect(calls[0]?.args).toEqual(printArgs);
    expect(calls[0]?.args).not.toContain("--worktree");
    expect(calls[0]?.options).toMatchObject({ cwd: "/work/tree", shell: false, windowsHide: true });
    expect(calls[0]?.options.env.PWD).toBe("/work/tree");
    expect(calls[0]?.options.env.PATH).toBe("/usr/bin");
    expect(child?.written.join("")).toBe("Fix the bug");
    expect(child?.ended).toBe(true);
    expect(child?.killed).toBe(true);
    expect(turn.providerTurnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "hello" },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "completed" },
    ]);
    expect(client.transcript()).toEqual([
      { providerTurnId: turn.providerTurnId, text: "hello", status: "completed", sessionId: "sess-1" },
    ]);

    const next = await client.sendTurn({ text: "Continue" });
    expect(calls[1]?.args).toEqual([...printArgs, "--resume", "sess-1"]);
    expect(children[1]?.written.join("")).toBe("Continue");
    expect(events.at(-1)).toEqual({ type: "turn.started", providerTurnId: next.providerTurnId });
  });

  it("uses a full assistant message when the CLI does not stream deltas", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Hi" });
    children[0]?.stdout.emit(
      "data",
      line({ type: "assistant", message: { role: "assistant", content: "Hello from Cursor" } }),
    );
    children[0]?.stdout.emit("data", line({ type: "result", subtype: "success", result: "Hello from Cursor" }));
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "Hello from Cursor" },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "completed" },
    ]);
  });

  it("reports a failed turn without treating the error text as assistant output", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Hi" });
    children[0]?.stdout.emit(
      "data",
      line({ type: "result", subtype: "error_during_execution", is_error: true, result: "Not logged in" }),
    );
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "turn.failed", providerTurnId: turn.providerTurnId, message: "Not logged in" },
    ]);
    expect(events.some((event) => event.type === "session.closed")).toBe(false);
  });

  it("clears the active turn on interrupt so the next send can start", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Run tests" });
    children[0]?.stdout.emit("data", line({ type: "system", subtype: "init", session_id: "sess-2" }));
    await client.interruptTurn(turn.providerTurnId);
    const next = await client.sendTurn({ text: "Continue" });
    expect(children[0]?.killed).toBe(true);
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "interrupted" },
      { type: "turn.started", providerTurnId: next.providerTurnId },
    ]);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
  });

  it("keeps a tool denial off the failed-turn path", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Run tests" });
    children[0]?.stdout.emit(
      "data",
      line({
        type: "tool_call",
        subtype: "completed",
        call_id: "call-1",
        session_id: "sess-3",
        tool_call: { shellToolCall: { result: { rejected: { reason: "not allowed" } } } },
      }),
    );
    children[0]?.stdout.emit(
      "data",
      line({
        type: "control_request",
        request_id: "req-tool",
        request: { subtype: "can_use_tool", tool_name: "Shell" },
      }),
    );
    children[0]?.stdout.emit(
      "data",
      line({ type: "result", subtype: "success", result: "Stopped before the command." }),
    );
    expect(children[0]?.written.join("")).toBe("Run tests");
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      {
        type: "tool.updated",
        providerTurnId: turn.providerTurnId,
        tool: { callId: "call-1", name: "shell", status: "failed", output: "not allowed" },
      },
      { type: "protocol.error", message: CURSOR_TOOL_DENY_MESSAGE },
      { type: "protocol.error", message: CURSOR_TOOL_DENY_MESSAGE },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "Stopped before the command." },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "completed" },
    ]);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
  });

  it("ends a denied turn without failing it when the process exits before a result", async () => {
    const { client, children, calls, events } = await harness();
    const turn = await client.sendTurn({ text: "Run tests" });
    children[0]?.stdout.emit(
      "data",
      line({
        type: "tool_call",
        subtype: "completed",
        session_id: "sess-4",
        tool_call: { writeToolCall: { result: { permissionDenied: true } } },
      }),
    );
    children[0]?.exit(1);
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "protocol.error", message: CURSOR_TOOL_DENY_MESSAGE },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "denied" },
    ]);
    const next = await client.sendTurn({ text: "Continue" });
    expect(calls[1]?.args).toEqual([...printArgs, "--resume", "sess-4"]);
    expect(next.providerTurnId).not.toBe(turn.providerTurnId);
  });

  it("fails the active turn when the process closes before a chat id exists", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Run tests" });
    children[0]?.stderr.emit("data", "boom\n");
    children[0]?.exit(1);
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "turn.failed", providerTurnId: turn.providerTurnId, message: "Cursor CLI exited (1): boom" },
      { type: "session.closed", reason: "Cursor CLI exited (1): boom" },
    ]);
    await expect(client.sendTurn({ text: "next" })).rejects.toMatchObject({ code: "closed" });
  });

  it("keeps the chat resumable when the process dies after init", async () => {
    const { client, children, calls, events } = await harness();
    const turn = await client.sendTurn({ text: "Run tests" });
    children[0]?.stdout.emit("data", line({ type: "system", subtype: "init", session_id: "sess-9" }));
    children[0]?.exit(1);
    expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.failed"]);
    expect(events.some((event) => event.type === "session.closed")).toBe(false);
    await client.sendTurn({ text: "Retry" });
    expect(calls[1]?.args).toContain("sess-9");
    expect(client.transcript()[0]).toMatchObject({ providerTurnId: turn.providerTurnId, sessionId: "sess-9" });
  });

  it("passes a turn-level model to that run and rejects a second turn while one is still running", async () => {
    const { client, calls } = await harness();
    await client.sendTurn({ text: "Hi", model: "gpt-5" });
    expect(calls[0]?.args).toEqual([...printArgs, "--model", "gpt-5"]);
    await expect(client.sendTurn({ text: "Again" })).rejects.toMatchObject({
      code: "request_failed",
      message: "Cursor CLI already has a turn in progress.",
    });
    expect(calls).toHaveLength(1);
  });

  it("reports malformed stream lines without failing the turn", async () => {
    const { client, children, events } = await harness();
    await client.sendTurn({ text: "Hi" });
    children[0]?.stdout.emit("data", "debug line\n");
    children[0]?.stdout.emit("data", "{bad\n");
    children[0]?.stdout.emit("data", line({ type: "system", subtype: "init" }));
    children[0]?.stdout.emit("data", line({ type: "result", subtype: "success", result: "ok", session_id: "sess-5" }));
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "protocol.error",
      "protocol.error",
      "assistant.delta",
      "turn.completed",
    ]);
    expect(events[1]).toEqual({ type: "protocol.error", message: "Malformed Cursor CLI message." });
    expect(events[2]).toEqual({
      type: "protocol.error",
      message: "Cursor CLI session init did not include a session id.",
    });
  });

  it("frames split stdout in the worktree process", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Hello" });
    children[0]?.stdout.emit("data", '{"type":"system","subtype":"init",');
    children[0]?.stdout.emit("data", '"session_id":"sess-split"}\r\n');
    children[0]?.stdout.emit("data", line({ type: "result", subtype: "success", result: "Hi" }));
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "Hi" },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "completed" },
    ]);
    expect(client.transcript()[0]?.sessionId).toBe("sess-split");
  });

  it("kills the print process on close", async () => {
    const { client, children } = await harness();
    await client.sendTurn({ text: "Hello" });
    await client.close();
    expect(children[0]?.killed).toBe(true);
    await expect(client.sendTurn({ text: "next" })).rejects.toMatchObject({ code: "closed" });
  });

  it("fails fast with a typed error when the Cursor CLI path does not exist", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "zli-cursor-"));
    const started = Date.now();
    await expect(CursorAgentClient.start({ command: join(cwd, "missing-cursor"), cwd })).rejects.toMatchObject({
      code: "cli_missing",
      message: `Cursor CLI was not found at ${join(cwd, "missing-cursor")}.`,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("fails fast when a PATH command cannot be spawned", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "zli-cursor-"));
    const started = Date.now();
    await expect(CursorAgentClient.start({ command: "cursor-zli-not-installed-4409", cwd })).rejects.toMatchObject({
      code: "cli_missing",
      message: "Cursor CLI was not found at cursor-zli-not-installed-4409.",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reports a missing worktree without blaming the CLI", async () => {
    const cwd = join(mkdtempSync(join(tmpdir(), "zli-cursor-")), "missing-tree");
    await expect(CursorAgentClient.start({ command: join(cwd, "cursor-agent"), cwd })).rejects.toMatchObject({
      code: "request_failed",
      message: `Cursor CLI working directory does not exist: ${cwd}.`,
    });
  });
});

describe("CursorAgentClient tool activity", () => {
  const callId = (n: number) =>
    `call-48ad3baf-334e-4318-ac75-3b1d0cedbbab-${n}\nfc_7aa138f8-7499-9a65-a906-5ed0c230005b_${n}`;
  const meta = { model_call_id: "1dc1b358-0-6r1m", session_id: "sess-t", timestamp_ms: 1792476739533 };

  it("maps captured started/completed tool_call records onto one update per call id", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Inspect the folder" });
    const child = children[0];
    const emit = (value: unknown) => child?.stdout.emit("data", line(value));
    emit({ type: "system", subtype: "init", session_id: "sess-t", permissionMode: "default" });
    emit({
      type: "tool_call",
      subtype: "started",
      call_id: callId(0),
      tool_call: {
        readToolCall: { args: { path: "/work/tree/hello.txt" } },
        hookAdditionalContexts: [],
        toolCallId: callId(0),
        startedAtMs: "1792476740514",
      },
      ...meta,
    });
    emit({
      type: "tool_call",
      subtype: "started",
      call_id: callId(1),
      tool_call: {
        shellToolCall: {
          args: { command: "echo zli-check", workingDirectory: "", timeout: 30000, description: "Echo zli-check" },
          description: "Echo zli-check",
        },
        toolCallId: callId(1),
      },
      ...meta,
    });
    emit({
      type: "tool_call",
      subtype: "completed",
      call_id: callId(2),
      tool_call: {
        grepToolCall: {
          args: { pattern: "second", path: "/work/tree", outputMode: "content" },
          result: {
            success: {
              pattern: "second",
              path: "/work/tree",
              workspaceResults: {
                "/work/tree": {
                  content: {
                    matches: [{ file: "./hello.txt", matches: [{ lineNumber: 2, content: "second line" }] }],
                    totalLines: 1,
                  },
                },
              },
            },
          },
        },
        toolCallId: callId(2),
      },
      ...meta,
    });
    emit({
      type: "tool_call",
      subtype: "completed",
      call_id: callId(0),
      tool_call: {
        readToolCall: {
          args: { path: "/work/tree/hello.txt" },
          result: { success: { content: "hello world\nsecond line\n", totalLines: 2 } },
        },
        toolCallId: callId(0),
      },
      ...meta,
    });
    emit({
      type: "tool_call",
      subtype: "completed",
      call_id: callId(1),
      tool_call: {
        shellToolCall: {
          args: { command: "echo zli-check" },
          result: {
            success: {
              command: "echo zli-check",
              exitCode: 0,
              stdout: "zli-check\r\n",
              interleavedOutput: "zli-check\r\n",
            },
          },
        },
        toolCallId: callId(1),
      },
      ...meta,
    });
    emit({
      type: "tool_call",
      subtype: "completed",
      call_id: callId(3),
      tool_call: {
        shellToolCall: {
          args: { command: "npm test" },
          result: { success: { command: "npm test", exitCode: 1, stdout: "", stderr: "1 failing" } },
        },
      },
      ...meta,
    });
    emit({
      type: "tool_call",
      subtype: "completed",
      call_id: callId(4),
      tool_call: {
        editToolCall: {
          args: { path: "/work/tree/note.txt", streamContent: "done" },
          result: { success: { path: "/work/tree/note.txt", linesAdded: 1, message: "Wrote contents" } },
        },
      },
      ...meta,
    });
    emit({ type: "tool_call", subtype: "started", call_id: "call-x", tool_call: "not an object", ...meta });
    emit({ type: "result", subtype: "success", is_error: false, result: "Done." });

    const tools = events.flatMap((event) => (event.type === "tool.updated" ? [event] : []));
    expect(tools.every((event) => event.providerTurnId === turn.providerTurnId)).toBe(true);
    expect(tools.map((event) => event.tool)).toEqual([
      { callId: callId(0), name: "read", input: { path: "/work/tree/hello.txt" }, status: "running" },
      {
        callId: callId(1),
        name: "shell",
        input: { command: "echo zli-check", workingDirectory: "", timeout: 30000, description: "Echo zli-check" },
        status: "running",
      },
      {
        callId: callId(2),
        name: "grep",
        input: { pattern: "second", path: "/work/tree", outputMode: "content" },
        status: "completed",
        output: "./hello.txt:2: second line",
      },
      { callId: callId(0), name: "read", input: { path: "/work/tree/hello.txt" }, status: "completed" },
      {
        callId: callId(1),
        name: "shell",
        input: { command: "echo zli-check" },
        status: "completed",
        output: "zli-check\r\n",
      },
      { callId: callId(3), name: "shell", input: { command: "npm test" }, status: "failed", output: "1 failing" },
      {
        callId: callId(4),
        name: "edit",
        input: { path: "/work/tree/note.txt", streamContent: "done" },
        status: "completed",
        output: "Wrote contents",
      },
    ]);
    expect(events.at(-1)).toEqual({ type: "turn.completed", providerTurnId: turn.providerTurnId, status: "completed" });
  });

  it("omits --force when supervised and passes the session model on every turn", async () => {
    const calls: Array<readonly string[]> = [];
    const client = await CursorAgentClient.start({
      command: "/usr/bin/cursor-agent",
      cwd: "/work/tree",
      permissionMode: "supervised",
      model: "gpt-5.2",
      spawnProcess: (_command, args) => {
        calls.push(args);
        return new FakeProcess();
      },
    });
    await client.sendTurn({ text: "Hi" });
    expect(calls[0]).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--trust",
      "--workspace",
      "/work/tree",
      "--model",
      "gpt-5.2",
    ]);
  });

  it("approves configured MCP servers when asked, so print mode does not stall on the prompt", async () => {
    const calls: Array<readonly string[]> = [];
    const client = await CursorAgentClient.start({
      command: "/usr/bin/cursor-agent",
      cwd: "/work/tree",
      approveMcps: true,
      spawnProcess: (_command, args) => {
        calls.push(args);
        return new FakeProcess();
      },
    });
    await client.sendTurn({ text: "Hi" });
    expect(calls[0]).toEqual([...printArgs.slice(0, 6), "--approve-mcps", ...printArgs.slice(6)]);
  });
});
