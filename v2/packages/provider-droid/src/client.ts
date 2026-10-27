import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";

import { type ProviderUsage, spawnCli } from "@zli-v2/shared";

import { type DroidPermissionMode, decodeDroidLine, droidTurnArgs, MAX_DROID_LINE_CHARS } from "./protocol.js";
import { classifyDroidMessage } from "./schema.js";

const VERSION_PROBE_MS = 1_000;
const MESSAGE_SEPARATOR = "\n\n";

export type DroidProviderEvent =
  | { type: "turn.started"; providerTurnId: string }
  | { type: "assistant.delta"; providerTurnId: string; text: string }
  | { type: "turn.completed"; providerTurnId: string; status: string }
  | { type: "turn.failed"; providerTurnId: string; message: string }
  | { type: "tool.updated"; providerTurnId: string; tool: DroidToolUpdate }
  | { type: "usage.updated"; providerTurnId: string; usage: ProviderUsage }
  | { type: "protocol.error"; message: string }
  /** The CLI reported the session id that later turns, and a later process, continue with -s. */
  | { type: "session.identified"; sessionId: string }
  | { type: "session.closed"; reason: string };

export type DroidToolUpdate = {
  callId: string;
  name: string;
  input?: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  output?: string;
};

export type DroidTurnResult = { providerTurnId: string };
export type DroidTranscriptTurn = { providerTurnId: string; text: string; status: string; sessionId?: string };

export type DroidPeer = {
  write(data: string): void;
  endInput(): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
  close(): Promise<void>;
};

export type DroidChild = {
  stdin: {
    write(data: string): boolean;
    end?(): void;
    readonly destroyed?: boolean;
    on(event: "error", listener: (error: Error) => void): void;
  };
  stdout: {
    setEncoding(encoding: "utf8"): void;
    on(event: "data", listener: (chunk: string | Buffer) => void): void;
  };
  stderr: {
    setEncoding(encoding: "utf8"): void;
    on(event: "data", listener: (chunk: string | Buffer) => void): void;
  };
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
};

export type DroidSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: readonly ["pipe", "pipe", "pipe"];
  windowsHide: true;
};

export type DroidClientOptions = {
  cwd: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  permissionMode?: DroidPermissionMode;
  /** Default model for every turn that does not name one. */
  model?: string;
  /** A session from an earlier process. The first turn continues it with -s instead of starting a new one. */
  resumeSessionId?: string;
  spawnProcess?: (command: string, args: readonly string[], options: DroidSpawnOptions) => DroidChild;
};

export class DroidProviderError extends Error {
  constructor(
    readonly code: "cli_missing" | "invalid_response" | "request_failed" | "closed" | "unsupported",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DroidProviderError";
  }
}

type ActiveTurn = {
  id: string;
  text: string;
  sawText: boolean;
  tools: Map<string, { name: string; input?: Record<string, unknown> }>;
};

export class DroidClient {
  private readonly listeners = new Set<(event: DroidProviderEvent) => void>();
  private readonly completed: DroidTranscriptTurn[] = [];
  private sessionId: string | undefined;
  /** False while a resumed id has not been echoed by the CLI, so a failed first turn is not treated as resumable. */
  private sessionConfirmed = false;
  private active: ActiveTurn | undefined;
  private peer: DroidPeer | undefined;
  private unlistenMessage: (() => void) | undefined;
  private unlistenClose: (() => void) | undefined;
  private closed = false;

  private constructor(
    private readonly cwd: string,
    private readonly command: string,
    private readonly spawnProcess: DroidClientOptions["spawnProcess"],
    private readonly baseEnv: NodeJS.ProcessEnv | undefined,
    private permissionMode: DroidPermissionMode,
    private readonly model: string | undefined,
    resumeSessionId: string | undefined,
  ) {
    this.sessionId = resumeSessionId;
  }

  static async start(options: DroidClientOptions): Promise<DroidClient> {
    const command = options.command ?? "droid";
    if (!command.trim()) throw new DroidProviderError("cli_missing", "Droid CLI was not found.");
    if (!options.spawnProcess) {
      assertWorktree(options.cwd);
      await assertCommand(command);
    }
    return new DroidClient(
      options.cwd,
      command,
      options.spawnProcess,
      options.env,
      options.permissionMode ?? "full-access",
      options.model?.trim() || undefined,
      options.resumeSessionId?.trim() || undefined,
    );
  }

