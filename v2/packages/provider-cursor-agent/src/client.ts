import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";

import { spawnCli } from "@zli-v2/shared";

import { cursorTurnArgs, decodeCursorLine, MAX_CURSOR_LINE_CHARS } from "./protocol.js";
import { classifyCursorMessage } from "./schema.js";

const VERSION_PROBE_MS = 1_000;

export type CursorProviderEvent =
  | { type: "turn.started"; providerTurnId: string }
  | { type: "assistant.delta"; providerTurnId: string; text: string }
  | { type: "turn.completed"; providerTurnId: string; status: string }
  | { type: "turn.failed"; providerTurnId: string; message: string }
  | { type: "protocol.error"; message: string }
  | { type: "session.closed"; reason: string };

export type CursorTurnResult = { providerTurnId: string };
export type CursorTranscriptTurn = { providerTurnId: string; text: string; status: string; sessionId?: string };

export type CursorPeer = {
  write(line: string): void;
  endInput(): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
  close(): Promise<void>;
};

export type CursorChild = {
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

export type CursorSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: readonly ["pipe", "pipe", "pipe"];
  windowsHide: true;
};

export type CursorAgentClientOptions = {
  cwd: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: (command: string, args: readonly string[], options: CursorSpawnOptions) => CursorChild;
};

export class CursorProviderError extends Error {
  constructor(
    readonly code: "cli_missing" | "invalid_response" | "request_failed" | "closed" | "unsupported",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CursorProviderError";
  }
}

type ActiveTurn = { id: string; text: string; sawPartial: boolean; sawText: boolean };

export class CursorAgentClient {
  private readonly listeners = new Set<(event: CursorProviderEvent) => void>();
  private readonly completed: CursorTranscriptTurn[] = [];
  private sessionId: string | undefined;
  private active: ActiveTurn | undefined;
  private peer: CursorPeer | undefined;
  private unlistenMessage: (() => void) | undefined;
  private unlistenClose: (() => void) | undefined;
  private toolDenied = false;
  private closed = false;

  private constructor(
    private readonly cwd: string,
    private readonly command: string,
    private readonly spawnProcess: CursorAgentClientOptions["spawnProcess"],
    private readonly baseEnv: NodeJS.ProcessEnv | undefined,
  ) {}

  static async start(options: CursorAgentClientOptions): Promise<CursorAgentClient> {
    const command = options.command ?? "cursor-agent";
    if (!command.trim()) throw new CursorProviderError("cli_missing", "Cursor CLI was not found.");
    if (!options.spawnProcess) {
      assertWorktree(options.cwd);
      await assertCommand(command);
    }
    return new CursorAgentClient(options.cwd, command, options.spawnProcess, options.env);
  }

  subscribe(listener: (event: CursorProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transcript(): readonly CursorTranscriptTurn[] {
    return this.completed;
  }

  async sendTurn(input: { text: string; model?: string }): Promise<CursorTurnResult> {
    if (input.model) {
      throw new CursorProviderError("unsupported", "Cursor CLI adapter does not switch models in a session.");
    }
    this.assertOpen();
    if (this.active) throw new CursorProviderError("request_failed", "Cursor CLI already has a turn in progress.");
    const providerTurnId = randomUUID();
    const peer = this.spawnTurn();
    this.active = { id: providerTurnId, text: "", sawPartial: false, sawText: false };
    this.toolDenied = false;
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
      throw new CursorProviderError("request_failed", "Cursor CLI turn does not match the active turn.");
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

  private spawnTurn(): CursorPeer {
    const spawnProcess = this.spawnProcess ?? defaultSpawn;
    const args = cursorTurnArgs({ cwd: this.cwd, ...(this.sessionId ? { sessionId: this.sessionId } : {}) });
    let child: CursorChild;
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
        throw new CursorProviderError(
          "cli_missing",
          `Cursor CLI was not found at ${this.command}.`,
          error instanceof Error ? { cause: error } : undefined,
        );
      }
      throw error;
    }
    return new JsonlCursorPeer(child);
  }

  private attach(peer: CursorPeer): void {
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
    this.noteSession(raw);
    if (!raw || typeof raw !== "object") {
      this.emit({ type: "protocol.error", message: "Malformed Cursor CLI message." });
      return;
    }
    const message = classifyCursorMessage(raw);
    switch (message.kind) {
      case "init":
        if (!this.sessionId) this.sessionId = message.sessionId;
        return;
      case "invalid":
        this.emit({
          type: "protocol.error",
          message:
            message.reason === "init"
              ? "Cursor CLI session init did not include a session id."
              : "Malformed Cursor CLI message.",
        });
        return;
      case "text":
        this.emitText(message.text, message.partial);
        return;
      case "result":
        this.onResult(message);
        return;
      case "tool_denied":
        this.toolDenied = true;
        this.emit({ type: "protocol.error", message: message.message });
        return;
      default:
        return;
    }
  }

  private onResult(message: { isError: boolean; text?: string; subtype?: string }): void {
    if (!this.active) {
      void this.stopPeer();
      return;
    }
    if (message.isError) {
      const detail =
        message.text?.trim() ||
        (message.subtype ? `Cursor CLI turn failed (${message.subtype}).` : "Cursor CLI turn failed.");
      this.finishTurn(message.subtype ?? "error", detail);
      void this.stopPeer();
      return;
    }
    if (!this.active.sawText && message.text?.trim()) this.emitText(message.text, false);
    this.finishTurn("completed");
    void this.stopPeer();
  }

  private emitText(text: string, partial: boolean): void {
    if (!this.active || text.length === 0) return;
    if (partial && this.active.sawText && !this.active.sawPartial) return;
    if (!partial && this.active.sawPartial) return;
    if (partial) this.active.sawPartial = true;
    this.active.sawText = true;
    this.active.text += text;
    this.emit({ type: "assistant.delta", providerTurnId: this.active.id, text });
  }

  private finishTurn(status: string, errorMessage?: string): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    this.toolDenied = false;
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
    if (this.toolDenied) {
      this.toolDenied = false;
      this.finishTurn("denied");
      return;
    }
    const reason = error?.message ?? "Cursor CLI process closed.";
    const resumable = this.sessionId !== undefined;
    this.finishTurn("error", reason);
    if (!resumable) {
      this.closed = true;
      this.emit({ type: "session.closed", reason });
    }
  }

