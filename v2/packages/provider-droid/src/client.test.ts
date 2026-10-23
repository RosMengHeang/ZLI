import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type DroidChild, DroidClient, type DroidProviderEvent, type DroidSpawnOptions } from "./client.js";
import { droidTurnArgs } from "./protocol.js";

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

class FakeProcess implements DroidChild {
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
  client: DroidClient;
  children: FakeProcess[];
  calls: Array<{ command: string; args: readonly string[]; options: DroidSpawnOptions }>;
  events: DroidProviderEvent[];
}> {
  const children: FakeProcess[] = [];
  const calls: Array<{ command: string; args: readonly string[]; options: DroidSpawnOptions }> = [];
  const client = await DroidClient.start({
    command: "/usr/bin/droid",
    cwd: "/work/tree",
    env: { PATH: "/usr/bin" },
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new FakeProcess();
      children.push(child);
      return child;
    },
  });
  const events: DroidProviderEvent[] = [];
  client.subscribe((event) => events.push(event));
  return { client, children, calls, events };
}

const execArgs = ["exec", "-o", "stream-json", "--cwd", "/work/tree", "--skip-permissions-unsafe"];

describe("DroidClient", () => {
  it("runs exec in the worktree, streams one turn, and continues the session id", async () => {
    const { client, children, calls, events } = await harness();
    expect(calls).toHaveLength(0);

    const turn = await client.sendTurn({ text: "Create hello.txt" });
    const child = children[0];
    child?.stdout.emit(
      "data",
      line({ type: "system", subtype: "init", cwd: "/work/tree", session_id: "sess-1", model: "gpt-6-sol" }),
    );
    child?.stdout.emit(
      "data",
      line({ type: "message", role: "user", id: "u1", text: "Create hello.txt", session_id: "sess-1" }),
    );
    child?.stdout.emit("data", line({ type: "reasoning", id: "r1", text: "thinking", session_id: "sess-1" }));
    child?.stdout.emit(
      "data",
      line({ type: "message", role: "assistant", id: "a1", text: "Creating the file.", session_id: "sess-1" }),
    );
    child?.stdout.emit(
      "data",
      line({
        type: "tool_call",
        id: "call-1",
        toolId: "Create",
        toolName: "Create",
        parameters: { file_path: "/work/tree/hello.txt" },
        session_id: "sess-1",
      }),
    );
    child?.stdout.emit(
      "data",
      line({ type: "tool_result", id: "call-1", toolId: "Create", isError: false, value: "ok", session_id: "sess-1" }),
    );
    child?.stdout.emit(
      "data",
      line({ type: "message", role: "assistant", id: "a2", text: "DONE", session_id: "sess-1" }),
    );
    child?.stdout.emit(
      "data",
      line({ type: "completion", finalText: "DONE", numTurns: 2, durationMs: 10, session_id: "sess-1" }),
    );

    expect(calls[0]?.command).toBe("/usr/bin/droid");
    expect(calls[0]?.args).toEqual(execArgs);
    expect(calls[0]?.options).toMatchObject({ cwd: "/work/tree", shell: false, windowsHide: true });
    expect(calls[0]?.options.env.PWD).toBe("/work/tree");
    expect(calls[0]?.options.env.PATH).toBe("/usr/bin");
    expect(child?.written.join("")).toBe("Create hello.txt");
    expect(child?.ended).toBe(true);
    expect(child?.killed).toBe(true);
    expect(turn.providerTurnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "Creating the file." },
      {
        type: "tool.updated",
        providerTurnId: turn.providerTurnId,
        tool: { callId: "call-1", name: "Create", input: { file_path: "/work/tree/hello.txt" }, status: "running" },
      },
      {
        type: "tool.updated",
        providerTurnId: turn.providerTurnId,
        tool: {
          callId: "call-1",
          name: "Create",
          input: { file_path: "/work/tree/hello.txt" },
          status: "completed",
          output: "ok",
        },
      },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "\n\nDONE" },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "completed" },
    ]);
    expect(client.transcript()).toEqual([
      {
        providerTurnId: turn.providerTurnId,
        text: "Creating the file.\n\nDONE",
        status: "completed",
        sessionId: "sess-1",
      },
    ]);

    const next = await client.sendTurn({ text: "Continue" });
    expect(calls[1]?.args).toEqual([...execArgs, "-s", "sess-1"]);
    expect(children[1]?.written.join("")).toBe("Continue");
    expect(events.at(-1)).toEqual({ type: "turn.started", providerTurnId: next.providerTurnId });
  });

  it("uses finalText when no assistant message was streamed", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Hi" });
    children[0]?.stdout.emit("data", line({ type: "completion", finalText: "Hello from Droid", session_id: "s" }));
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "Hello from Droid" },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "completed" },
    ]);
  });

  it("fails the turn on an error record without treating it as assistant output", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Hi" });
    children[0]?.stdout.emit("data", line({ type: "system", subtype: "init", session_id: "sess-e" }));
    children[0]?.stdout.emit("data", line({ type: "error", message: "Not logged in", session_id: "sess-e" }));
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "turn.failed", providerTurnId: turn.providerTurnId, message: "Not logged in" },
    ]);
    expect(children[0]?.killed).toBe(true);
    expect(events.some((event) => event.type === "session.closed")).toBe(false);
  });

  it("fails the turn when completion reports an error", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Hi" });
    children[0]?.stdout.emit("data", line({ type: "completion", isError: true, finalText: "Quota exceeded" }));
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "turn.failed", providerTurnId: turn.providerTurnId, message: "Quota exceeded" },
    ]);
  });

  it("clears the active turn on interrupt so the next send can start", async () => {
    const { client, children, calls, events } = await harness();
    const turn = await client.sendTurn({ text: "Run tests" });
    children[0]?.stdout.emit("data", line({ type: "system", subtype: "init", session_id: "sess-2" }));
    await client.interruptTurn(turn.providerTurnId);
    const next = await client.sendTurn({ text: "Continue" });
    expect(children[0]?.killed).toBe(true);
    expect(calls[1]?.args).toEqual([...execArgs, "-s", "sess-2"]);
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "interrupted" },
      { type: "turn.started", providerTurnId: next.providerTurnId },
    ]);
  });

  it("fails the turn and closes the session when the process exits before a session id exists", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Run tests" });
    children[0]?.stderr.emit("data", "boom\n");
    children[0]?.exit(1);
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "turn.failed", providerTurnId: turn.providerTurnId, message: "Droid CLI exited (1): boom" },
      { type: "session.closed", reason: "Droid CLI exited (1): boom" },
    ]);
    await expect(client.sendTurn({ text: "next" })).rejects.toMatchObject({ code: "closed" });
  });

  it("keeps the session resumable when the process exits after init without a completion", async () => {
    const { client, children, calls, events } = await harness();
    const turn = await client.sendTurn({ text: "Run tests" });
    children[0]?.stdout.emit("data", line({ type: "system", subtype: "init", session_id: "sess-9" }));
    children[0]?.exit(0);
    expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.failed"]);
    expect(events[1]).toMatchObject({ message: "Droid CLI exited (0)." });
    await client.sendTurn({ text: "Retry" });
    expect(calls[1]?.args).toContain("sess-9");
    expect(client.transcript()[0]).toMatchObject({ providerTurnId: turn.providerTurnId, sessionId: "sess-9" });
  });

  it("passes a turn-level model to that run and rejects a second turn while one is still running", async () => {
    const { client, calls } = await harness();
    await client.sendTurn({ text: "Hi", model: "gpt-5" });
    expect(calls[0]?.args).toEqual([...execArgs, "-m", "gpt-5"]);
    await expect(client.sendTurn({ text: "Again" })).rejects.toMatchObject({
      code: "request_failed",
      message: "Droid CLI already has a turn in progress.",
    });
    expect(calls).toHaveLength(1);
  });

  it("reports malformed stream lines without failing the turn", async () => {
    const { client, children, events } = await harness();
    await client.sendTurn({ text: "Hi" });
    children[0]?.stdout.emit("data", "debug line\n");
    children[0]?.stdout.emit("data", "{bad\n");
    children[0]?.stdout.emit("data", line({ type: "system", subtype: "init" }));
    children[0]?.stdout.emit("data", line({ type: "completion", finalText: "ok", session_id: "sess-5" }));
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "protocol.error",
      "protocol.error",
      "assistant.delta",
      "turn.completed",
    ]);
    expect(events[1]).toEqual({ type: "protocol.error", message: "Malformed Droid CLI message." });
    expect(events[2]).toEqual({
      type: "protocol.error",
      message: "Droid CLI session init did not include a session id.",
    });
  });

  it("frames split stdout lines", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Hello" });
    children[0]?.stdout.emit("data", '{"type":"system","subtype":"init",');
    children[0]?.stdout.emit("data", '"session_id":"sess-split"}\r\n');
    children[0]?.stdout.emit("data", line({ type: "completion", finalText: "Hi" }));
    expect(events).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "Hi" },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "completed" },
    ]);
    expect(client.transcript()[0]?.sessionId).toBe("sess-split");
  });

  it("kills the exec process on close", async () => {
    const { client, children } = await harness();
    await client.sendTurn({ text: "Hello" });
    await client.close();
    expect(children[0]?.killed).toBe(true);
    await expect(client.sendTurn({ text: "next" })).rejects.toMatchObject({ code: "closed" });
  });

  it("fails fast with a typed error when the Droid CLI path does not exist", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "zli-droid-"));
    const started = Date.now();
    await expect(DroidClient.start({ command: join(cwd, "missing-droid"), cwd })).rejects.toMatchObject({
      code: "cli_missing",
      message: `Droid CLI was not found at ${join(cwd, "missing-droid")}.`,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("fails fast when a PATH command cannot be spawned", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "zli-droid-"));
    const started = Date.now();
    await expect(DroidClient.start({ command: "droid-zli-not-installed-4409", cwd })).rejects.toMatchObject({
      code: "cli_missing",
      message: "Droid CLI was not found at droid-zli-not-installed-4409.",
    });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reports a missing worktree without blaming the CLI", async () => {
    const cwd = join(mkdtempSync(join(tmpdir(), "zli-droid-")), "missing-tree");
    await expect(DroidClient.start({ command: join(cwd, "droid"), cwd })).rejects.toMatchObject({
      code: "request_failed",
      message: `Droid CLI working directory does not exist: ${cwd}.`,
    });
  });
});