  subscribe(listener: (event: DroidProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transcript(): readonly DroidTranscriptTurn[] {
    return this.completed;
  }

  /**
   * Each turn is its own process, so a turn-level model or reasoning level only applies to that
   * run. A permission mode applies to this turn and every later one.
   */
  async sendTurn(input: {
    text: string;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: DroidPermissionMode;
  }): Promise<DroidTurnResult> {
    this.assertOpen();
    if (this.active) throw new DroidProviderError("request_failed", "Droid CLI already has a turn in progress.");
    if (input.permissionMode) this.permissionMode = input.permissionMode;
    const providerTurnId = randomUUID();
    const peer = this.spawnTurn(input.model?.trim() || this.model, input.reasoningEffort?.trim() || undefined);
    this.active = { id: providerTurnId, text: "", sawText: false, tools: new Map() };
    try {
      peer.write(input.text);
      peer.endInput();
    } catch (error) {
      this.active = undefined;
      await peer.close().catch(() => undefined);
      throw error;
    }
    this.emit({ type: "turn.started", providerTurnId });
    this.attach(peer);
    return { providerTurnId };
  }

  async interruptTurn(providerTurnId?: string): Promise<void> {
    this.assertOpen();
    if (!this.active) return;
    if (providerTurnId && providerTurnId !== this.active.id) {
      throw new DroidProviderError("request_failed", "Droid CLI turn does not match the active turn.");
    }
    this.finishTurn("interrupted");
    await this.stopPeer();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.active = undefined;
    await this.stopPeer();
  }

  private spawnTurn(model: string | undefined, reasoningEffort: string | undefined): DroidPeer {
    const spawnProcess = this.spawnProcess ?? defaultSpawn;
    const args = droidTurnArgs({
      cwd: this.cwd,
      permissionMode: this.permissionMode,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    });
    let child: DroidChild;
    try {
      child = spawnProcess(this.command, args, {
        cwd: this.cwd,
        env: sessionEnv(this.baseEnv, this.cwd),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      if (errnoOf(error) === "ENOENT") {
        throw new DroidProviderError(
          "cli_missing",
          `Droid CLI was not found at ${this.command}.`,
          error instanceof Error ? { cause: error } : undefined,
        );
      }
      throw error;
    }
    return new JsonlDroidPeer(child);
  }

  private attach(peer: DroidPeer): void {
    this.detach();
    this.peer = peer;
    this.unlistenMessage = peer.onMessage((message) => this.handleMessage(message));
    this.unlistenClose = peer.onClose((error) => this.onPeerClose(error));
  }

  private detach(): void {
    this.unlistenMessage?.();
    this.unlistenClose?.();
    this.unlistenMessage = undefined;
    this.unlistenClose = undefined;
  }

  private async stopPeer(): Promise<void> {
    const peer = this.peer;
    this.detach();
    this.peer = undefined;
    await peer?.close().catch(() => undefined);
  }

  private handleMessage(raw: unknown): void {
    if (this.closed) return;
    if (!raw || typeof raw !== "object") {
      this.emit({ type: "protocol.error", message: "Malformed Droid CLI message." });
      return;
    }
    const message = classifyDroidMessage(raw);
    if (message.kind === "init") this.noteSession(message.sessionId, true);
    else this.noteSession(sessionIdOf(raw), false);
    switch (message.kind) {
      case "init":
        return;
      case "invalid":
        this.emit({
          type: "protocol.error",
          message:
            message.reason === "init"
              ? "Droid CLI session init did not include a session id."
              : "Malformed Droid CLI message.",
        });
        return;
      case "text":
        this.emitText(message.text);
        return;
      case "completion":
        this.onCompletion(message);
        return;
      case "error":
        this.onError(message.message);
        return;
      case "tool_call":
        this.onToolCall(message);
        return;
      case "tool_result":
        this.onToolResult(message);
        return;
      default:
        return;
    }
  }

  private onToolCall(message: { callId: string; name: string; input?: Record<string, unknown> }): void {
    const active = this.active;
    if (!active) return;
    const tool = { name: message.name, ...(message.input ? { input: message.input } : {}) };
    active.tools.set(message.callId, tool);
    this.emit({
      type: "tool.updated",
      providerTurnId: active.id,
      tool: { callId: message.callId, ...tool, status: "running" },
    });
  }

  private onToolResult(message: { callId: string; name?: string; isError: boolean; output?: string }): void {
    const active = this.active;
    if (!active) return;
    const started = active.tools.get(message.callId);
    active.tools.delete(message.callId);
    const name = started?.name ?? message.name ?? "Tool";
    this.emit({
      type: "tool.updated",
      providerTurnId: active.id,
      tool: {
        callId: message.callId,
        name,
        ...(started?.input ? { input: started.input } : {}),
        status: message.isError ? "failed" : "completed",
        ...(message.output ? { output: message.output } : {}),
      },
    });
  }

  private onCompletion(message: { isError: boolean; text?: string; usage?: ProviderUsage }): void {
    if (!this.active) {
      void this.stopPeer();
      return;
    }
    if (message.usage) this.emit({ type: "usage.updated", providerTurnId: this.active.id, usage: message.usage });
    if (message.isError) {
      this.finishTurn("error", message.text?.trim() || "Droid CLI turn failed.");
      void this.stopPeer();
      return;
    }
    if (!this.active.sawText && message.text?.trim()) this.emitText(message.text);
    this.finishTurn("completed");
    void this.stopPeer();
  }

  private onError(detail: string): void {
    if (!this.active) {
      this.emit({ type: "protocol.error", message: detail });
      return;
    }
    this.finishTurn("error", detail);
    void this.stopPeer();
  }

  private emitText(text: string): void {
    if (!this.active || text.length === 0) return;
    // Each assistant record is a whole message, so separate consecutive ones like paragraphs.
    const delta = this.active.sawText ? `${MESSAGE_SEPARATOR}${text}` : text;
    this.active.sawText = true;
    this.active.text += delta;
    this.emit({ type: "assistant.delta", providerTurnId: this.active.id, text: delta });
  }

  private finishTurn(status: string, errorMessage?: string): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    const sessionId = this.sessionId;
    if (errorMessage) {
      this.completed.push({
        providerTurnId: active.id,
        text: errorMessage,
        status,
        ...(sessionId ? { sessionId } : {}),
      });
      this.emit({ type: "turn.failed", providerTurnId: active.id, message: errorMessage });
      return;
    }
    this.completed.push({
      providerTurnId: active.id,
      text: active.text,
      status,
      ...(sessionId ? { sessionId } : {}),
    });
    this.emit({ type: "turn.completed", providerTurnId: active.id, status });
  }

  private onPeerClose(error?: Error): void {
    this.detach();
    this.peer = undefined;
    if (this.closed || !this.active) return;
    const reason = error?.message ?? "Droid CLI process closed.";
    const resumable = this.sessionConfirmed;
    this.finishTurn("error", reason);
    if (!resumable) {
      this.closed = true;
      this.emit({ type: "session.closed", reason });
    }
  }

  /** Only system/init may replace a known id; other records just confirm or fill it in. */
  private noteSession(sessionId: string | undefined, fromInit: boolean): void {
    if (!sessionId) return;
    if (sessionId === this.sessionId) {
      if (this.sessionConfirmed) return;
    } else if (this.sessionId && !fromInit) {
      return;
    }
    this.sessionId = sessionId;
    this.sessionConfirmed = true;
    this.emit({ type: "session.identified", sessionId });
  }

  private assertOpen(): void {
    if (this.closed) throw new DroidProviderError("closed", "Droid CLI session is closed.");
  }

  private emit(event: DroidProviderEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener cannot take down the CLI transport.
      }
    }
  }
}

function sessionIdOf(raw: unknown): string | undefined {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  return typeof record?.session_id === "string" && record.session_id.length > 0 ? record.session_id : undefined;
}

function defaultSpawn(command: string, args: readonly string[], options: DroidSpawnOptions): DroidChild {
  const child = spawnCli(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new DroidProviderError("request_failed", "Droid CLI did not provide stdio pipes.");
  }
  return child as DroidChild;
}

function sessionEnv(base: NodeJS.ProcessEnv | undefined, cwd: string): NodeJS.ProcessEnv {
  return { ...process.env, ...(base ?? {}), PWD: cwd };
}

function assertWorktree(cwd: string): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(cwd);
  } catch (error) {
    const message =
      errnoOf(error) === "ENOENT"
        ? `Droid CLI working directory does not exist: ${cwd}.`
        : `Droid CLI working directory is not available: ${cwd}.`;
    if (error instanceof Error) throw new DroidProviderError("request_failed", message, { cause: error });
    throw new DroidProviderError("request_failed", message);
  }
  if (!stat.isDirectory()) {
    throw new DroidProviderError("request_failed", `Droid CLI working directory is not a directory: ${cwd}.`);
  }
}