  private noteSession(raw: unknown): void {
    if (this.sessionId) return;
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
    if (typeof record?.session_id === "string" && record.session_id.length > 0) this.sessionId = record.session_id;
  }

  private assertOpen(): void {
    if (this.closed) throw new CursorProviderError("closed", "Cursor CLI session is closed.");
  }

  private emit(event: CursorProviderEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener cannot take down the CLI transport.
      }
    }
  }
}

function defaultSpawn(command: string, args: readonly string[], options: CursorSpawnOptions): CursorChild {
  const child = spawnCli(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new CursorProviderError("request_failed", "Cursor CLI did not provide stdio pipes.");
  }
  return child as CursorChild;
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
        ? `Cursor CLI working directory does not exist: ${cwd}.`
        : `Cursor CLI working directory is not available: ${cwd}.`;
    if (error instanceof Error) throw new CursorProviderError("request_failed", message, { cause: error });
    throw new CursorProviderError("request_failed", message);
  }
  if (!stat.isDirectory()) {
    throw new CursorProviderError("request_failed", `Cursor CLI working directory is not a directory: ${cwd}.`);
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
      throw new CursorProviderError("cli_missing", `Cursor CLI was not found at ${command}.`);
    }
    const message = `Cursor CLI is not executable at ${command}.`;
    if (error instanceof Error) throw new CursorProviderError("request_failed", message, { cause: error });
    throw new CursorProviderError("request_failed", message);
  }
}

function assertBareCommand(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnCli(command, ["--version"], { windowsHide: true, stdio: "ignore" });
    } catch (error) {
      if (errnoOf(error) === "ENOENT") {
        reject(
          new CursorProviderError(
            "cli_missing",
            `Cursor CLI was not found at ${command}.`,
            error instanceof Error ? { cause: error } : undefined,
          ),
        );
        return;
      }
      reject(
        error instanceof Error
          ? error
          : new CursorProviderError("request_failed", `Cursor CLI could not be started at ${command}.`),
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
        finish(new CursorProviderError("cli_missing", `Cursor CLI was not found at ${command}.`, { cause: error }));
        return;
      }
      finish(
        new CursorProviderError("request_failed", `Cursor CLI could not be started at ${command}.`, { cause: error }),
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

class JsonlCursorPeer implements CursorPeer {
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private readonly queued: unknown[] = [];
  private buffer = "";
  private stderr = "";
  private failError: Error | undefined;
  private isClosed = false;

  constructor(private readonly child: CursorChild) {
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

  write(line: string): void {
    if (this.isClosed || this.child.stdin.destroyed) {
      throw new CursorProviderError("closed", "Cursor CLI session is closed.");
    }
    this.child.stdin.write(line);
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
    this.fail(new Error("Cursor CLI session closed."));
  }

  private consume(chunk: string | Buffer): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (this.buffer.length > MAX_CURSOR_LINE_CHARS && !this.buffer.includes("\n")) {
      this.buffer = "";
      this.deliver(undefined);
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const decoded = decodeCursorLine(line);
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
  return new Error(detail ? `Cursor CLI exited (${status}): ${detail}` : `Cursor CLI exited (${status}).`);
}