describe("DroidClient tool activity", () => {
  it("pairs captured tool_call and tool_result records by id", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Inspect the folder" });
    const emit = (value: unknown) => children[0]?.stdout.emit("data", line(value));
    const meta = { messageId: "8ac9a63f", timestamp: 1792476710544, session_id: "sess-t" };
    emit({ type: "system", subtype: "init", cwd: "/work/tree", session_id: "sess-t", model: "gpt-6-sol" });
    emit({
      type: "tool_call",
      id: "call_read",
      toolId: "Read",
      toolName: "Read",
      parameters: { file_path: "/work/tree/hello.txt" },
      ...meta,
    });
    emit({
      type: "tool_call",
      id: "call_exec",
      toolId: "Execute",
      toolName: "Execute",
      parameters: { command: "echo zli-check", summary: "Print the requested shell check", riskLevel: "low" },
      ...meta,
    });
    emit({
      type: "tool_result",
      id: "call_read",
      toolId: "Read",
      isError: false,
      value: "hello world\nsecond line\n",
      ...meta,
    });
    emit({
      type: "tool_result",
      id: "call_exec",
      toolId: "Execute",
      isError: false,
      value: "zli-check\r\n\n\n[Process exited with code 0]",
      ...meta,
    });
    emit({
      type: "tool_call",
      id: "call_fail",
      toolId: "Execute",
      toolName: "Execute",
      parameters: { command: "npm test" },
      ...meta,
    });
    emit({
      type: "tool_result",
      id: "call_fail",
      toolId: "Execute",
      isError: false,
      value: "1 failing\n\n[Process exited with code 1]",
      ...meta,
    });
    emit({
      type: "tool_call",
      id: "call_patch",
      toolId: "ApplyPatch",
      toolName: "ApplyPatch",
      parameters: { input: "*** Begin Patch\n*** Add File: /work/tree/note.txt\n+done\n*** End Patch\n" },
      ...meta,
    });
    emit({
      type: "tool_result",
      id: "call_patch",
      toolId: "ApplyPatch",
      isError: false,
      value: { success: true, files: [{ file_path: "/work/tree/note.txt", display_operation: "create" }] },
      ...meta,
    });
    emit({ type: "tool_result", id: "call_unknown", toolId: "Grep", isError: true, value: "boom", ...meta });
    emit({ type: "tool_call", toolName: "Read", ...meta });
    emit({ type: "completion", finalText: "Done.", session_id: "sess-t" });

    const tools = events.flatMap((event) => (event.type === "tool.updated" ? [event] : []));
    expect(tools.every((event) => event.providerTurnId === turn.providerTurnId)).toBe(true);
    expect(tools.map((event) => event.tool)).toEqual([
      { callId: "call_read", name: "Read", input: { file_path: "/work/tree/hello.txt" }, status: "running" },
      {
        callId: "call_exec",
        name: "Execute",
        input: { command: "echo zli-check", summary: "Print the requested shell check", riskLevel: "low" },
        status: "running",
      },
      {
        callId: "call_read",
        name: "Read",
        input: { file_path: "/work/tree/hello.txt" },
        status: "completed",
        output: "hello world\nsecond line\n",
      },
      {
        callId: "call_exec",
        name: "Execute",
        input: { command: "echo zli-check", summary: "Print the requested shell check", riskLevel: "low" },
        status: "completed",
        output: "zli-check\r\n\n\n[Process exited with code 0]",
      },
      { callId: "call_fail", name: "Execute", input: { command: "npm test" }, status: "running" },
      {
        callId: "call_fail",
        name: "Execute",
        input: { command: "npm test" },
        status: "failed",
        output: "1 failing\n\n[Process exited with code 1]",
      },
      {
        callId: "call_patch",
        name: "ApplyPatch",
        input: { input: "*** Begin Patch\n*** Add File: /work/tree/note.txt\n+done\n*** End Patch\n" },
        status: "running",
      },
      {
        callId: "call_patch",
        name: "ApplyPatch",
        input: { input: "*** Begin Patch\n*** Add File: /work/tree/note.txt\n+done\n*** End Patch\n" },
        status: "completed",
        output: '{"success":true,"files":[{"file_path":"/work/tree/note.txt","display_operation":"create"}]}',
      },
      { callId: "call_unknown", name: "Grep", status: "failed", output: "boom" },
    ]);
    expect(events.at(-1)).toEqual({ type: "turn.completed", providerTurnId: turn.providerTurnId, status: "completed" });
  });

  it("runs supervised turns with --auto low and the session model", async () => {
    const calls: Array<readonly string[]> = [];
    const client = await DroidClient.start({
      command: "/usr/bin/droid",
      cwd: "/work/tree",
      permissionMode: "supervised",
      model: "claude-opus-5-5",
      spawnProcess: (_command, args) => {
        calls.push(args);
        return new FakeProcess();
      },
    });
    await client.sendTurn({ text: "Hi" });
    expect(calls[0]).toEqual([
      "exec",
      "-o",
      "stream-json",
      "--cwd",
      "/work/tree",
      "--auto",
      "low",
      "-m",
      "claude-opus-5-5",
    ]);
  });

  it("switches permission mode from the turn that asks and keeps it for later turns", async () => {
    const calls: Array<readonly string[]> = [];
    const client = await DroidClient.start({
      command: "/usr/bin/droid",
      cwd: "/work/tree",
      spawnProcess: (_command, args) => {
        calls.push(args);
        return new FakeProcess();
      },
    });
    await client.sendTurn({ text: "One" });
    await client.interruptTurn();
    await client.sendTurn({ text: "Two", permissionMode: "supervised" });
    await client.interruptTurn();
    await client.sendTurn({ text: "Three" });
    expect(calls.map((args) => args.includes("--skip-permissions-unsafe"))).toEqual([true, false, false]);
    expect(calls.map((args) => args.includes("low"))).toEqual([false, true, true]);
  });
});

describe("DroidClient usage", () => {
  it("reports the completion's token counts for the turn, with cache reads counted as input", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Hi" });
    children[0]?.stdout.emit(
      "data",
      line({
        type: "completion",
        finalText: "Hello",
        session_id: "sess-1",
        usage: {
          input_tokens: 30,
          output_tokens: 12,
          cache_read_input_tokens: 2_000,
          cache_creation_input_tokens: 500,
          factory_credits: 3,
        },
      }),
    );
    expect(events).toContainEqual({
      type: "usage.updated",
      providerTurnId: turn.providerTurnId,
      usage: { inputTokens: 2_530, cachedInputTokens: 2_000, outputTokens: 12 },
    });
  });
});

describe("droidTurnArgs", () => {
  it("passes no autonomy flag in read-only mode, which is exec's read-only default", () => {
    const args = droidTurnArgs({ cwd: "/work/tree", permissionMode: "read-only" });
    expect(args).toEqual(["exec", "-o", "stream-json", "--cwd", "/work/tree"]);
  });
});