async function assertCommand(command: string): Promise<void> {
  if (isPathCommand(command)) {
    assertBinary(command);
    return;
  }
  await assertBareCommand(command);
}

function assertBinary(command: string): void {
  try {
    accessSync(command, constants.X_OK);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") {
      throw new DroidProviderError("cli_missing", `Droid CLI was not found at ${command}.`);
    }
    const message = `Droid CLI is not executable at ${command}.`;
    if (error instanceof Error) throw new DroidProviderError("request_failed", message, { cause: error });
    throw new DroidProviderError("request_failed", message);
  }
}

// `droid --version` can stay silent without a TTY, so a probe that is still
// running when the timer fires counts as a launchable command.
function assertBareCommand(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnCli(command, ["--version"], { windowsHide: true, stdio: "ignore" });
    } catch (error) {
      if (errnoOf(error) === "ENOENT") {
        reject(
          new DroidProviderError(
            "cli_missing",
            `Droid CLI was not found at ${command}.`,
            error instanceof Error ? { cause: error } : undefined,
          ),
        );
        return;
      }
      reject(
        error instanceof Error
          ? error
          : new DroidProviderError("request_failed", `Droid CLI could not be started at ${command}.`),
      );
      return;
    }
    child.unref();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The probe already exited.
      }
      finish();
    }, VERSION_PROBE_MS);
    child.once("error", (error) => {
      if (errnoOf(error) === "ENOENT") {
        finish(new DroidProviderError("cli_missing", `Droid CLI was not found at ${command}.`, { cause: error }));
        return;
      }
      finish(
        new DroidProviderError("request_failed", `Droid CLI could not be started at ${command}.`, { cause: error }),
      );
    });
    child.once("close", () => finish());
  });
}

