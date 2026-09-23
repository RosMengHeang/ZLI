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
    expect(calls[0]?.args).not.toContain("--force");
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

  it("rejects in-session model switches and a second turn while one is still running", async () => {
    const { client, calls } = await harness();
    await expect(client.sendTurn({ text: "Hi", model: "gpt-5" })).rejects.toMatchObject({
      code: "unsupported",
      message: "Cursor CLI adapter does not switch models in a session.",
    });
    await client.sendTurn({ text: "Hi" });
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
