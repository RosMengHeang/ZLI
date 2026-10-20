import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DroidClient, type DroidChild, type DroidProviderEvent, type DroidSpawnOptions } from "./client.js";

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

  it("rejects in-session model switches and a second turn while one is still running", async () => {
    const { client, calls } = await harness();
    await expect(client.sendTurn({ text: "Hi", model: "gpt-5" })).rejects.toMatchObject({
      code: "unsupported",
      message: "Droid CLI adapter does not switch models in a session.",
    });
    await client.sendTurn({ text: "Hi" });
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
