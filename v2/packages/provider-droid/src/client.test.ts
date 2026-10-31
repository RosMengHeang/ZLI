import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type DroidChild, DroidClient, type DroidProviderEvent, type DroidSpawnOptions } from "./client.js";
import { droidArgs, droidSessionSettings } from "./protocol.js";

type Json = Record<string, unknown>;
type Handler = (params: Json) => Json | { error: { code: number; message: string } } | undefined;

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

const MODELS = [
  { id: "gpt-6-sol", defaultReasoningEffort: "medium" },
  { id: "claude-opus-5-5", defaultReasoningEffort: "medium" },
];

class FakeProcess implements DroidChild {
  readonly written: string[] = [];
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  killed = false;
  sessionId = "sess-1";
  readonly handlers: Record<string, Handler> = {
    "droid.initialize_session": (params) => ({
      sessionId: this.sessionId,
      settings: { modelId: params.modelId ?? "gpt-6-sol", reasoningEffort: "medium", ...pick(params) },
      availableModels: MODELS,
    }),
    "droid.load_session": () => ({
      session: { messages: [] },
      settings: { modelId: "gpt-6-sol", reasoningEffort: "medium", interactionMode: "auto", autonomyLevel: "high" },
      availableModels: MODELS,
    }),
  };
  private readonly events = new EventEmitter();
  readonly stdin = {
    destroyed: false,
    write: (data: string) => {
      this.written.push(data);
      this.answer(data);
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

  exit(code: number): void {
    this.events.emit("close", code, null);
  }

  /** Every JSON-RPC message the client wrote. */
  messages(): Json[] {
    return this.written.flatMap((chunk) =>
      chunk
        .split("\n")
        .filter(Boolean)
        .map((entry) => JSON.parse(entry) as Json),
    );
  }

  requests(method?: string): Json[] {
    return this.messages().filter((message) => message.type === "request" && (!method || message.method === method));
  }

  responses(): Json[] {
    return this.messages().filter((message) => message.type === "response");
  }

  send(value: unknown): void {
    this.stdout.emit("data", line(value));
  }

  notify(notification: Json, sessionId: string | undefined = this.sessionId): void {
    this.send({
      jsonrpc: "2.0",
      type: "notification",
      factoryApiVersion: "1.0.0",
      method: "droid.session_notification",
      params: { ...(sessionId ? { sessionId } : {}), notification },
    });
  }

  ask(id: string, method: string, params: Json): void {
    this.send({ jsonrpc: "2.0", type: "request", factoryApiVersion: "1.0.0", id, method, params });
  }

  private answer(data: string): void {
    for (const entry of data.split("\n").filter(Boolean)) {
      const message = JSON.parse(entry) as Json;
      if (message.type !== "request") continue;
      const handler = this.handlers[String(message.method)];
      const result = handler ? handler((message.params ?? {}) as Json) : {};
      if (result === undefined) continue;
      setImmediate(() => {
        if (this.killed) return;
        this.send({ jsonrpc: "2.0", type: "response", factoryApiVersion: "1.0.0", id: message.id, ...wrap(result) });
      });
    }
  }
}

function wrap(result: Json): Json {
  return "error" in result ? { error: result.error } : { result };
}

function pick(params: Json): Json {
  const settings: Json = {};
  for (const key of ["interactionMode", "autonomyLevel", "reasoningEffort"]) {
    if (params[key] !== undefined) settings[key] = params[key];
  }
  return settings;
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function harness(
  options: {
    resumeSessionId?: string;
    permissionMode?: "read-only" | "supervised" | "full-access";
    model?: string;
  } = {},
  setup?: (child: FakeProcess) => void,
): Promise<{
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
    ...options,
    spawnProcess: (command, args, spawnOptions) => {
      calls.push({ command, args, options: spawnOptions });
      const child = new FakeProcess();
      setup?.(child);
      children.push(child);
      return child;
    },
  });
  const events: DroidProviderEvent[] = [];
  client.subscribe((event) => events.push(event));
  return { client, children, calls, events };
}

function child(children: FakeProcess[], index = 0): FakeProcess {
  const found = children[index];
  if (!found) throw new Error(`No Droid process ${index}`);
  return found;
}

function completeTurn(process: FakeProcess, turnId: string, extra: Json = {}): void {
  process.notify({ type: "agent_turn_completed", reason: "completed", turnId, ...extra });
}

const execArgs = [
  "exec",
  "--input-format",
  "stream-jsonrpc",
  "--output-format",
  "stream-jsonrpc",
  "--cwd",
  "/work/tree",
];

describe("DroidClient", () => {
  it("starts one JSON-RPC process on the first turn and streams turns through one session", async () => {
    const { client, children, calls, events } = await harness();
    expect(calls).toHaveLength(0);

    const turn = await client.sendTurn({ text: "Create hello.txt" });
    const droid = child(children);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("/usr/bin/droid");
    expect(calls[0]?.args).toEqual(execArgs);
    expect(calls[0]?.options).toMatchObject({ cwd: "/work/tree", shell: false, windowsHide: true });
    expect(calls[0]?.options.env.PWD).toBe("/work/tree");
    expect(calls[0]?.options.env.PATH).toBe("/usr/bin");
    const [init, add] = droid.requests();
    expect(init).toMatchObject({
      jsonrpc: "2.0",
      type: "request",
      factoryApiVersion: "1.0.0",
      method: "droid.initialize_session",
      params: { cwd: "/work/tree", interactionMode: "auto", autonomyLevel: "high" },
    });
    expect(init?.params).toMatchObject({ machineId: expect.any(String) });
    expect(add).toMatchObject({
      method: "droid.add_user_message",
      params: { text: "Create hello.txt", messageId: turn.providerTurnId },
    });
    expect(turn.providerTurnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

    droid.notify({ type: "droid_working_state_changed", newState: "streaming_assistant_message" });
    droid.notify({ type: "thinking_text_delta", messageId: "m1", blockIndex: 0, textDelta: "thinking" });
    droid.notify({ type: "assistant_text_delta", messageId: "m1", blockIndex: 1, textDelta: "Creating " });
    droid.notify({ type: "assistant_text_delta", messageId: "m1", blockIndex: 1, textDelta: "the file." });
    droid.notify(
      { type: "tool_call", toolUse: { type: "tool_use", id: "call-1", name: "Create", input: {} } },
      undefined,
    );
    droid.notify({
      type: "create_message",
      message: {
        id: "m1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "thinking" },
          { type: "text", text: "Creating the file." },
          { type: "tool_use", id: "call-1", name: "Create", input: { file_path: "/work/tree/hello.txt" } },
        ],
      },
    });
    droid.notify({ type: "tool_result", toolUseId: "call-1", content: "ok", isError: false });
    droid.notify({ type: "assistant_text_delta", messageId: "m2", blockIndex: 0, textDelta: "DONE" });
    droid.notify({
      type: "create_message",
      message: { id: "m2", role: "assistant", content: [{ type: "text", text: "DONE" }] },
    });
    completeTurn(droid, turn.providerTurnId, {
      tokenUsage: { inputTokens: 30, outputTokens: 12, cacheCreationTokens: 500, cacheReadTokens: 2_000 },
    });
    droid.notify({ type: "droid_working_state_changed", newState: "idle" });

    expect(events).toEqual([
      { type: "session.identified", sessionId: "sess-1" },
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "Creating " },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "the file." },
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
      {
        type: "usage.updated",
        providerTurnId: turn.providerTurnId,
        usage: { inputTokens: 2_530, cachedInputTokens: 2_000, outputTokens: 12 },
      },
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
    expect(calls).toHaveLength(1);
    expect(droid.requests().map((request) => request.method)).toEqual([
      "droid.initialize_session",
      "droid.add_user_message",
      "droid.add_user_message",
    ]);
    expect(events.at(-1)).toEqual({ type: "turn.started", providerTurnId: next.providerTurnId });
  });

  it("uses a whole assistant message when its text was not streamed", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Hi" });
    const droid = child(children);
    droid.notify({
      type: "create_message",
      message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Hello from Droid" }] },
    });
    completeTurn(droid, turn.providerTurnId);
    expect(events.slice(1)).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "Hello from Droid" },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "completed" },
    ]);
  });

  it("ignores another session's notifications and completions of other turns", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Hi" });
    const droid = child(children);
    droid.notify({ type: "assistant_text_delta", messageId: "x", blockIndex: 0, textDelta: "child" }, "sess-child");
    completeTurn(droid, "some-other-turn");
    droid.notify({ type: "assistant_text_delta", messageId: "m1", blockIndex: 0, textDelta: "mine" });
    completeTurn(droid, turn.providerTurnId);
    expect(events.filter((event) => event.type === "assistant.delta")).toEqual([
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "mine" },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
  });

  it("fails the turn with Droid's error when the turn ends on one", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Hi" });
    const droid = child(children);
    droid.notify({ type: "error", message: "Not logged in", errorType: "Error", timestamp: "now" });
    droid.notify({ type: "agent_turn_completed", reason: "error", turnId: turn.providerTurnId });
    expect(events.slice(1)).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "turn.failed", providerTurnId: turn.providerTurnId, message: "Not logged in" },
    ]);
    expect(droid.killed).toBe(false);
    expect(events.some((event) => event.type === "session.closed")).toBe(false);
  });

  it("fails a turn that hit an error and went idle without a completion", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Hi" });
    const droid = child(children);
    droid.notify({ type: "droid_working_state_changed", newState: "thinking" });
    droid.notify({ type: "error", message: "Quota exceeded" });
    droid.notify({ type: "droid_working_state_changed", newState: "idle" });
    expect(events.at(-1)).toEqual({
      type: "turn.failed",
      providerTurnId: turn.providerTurnId,
      message: "Quota exceeded",
    });
  });

  it("does not end a turn on a stray idle report", async () => {
    const { client, children, events } = await harness();
    await client.sendTurn({ text: "Hi" });
    const droid = child(children);
    droid.notify({ type: "droid_working_state_changed", newState: "thinking" });
    droid.notify({ type: "droid_working_state_changed", newState: "idle" });
    expect(events.map((event) => event.type)).toEqual(["session.identified", "turn.started"]);
  });

  it("interrupts through JSON-RPC, cancels a waiting approval, and ignores the late completion", async () => {
    const { client, children, calls, events } = await harness({ permissionMode: "supervised" });
    const turn = await client.sendTurn({ text: "Run tests" });
    const droid = child(children);
    droid.ask("perm-1", "droid.request_permission", {
      toolUses: [{ toolUse: { type: "tool_use", id: "t1", name: "Execute", input: { command: "npm test" } } }],
      options: [{ value: "proceed_once" }, { value: "cancel" }],
    });
    await client.interruptTurn(turn.providerTurnId);
    expect(droid.requests("droid.interrupt_session")).toHaveLength(1);
    expect(droid.responses()).toEqual([
      expect.objectContaining({ id: "perm-1", result: { selectedOption: "cancel" } }),
    ]);
    expect(droid.killed).toBe(false);

    droid.notify({ type: "tool_result", toolUseId: "t1", content: "Error: cancelled", isError: true });
    droid.notify({ type: "agent_turn_completed", reason: "cancelled", turnId: turn.providerTurnId });
    const next = await client.sendTurn({ text: "Continue" });
    expect(calls).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual([
      "session.identified",
      "turn.started",
      "approval.requested",
      "turn.completed",
      "turn.started",
    ]);
    expect(events[3]).toEqual({ type: "turn.completed", providerTurnId: turn.providerTurnId, status: "interrupted" });
    expect(events[4]).toEqual({ type: "turn.started", providerTurnId: next.providerTurnId });
    await expect(client.respondToApproval("perm-1", true)).rejects.toMatchObject({ code: "request_failed" });
  });

  it("fails the turn but keeps the session when the process exits mid-turn, then loads it in a new process", async () => {
    const { client, children, calls, events } = await harness();
    const turn = await client.sendTurn({ text: "Run tests" });
    child(children).stderr.emit("data", "boom\n");
    child(children).exit(1);
    expect(events.slice(1)).toEqual([
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "turn.failed", providerTurnId: turn.providerTurnId, message: "Droid CLI exited (1): boom" },
    ]);
    expect(client.transcript()[0]).toMatchObject({ providerTurnId: turn.providerTurnId, sessionId: "sess-1" });

    await client.sendTurn({ text: "Retry" });
    expect(calls).toHaveLength(2);
    expect(
      child(children, 1)
        .requests()
        .map((request) => request.method),
    ).toEqual(["droid.load_session", "droid.add_user_message"]);
    expect(child(children, 1).requests("droid.load_session")[0]?.params).toEqual({ sessionId: "sess-1" });
  });

  it("rejects the turn when the CLI exits before the session starts", async () => {
    const { client, events } = await harness({}, (process) => {
      process.handlers["droid.initialize_session"] = () => {
        setImmediate(() => {
          process.stderr.emit("data", "not logged in\n");
          process.exit(1);
        });
        return undefined;
      };
    });
    await expect(client.sendTurn({ text: "Hi" })).rejects.toMatchObject({
      code: "closed",
      message: "Droid CLI exited (1): not logged in",
    });
    expect(events).toEqual([]);
  });

  it("rejects the turn when Droid refuses the session", async () => {
    const { client, children } = await harness({}, (process) => {
      process.handlers["droid.initialize_session"] = () => ({ error: { code: -32602, message: "Bad cwd" } });
    });
    await expect(client.sendTurn({ text: "Hi" })).rejects.toMatchObject({ code: "request_failed", message: "Bad cwd" });
    expect(child(children).killed).toBe(true);
  });

  it("loads a resumed session on the first turn and reports its id once", async () => {
    const { client, children, events } = await harness({ resumeSessionId: "sess-old" });
    const turn = await client.sendTurn({ text: "Where were we?" });
    const droid = child(children);
    droid.sessionId = "sess-old";
    expect(droid.requests().map((request) => request.method)).toEqual(["droid.load_session", "droid.add_user_message"]);
    expect(droid.requests("droid.load_session")[0]?.params).toEqual({ sessionId: "sess-old" });
    droid.notify({ type: "assistant_text_delta", messageId: "m1", blockIndex: 0, textDelta: "Back on it." });
    completeTurn(droid, turn.providerTurnId);
    expect(events).toEqual([
      { type: "session.identified", sessionId: "sess-old" },
      { type: "turn.started", providerTurnId: turn.providerTurnId },
      { type: "assistant.delta", providerTurnId: turn.providerTurnId, text: "Back on it." },
      { type: "turn.completed", providerTurnId: turn.providerTurnId, status: "completed" },
    ]);
  });

  it("rejects the first turn of a resumed session that Droid cannot load", async () => {
    const { client, children, events } = await harness({ resumeSessionId: "sess-gone" }, (process) => {
      process.handlers["droid.load_session"] = () => ({ error: { code: -32000, message: "Session not found" } });
    });
    await expect(client.sendTurn({ text: "Hi" })).rejects.toMatchObject({
      code: "request_failed",
      message: "Session not found",
    });
    expect(child(children).killed).toBe(true);
    expect(events).toEqual([]);
  });

  it("rejects a second turn while one is running", async () => {
    const { client, children } = await harness();
    await client.sendTurn({ text: "Hi" });
    await expect(client.sendTurn({ text: "Again" })).rejects.toMatchObject({
      code: "request_failed",
      message: "Droid CLI already has a turn in progress.",
    });
    expect(child(children).requests("droid.add_user_message")).toHaveLength(1);
  });

  it("reports malformed lines without failing the turn and frames split lines", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Hi" });
    const droid = child(children);
    droid.stdout.emit("data", "debug line\n");
    droid.stdout.emit("data", "{bad\n");
    droid.stdout.emit("data", line({ type: "notification", method: "droid.session_notification", params: {} }));
    const split = line({
      type: "notification",
      method: "droid.session_notification",
      params: { sessionId: "sess-1", notification: { type: "assistant_text_delta", messageId: "m", textDelta: "ok" } },
    });
    droid.stdout.emit("data", split.slice(0, 20));
    droid.stdout.emit("data", `${split.slice(20, -1)}\r\n`);
    completeTurn(droid, turn.providerTurnId);
    expect(events.map((event) => event.type)).toEqual([
      "session.identified",
      "turn.started",
      "protocol.error",
      "protocol.error",
      "assistant.delta",
      "turn.completed",
    ]);
    expect(events[2]).toEqual({ type: "protocol.error", message: "Malformed Droid CLI message." });
  });

  it("kills the process on close", async () => {
    const { client, children } = await harness();
    await client.sendTurn({ text: "Hello" });
    await client.close();
    expect(child(children).killed).toBe(true);
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

describe("DroidClient permissions", () => {
  const execute = (id: string, command: string) => ({
    toolUse: { type: "tool_use", id, name: "Execute", input: { command, riskLevel: "medium" } },
    confirmationType: "exec",
    details: { type: "exec", fullCommand: command, command, impactLevel: "medium" },
  });
  const options = [
    { label: "Yes, allow", value: "proceed_once" },
    { label: "Yes, and always allow medium impact commands", value: "proceed_always" },
    { label: "No, cancel", value: "cancel" },
  ];

  it("asks before a supervised turn runs a riskier command and sends back allow or deny", async () => {
    const { client, children, events } = await harness({ permissionMode: "supervised", model: "claude-opus-5-5" });
    await client.sendTurn({ text: "Run it" });
    const droid = child(children);
    expect(droid.requests("droid.initialize_session")[0]?.params).toMatchObject({
      interactionMode: "auto",
      autonomyLevel: "low",
      modelId: "claude-opus-5-5",
    });

    droid.ask("perm-1", "droid.request_permission", { toolUses: [execute("t1", "echo hi")], options });
    droid.ask("perm-2", "droid.request_permission", { toolUses: [execute("t2", "git push")], options });
    expect(events.filter((event) => event.type === "approval.requested")).toEqual([
      {
        type: "approval.requested",
        requestId: "perm-1",
        payload: { toolName: "Execute", input: { command: "echo hi", riskLevel: "medium" }, toolUseId: "t1" },
      },
      {
        type: "approval.requested",
        requestId: "perm-2",
        payload: { toolName: "Execute", input: { command: "git push", riskLevel: "medium" }, toolUseId: "t2" },
      },
    ]);
    expect(droid.responses()).toEqual([]);

    await client.respondToApproval("perm-1", true);
    await client.respondToApproval("perm-2", false);
    expect(droid.responses()).toEqual([
      {
        jsonrpc: "2.0",
        type: "response",
        factoryApiVersion: "1.0.0",
        id: "perm-1",
        result: { selectedOption: "proceed_once" },
      },
      {
        jsonrpc: "2.0",
        type: "response",
        factoryApiVersion: "1.0.0",
        id: "perm-2",
        result: { selectedOption: "cancel" },
      },
    ]);
    await expect(client.respondToApproval("perm-1", true)).rejects.toMatchObject({ code: "request_failed" });
  });

  it("keeps allowing a tool the user allowed for the session", async () => {
    const { client, children, events } = await harness({ permissionMode: "supervised" });
    await client.sendTurn({ text: "Run it" });
    const droid = child(children);
    droid.ask("perm-1", "droid.request_permission", { toolUses: [execute("t1", "echo hi")], options });
    await client.respondToApproval("perm-1", true, { forSession: true });
    droid.ask("perm-2", "droid.request_permission", { toolUses: [execute("t2", "echo again")], options });
    expect(events.filter((event) => event.type === "approval.requested").map((event) => event.requestId)).toEqual([
      "perm-1",
    ]);
    expect(droid.responses().map((response) => [response.id, response.result])).toEqual([
      ["perm-1", { selectedOption: "proceed_once" }],
      ["perm-2", { selectedOption: "proceed_once" }],
    ]);
  });

  it("names MCP tools the way their server does and lists every tool in a batched request", async () => {
    const { client, children, events } = await harness({ permissionMode: "supervised" });
    await client.sendTurn({ text: "Open the page" });
    child(children).ask("perm-1", "droid.request_permission", {
      toolUses: [
        {
          toolUse: { type: "tool_use", id: "t1", name: "zli-browser___browser_open", input: { url: "http://x.test" } },
          confirmationType: "mcp_tool",
          details: {
            type: "mcp_tool",
            toolName: "zli-browser___browser_open",
            serverName: "zli-browser",
            actualToolName: "browser_open",
            impactLevel: "high",
          },
        },
        execute("t2", "echo hi"),
      ],
      options,
    });
    expect(events.at(-1)).toEqual({
      type: "approval.requested",
      requestId: "perm-1",
      payload: {
        toolName: "browser_open",
        input: { url: "http://x.test" },
        toolUseId: "t1",
        toolUses: [
          { toolName: "browser_open", input: { url: "http://x.test" } },
          { toolName: "Execute", input: { command: "echo hi", riskLevel: "medium" } },
        ],
      },
    });
  });

  it("approves every request in full access without asking", async () => {
    const { client, children, events } = await harness({ permissionMode: "full-access" });
    await client.sendTurn({ text: "Run it" });
    const droid = child(children);
    droid.ask("perm-1", "droid.request_permission", { toolUses: [execute("t1", "git push")], options });
    droid.ask("perm-2", "droid.request_permission", {
      toolUses: [execute("t2", "rm -rf build")],
      options: [{ value: "proceed_auto_run_high" }, { value: "cancel" }],
    });
    expect(events.some((event) => event.type === "approval.requested")).toBe(false);
    expect(droid.responses().map((response) => [response.id, response.result])).toEqual([
      ["perm-1", { selectedOption: "proceed_once" }],
      ["perm-2", { selectedOption: "proceed_auto_run_high" }],
    ]);
  });

  it("applies a permission mode change through update_session_settings before the next message", async () => {
    const { client, children } = await harness({ permissionMode: "supervised" });
    const first = await client.sendTurn({ text: "One" });
    const droid = child(children);
    completeTurn(droid, first.providerTurnId);
    const second = await client.sendTurn({ text: "Two", permissionMode: "read-only" });
    completeTurn(droid, second.providerTurnId);
    // Approving a spec moves Droid back to auto mode on its own.
    droid.notify({ type: "settings_updated", settings: { interactionMode: "auto", autonomyLevel: "off" } }, undefined);
    const third = await client.sendTurn({ text: "Three" });
    completeTurn(droid, third.providerTurnId);
    await client.sendTurn({ text: "Four", permissionMode: "full-access" });

    expect(droid.requests().map((request) => [request.method, request.params])).toEqual([
      ["droid.initialize_session", expect.objectContaining({ interactionMode: "auto", autonomyLevel: "low" })],
      ["droid.add_user_message", expect.objectContaining({ text: "One" })],
      ["droid.update_session_settings", { interactionMode: "spec", autonomyLevel: "off" }],
      ["droid.add_user_message", expect.objectContaining({ text: "Two" })],
      ["droid.update_session_settings", { interactionMode: "spec" }],
      ["droid.add_user_message", expect.objectContaining({ text: "Three" })],
      ["droid.update_session_settings", { interactionMode: "auto", autonomyLevel: "high" }],
      ["droid.add_user_message", expect.objectContaining({ text: "Four" })],
    ]);
  });

  it("maps each permission mode to Droid's session settings", () => {
    expect(droidSessionSettings("read-only")).toEqual({ interactionMode: "spec", autonomyLevel: "off" });
    expect(droidSessionSettings("supervised")).toEqual({ interactionMode: "auto", autonomyLevel: "low" });
    expect(droidSessionSettings("full-access")).toEqual({ interactionMode: "auto", autonomyLevel: "high" });
    expect(droidArgs("/work/tree")).toEqual(execArgs);
  });

  it("rejects the turn when Droid refuses a setting", async () => {
    const { client, children } = await harness({}, (process) => {
      process.handlers["droid.update_session_settings"] = () => ({
        error: { code: -32602, message: "Unknown model: nope" },
      });
    });
    await expect(client.sendTurn({ text: "Hi", model: "nope" })).rejects.toMatchObject({
      code: "request_failed",
      message: "Unknown model: nope",
    });
    expect(child(children).requests("droid.add_user_message")).toHaveLength(0);
    await expect(client.sendTurn({ text: "Hi" })).resolves.toMatchObject({ providerTurnId: expect.any(String) });
  });
});

describe("DroidClient models", () => {
  it("applies a turn-level model and reasoning level to that turn only", async () => {
    const { client, children } = await harness({ model: "gpt-6-sol" });
    const first = await client.sendTurn({ text: "One", model: "claude-opus-5-5", reasoningEffort: "high" });
    const droid = child(children);
    completeTurn(droid, first.providerTurnId);
    const second = await client.sendTurn({ text: "Two" });
    completeTurn(droid, second.providerTurnId);
    await client.sendTurn({ text: "Three" });
    expect(droid.requests("droid.update_session_settings").map((request) => request.params)).toEqual([
      { modelId: "claude-opus-5-5", reasoningEffort: "high" },
      { modelId: "gpt-6-sol", reasoningEffort: "medium" },
    ]);
  });
});

describe("DroidClient tools", () => {
  it("pairs tool calls with results, marks failed exits, and drops repeated results", async () => {
    const { client, children, events } = await harness();
    const turn = await client.sendTurn({ text: "Inspect" });
    const droid = child(children);
    droid.notify({
      type: "create_message",
      message: {
        id: "m1",
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_exec", name: "Execute", input: { command: "echo zli-check" } },
          { type: "tool_use", id: "call_fail", name: "Execute", input: { command: "npm test" } },
        ],
      },
    });
    droid.notify({
      type: "tool_result",
      toolUseId: "call_exec",
      content: "zli-check\n\n\n[Process exited with code 0]",
      isError: false,
    });
    droid.notify({
      type: "tool_result",
      toolUseId: "call_fail",
      content: "1 failing\n\n[Process exited with code 1]",
      isError: false,
    });
    droid.notify({ type: "tool_result", toolUseId: "call_fail", content: "again", isError: true });
    droid.notify(
      { type: "tool_call", toolUse: { type: "tool_use", id: "call_late", name: "Grep", input: { pattern: "x" } } },
      undefined,
    );
    droid.notify({ type: "tool_result", toolUseId: "call_late", content: { matches: 0 }, isError: false });
    droid.notify({ type: "tool_result", toolUseId: "call_unknown", content: "boom", isError: true });
    completeTurn(droid, turn.providerTurnId);

    const tools = events.flatMap((event) => (event.type === "tool.updated" ? [event.tool] : []));
    expect(tools).toEqual([
      { callId: "call_exec", name: "Execute", input: { command: "echo zli-check" }, status: "running" },
      { callId: "call_fail", name: "Execute", input: { command: "npm test" }, status: "running" },
      {
        callId: "call_exec",
        name: "Execute",
        input: { command: "echo zli-check" },
        status: "completed",
        output: "zli-check\n\n\n[Process exited with code 0]",
      },
      {
        callId: "call_fail",
        name: "Execute",
        input: { command: "npm test" },
        status: "failed",
        output: "1 failing\n\n[Process exited with code 1]",
      },
      { callId: "call_late", name: "Grep", input: { pattern: "x" }, status: "completed", output: '{"matches":0}' },
      { callId: "call_unknown", name: "Tool", status: "failed", output: "boom" },
    ]);
  });
});

describe("DroidClient questions", () => {
  it("turns ask_user into a user-input request and sends the answers back by index", async () => {
    const { client, children, events } = await harness({ permissionMode: "supervised" });
    await client.sendTurn({ text: "Plan it" });
    const droid = child(children);
    droid.ask("ask-1", "droid.ask_user", {
      toolCallId: "t1",
      questions: [
        { index: 0, topic: "Database", question: "Which database?", options: ["Postgres", "SQLite"] },
        { index: 1, topic: "Name", question: "What should it be called?", options: [] },
      ],
    });
    expect(events.at(-1)).toEqual({
      type: "user-input.requested",
      requestId: "ask-1",
      payload: {
        questions: [
          {
            id: "0",
            header: "Database",
            question: "Which database?",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
            isOther: true,
          },
          { id: "1", header: "Name", question: "What should it be called?", options: [], isOther: true },
        ],
      },
    });
    await client.respondToUserInput("ask-1", { "0": "SQLite", "1": "notes" });
    expect(droid.responses()).toEqual([
      expect.objectContaining({
        id: "ask-1",
        result: {
          answers: [
            { index: 0, question: "Which database?", answer: "SQLite" },
            { index: 1, question: "What should it be called?", answer: "notes" },
          ],
        },
      }),
    ]);
  });

  it("declines pick_options and refuses requests it does not know", async () => {
    const { client, children } = await harness();
    await client.sendTurn({ text: "Hi" });
    const droid = child(children);
    droid.ask("pick-1", "droid.pick_options", {
      toolCallId: "t",
      title: "Pick",
      rows: [],
      multi: false,
      preselectedIds: [],
    });
    droid.ask("odd-1", "droid.something_new", {});
    expect(droid.responses()).toEqual([
      expect.objectContaining({ id: "pick-1", result: { cancelled: true, selectedIds: [] } }),
      expect.objectContaining({
        id: "odd-1",
        error: { code: -32601, message: "ZLI does not handle droid.something_new." },
      }),
    ]);
  });
});

describe("DroidClient settle", () => {
  it("waits for Droid to finish an interrupted turn before sending the next message", async () => {
    const { client, children } = await harness();
    const turn = await client.sendTurn({ text: "Long" });
    const droid = child(children);
    await client.interruptTurn();
    const next = client.sendTurn({ text: "Next" });
    await tick();
    await tick();
    expect(droid.requests("droid.add_user_message")).toHaveLength(1);
    droid.notify({ type: "agent_turn_completed", reason: "cancelled", turnId: turn.providerTurnId });
    await next;
    expect(droid.requests("droid.add_user_message")).toHaveLength(2);
  });
});