function isPathCommand(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function sanitizeDetail(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 180);
}

class JsonlDroidPeer implements DroidPeer {
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private readonly queued: unknown[] = [];
  private buffer = "";
  private stderr = "";
  private failError: Error | undefined;
  private isClosed = false;

  constructor(private readonly child: DroidChild) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consume(chunk));
    child.stderr.on("data", (chunk) => {
      if (this.stderr.length < 500) this.stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => this.fail(error));
    child.once("close", (code, signal) => this.fail(processExitError(code, signal, this.stderr)));
  }

  write(data: string): void {
    if (this.isClosed || this.child.stdin.destroyed) {
      throw new DroidProviderError("closed", "Droid CLI session is closed.");
    }
    this.child.stdin.write(data);
  }

  endInput(): void {
    if (this.isClosed || this.child.stdin.destroyed) return;
    this.child.stdin.end?.();
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    const queued = this.queued.splice(0);
    for (const message of queued) listener(message);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    if (this.failError) listener(this.failError);
    return () => this.closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    try {
      this.child.kill();
    } catch (error) {
      if (errnoOf(error) !== "ESRCH") throw error;
    }
    this.fail(new Error("Droid CLI session closed."));
  }

  private consume(chunk: string | Buffer): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (this.buffer.length > MAX_DROID_LINE_CHARS && !this.buffer.includes("\n")) {
      this.buffer = "";
      this.deliver(undefined);
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const decoded = decodeDroidLine(line);
      if (decoded.type === "invalid") this.deliver(undefined);
      else if (decoded.type === "message") this.deliver(decoded.value);
      newline = this.buffer.indexOf("\n");
    }
  }

  private deliver(message: unknown): void {
    if (this.messageListeners.size === 0) {
      this.queued.push(message);
      return;
    }
    for (const listener of this.messageListeners) listener(message);
  }

  private fail(error: Error): void {
    if (this.failError) return;
    this.failError = error;
    this.isClosed = true;
    for (const listener of this.closeListeners) listener(error);
  }
}

function processExitError(code: number | null, signal: NodeJS.Signals | null, stderr: string): Error {
  const status = `${code ?? "unknown"}${signal ? `/${signal}` : ""}`;
  const detail = sanitizeDetail(stderr);
  return new Error(detail ? `Droid CLI exited (${status}): ${detail}` : `Droid CLI exited (${status}).`);
}
