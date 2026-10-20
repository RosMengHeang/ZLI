import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";

import { spawnCli } from "@zli-v2/shared";

import {
  type ClaudePermissionMode,
  claudeSessionArgs,
  decodeClaudeLine,
  encodeClaudeMessage,
  MAX_CLAUDE_LINE_CHARS,
} from "./protocol.js";
import {
  allowToolRequest,
  classifyClaudeMessage,
  claudeToolBlocks,
  denyToolRequest,
  initializeRequest,
  interruptRequest,
  setModelRequest,
  unsupportedControlResponse,
  userTurnMessage,
} from "./schema.js";

const SESSION_INIT_TIMEOUT_MS = 20_000;

export type ClaudeProviderEvent =
  | { type: "turn.started"; providerTurnId: string }
  | { type: "assistant.delta"; providerTurnId: string; text: string }
  | { type: "turn.completed"; providerTurnId: string; status: string }
  | { type: "turn.failed"; providerTurnId: string; message: string }
  | { type: "tool.updated"; providerTurnId: string; tool: ClaudeToolUpdate }
  | { type: "approval.requested"; requestId: string; payload: Record<string, unknown> }
  | { type: "protocol.error"; message: string }
  | { type: "session.closed"; reason: string };

export type ClaudeToolUpdate = {
  callId: string;
  name: string;
  input?: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  output?: string;
};

export type ClaudeTurnResult = { providerTurnId: string };
export type ClaudeTranscriptTurn = { providerTurnId: string; text: string; status: string };

export type ClaudePeer = {
  write(line: string): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
  close(): Promise<void>;
};

export type ClaudeChild = {
  stdin: {
    write(data: string): boolean;
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

export type ClaudeSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: readonly ["pipe", "pipe", "pipe"];
  windowsHide: true;
};

export type ClaudeCodeClientOptions = {
  cwd: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  peer?: ClaudePeer;
  spawnProcess?: (command: string, args: readonly string[], options: ClaudeSpawnOptions) => ClaudeChild;
  initTimeoutMs?: number;
  permissionMode?: ClaudePermissionMode;
  model?: string;
  /** MCP config file (or JSON) passed as --mcp-config for this session. */
  mcpConfig?: string;
};

export class ClaudeProviderError extends Error {
  constructor(
    readonly code: "cli_missing" | "invalid_response" | "request_failed" | "closed" | "unsupported",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClaudeProviderError";
  }
}

type ActiveTurn = {
  id: string;
  text: string;
  sawPartial: boolean;
  sawText: boolean;
  tools: Map<string, { name: string; input?: Record<string, unknown> }>;
};

export class ClaudeCodeClient {
  private readonly listeners = new Set<(event: ClaudeProviderEvent) => void>();
  private readonly completed: ClaudeTranscriptTurn[] = [];
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeClose: () => void;
  private sessionId: string | undefined;
  private active: ActiveTurn | undefined;
  private initRequestId = "";
  private initFailure: Error | undefined;
  private initGate: { resolve: () => void; reject: (error: Error) => void } | undefined;
  private readonly pendingApprovals = new Map<string, Record<string, unknown>>();
  private closed = false;

  private constructor(
    private readonly peer: ClaudePeer,
    private readonly command: string,
    private readonly permissionMode: ClaudePermissionMode,
    private model: string | undefined,
  ) {
    this.unsubscribeMessage = peer.onMessage((message) => this.handleMessage(message));
    this.unsubscribeClose = peer.onClose((error) => this.onPeerClose(error));
  }

  static async start(options: ClaudeCodeClientOptions): Promise<ClaudeCodeClient> {
    const command = options.command ?? "claude";
    const peer = options.peer ?? spawnClaudePeer(options, command);
    const client = new ClaudeCodeClient(
      peer,
      command,
      options.permissionMode ?? "full-access",
      options.model?.trim() || undefined,
    );
    try {
      client.sendInitialize();
      await client.waitForInit(options.initTimeoutMs ?? SESSION_INIT_TIMEOUT_MS);
      return client;
    } catch (error) {
      const startup = client.initFailure ?? error;
      await client.close();
      throw startup;
    }
  }

  subscribe(listener: (event: ClaudeProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transcript(): readonly ClaudeTranscriptTurn[] {
    return this.completed;
  }

  async sendTurn(input: { text: string; model?: string }): Promise<ClaudeTurnResult> {
    this.assertOpen();
    const sessionId = this.sessionId;
    if (!sessionId) throw new ClaudeProviderError("request_failed", "Claude Code session is not started.");
    if (this.active) throw new ClaudeProviderError("request_failed", "Claude Code already has a turn in progress.");
    const model = input.model?.trim();
    const providerTurnId = randomUUID();
    this.active = { id: providerTurnId, text: "", sawPartial: false, sawText: false, tools: new Map() };
    try {
      // The session keeps its model across turns, so only a different one needs a switch.
      if (model && model !== this.model) {
        this.write(setModelRequest(`set_model_${randomUUID()}`, model));
        this.model = model;
      }
      this.write(userTurnMessage(input.text, sessionId));
    } catch (error) {
      this.active = undefined;
      throw error;
    }
    this.emit({ type: "turn.started", providerTurnId });
    return { providerTurnId };
  }

  async interruptTurn(providerTurnId?: string): Promise<void> {
    this.assertOpen();
    if (!this.active) return;
    if (providerTurnId && providerTurnId !== this.active.id) {
      throw new ClaudeProviderError("request_failed", "Claude Code turn does not match the active turn.");
    }
    this.write(interruptRequest(`interrupt_${randomUUID()}`));
    this.finishTurn("interrupted");
  }

  /** Answers a can_use_tool request raised while the session runs supervised. */
  async respondToApproval(requestId: string, allow: boolean): Promise<void> {
    this.assertOpen();
    const input = this.pendingApprovals.get(requestId);
    if (!input) throw new ClaudeProviderError("request_failed", `Claude Code approval request not found: ${requestId}`);
    this.pendingApprovals.delete(requestId);
    this.write(
      allow ? allowToolRequest(requestId, input) : denyToolRequest(requestId, "The user declined this tool call."),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeMessage();
    this.unsubscribeClose();
    await this.peer.close();
  }

  private sendInitialize(): void {
    this.initRequestId = `init_${randomUUID()}`;
    this.write(initializeRequest(this.initRequestId));
  }

  private waitForInit(timeoutMs: number): Promise<void> {
    if (this.sessionId) return Promise.resolve();
    if (this.initFailure) return Promise.reject(this.initFailure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failInit(new ClaudeProviderError("request_failed", "Claude Code CLI did not start a session."));
      }, timeoutMs);
      this.initGate = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  private handleMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object") {
      this.emit({ type: "protocol.error", message: "Malformed Claude Code message." });
      return;
    }
    this.handleToolBlocks(raw);
    const message = classifyClaudeMessage(raw);
    switch (message.kind) {
      case "init":
        if (this.sessionId) return;
        this.sessionId = message.sessionId;
        this.resolveInit();
        return;
      case "invalid":
        if (!this.sessionId && message.reason === "init") {
          this.failInit(
            new ClaudeProviderError("invalid_response", "Claude Code session init did not include a session id."),
          );
          return;
        }
        this.emit({ type: "protocol.error", message: "Malformed Claude Code message." });
        return;
      case "text":
        if (message.subagent) return;
        this.emitText(message.text, message.partial);
        return;
      case "result":
        this.onResult(message);
        return;
      case "control_request":
        this.answerControl(message);
        return;
      case "control_response":
        if (message.requestId === this.initRequestId && !message.ok && !this.sessionId) {
          this.failInit(
            new ClaudeProviderError("request_failed", message.error ?? "Claude Code rejected session initialize."),
          );
          return;
        }
        if (!message.ok) {
          this.emit({
            type: "protocol.error",
            message: message.error ?? "Claude Code rejected a control request.",
          });
        }
        return;
      default:
        return;
    }
  }

  private onResult(message: { isError: boolean; text?: string; subtype?: string }): void {
    if (!this.active) return;
    if (message.isError) {
      const detail =
        message.text?.trim() ||
        (message.subtype ? `Claude Code turn failed (${message.subtype}).` : "Claude Code turn failed.");
      this.finishTurn(message.subtype ?? "error", detail);
      return;
    }
    if (!this.active.sawText && message.text?.trim()) this.emitText(message.text, false);
    this.finishTurn("completed");
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
    this.pendingApprovals.clear();
    if (errorMessage) {
      this.completed.push({ providerTurnId: active.id, text: errorMessage, status });
      this.emit({ type: "turn.failed", providerTurnId: active.id, message: errorMessage });
      return;
    }
    this.completed.push({ providerTurnId: active.id, text: active.text, status });
    this.emit({ type: "turn.completed", providerTurnId: active.id, status });
  }

  private handleToolBlocks(raw: unknown): void {
    const active = this.active;
    if (!active) return;
    for (const block of claudeToolBlocks(raw)) {
      if (block.kind === "use") {
        const tool = { name: block.name, ...(block.input ? { input: block.input } : {}) };
        active.tools.set(block.id, tool);
        this.emit({
          type: "tool.updated",
          providerTurnId: active.id,
          tool: { callId: block.id, ...tool, status: "running" },
        });
        continue;
      }
      const started = active.tools.get(block.toolUseId);
      active.tools.delete(block.toolUseId);
      this.emit({
        type: "tool.updated",
        providerTurnId: active.id,
        tool: {
          callId: block.toolUseId,
          name: started?.name ?? "Tool",
          ...(started?.input ? { input: started.input } : {}),
          status: block.isError ? "failed" : "completed",
          ...(block.output ? { output: block.output } : {}),
        },
      });
    }
  }

  private answerControl(message: {
    requestId: string;
    subtype: string;
    toolName?: string;
    input?: Record<string, unknown>;
    toolUseId?: string;
  }): void {
    const { requestId, subtype } = message;
    try {
      if (subtype === "can_use_tool" && this.permissionMode === "supervised") {
        const input = message.input ?? {};
        this.pendingApprovals.set(requestId, input);
        this.emit({
          type: "approval.requested",
          requestId,
          payload: {
            toolName: message.toolName ?? "Tool",
            input,
            ...(message.toolUseId ? { toolUseId: message.toolUseId } : {}),
          },
        });
        return;
      }
      if (subtype === "can_use_tool") {
        this.write(denyToolRequest(requestId));
        this.emit({
          type: "protocol.error",
          message: "Claude Code requested tool approval, which this adapter does not support.",
        });
        return;
      }
      this.write(unsupportedControlResponse(requestId));
    } catch (error) {
      this.emit({
        type: "protocol.error",
        message: error instanceof Error ? error.message : "Claude Code control response failed.",
      });
    }
  }

  private onPeerClose(error?: Error): void {
    if (!this.sessionId) {
      this.failInit(this.startupError(error));
      return;
    }
    if (this.closed) return;
    const reason = error?.message ?? "Claude Code process closed.";
    if (this.active) this.finishTurn("error", reason);
    this.closed = true;
    this.unsubscribeMessage();
    this.unsubscribeClose();
    this.emit({ type: "session.closed", reason });
  }

  private startupError(error: Error | undefined): ClaudeProviderError {
    if (errnoOf(error) === "ENOENT") {
      return new ClaudeProviderError("cli_missing", `Claude Code CLI was not found at ${this.command}.`, {
        cause: error,
      });
    }
    const detail = sanitizeDetail(error?.message ?? "");
    const message = detail
      ? `Claude Code CLI exited before the session started: ${detail}`
      : "Claude Code CLI exited before the session started.";
    return error
      ? new ClaudeProviderError("request_failed", message, { cause: error })
      : new ClaudeProviderError("request_failed", message);
  }

  private failInit(error: Error): void {
    if (this.sessionId || this.initFailure) return;
    this.initFailure = error;
    const gate = this.initGate;
    this.initGate = undefined;
    gate?.reject(error);
  }

  private resolveInit(): void {
    const gate = this.initGate;
    this.initGate = undefined;
    gate?.resolve();
  }

  private assertOpen(): void {
    if (this.closed) throw new ClaudeProviderError("closed", "Claude Code session is closed.");
  }

  private write(message: unknown): void {
    if (this.closed) throw new ClaudeProviderError("closed", "Claude Code session is closed.");
    this.peer.write(encodeClaudeMessage(message));
  }

  private emit(event: ClaudeProviderEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener cannot take down the CLI transport.
      }
    }
  }
}

function spawnClaudePeer(options: ClaudeCodeClientOptions, command: string): ClaudePeer {
  if (!options.spawnProcess) {
    assertWorktree(options.cwd);
    if (isPathCommand(command)) assertClaudeBinary(command);
  }
  if (!command.trim()) {
    throw new ClaudeProviderError("cli_missing", "Claude Code CLI was not found.");
  }
  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  const args = claudeSessionArgs({
    ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    ...(options.model?.trim() ? { model: options.model.trim() } : {}),
    ...(options.mcpConfig ? { mcpConfig: options.mcpConfig } : {}),
  });
  const child = spawnProcess(command, args, {
    cwd: options.cwd,
    env: sessionEnv(options),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return new JsonlClaudePeer(child);
}

function defaultSpawn(command: string, args: readonly string[], options: ClaudeSpawnOptions): ClaudeChild {
  const child = spawnCli(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new ClaudeProviderError("request_failed", "Claude Code CLI did not provide stdio pipes.");
  }
  return child as ClaudeChild;
}

function sessionEnv(options: ClaudeCodeClientOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}), PWD: options.cwd };
  delete env.CLAUDECODE;
  return env;
}

function assertWorktree(cwd: string): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(cwd);
  } catch (error) {
    const message =
      errnoOf(error) === "ENOENT"
        ? `Claude Code working directory does not exist: ${cwd}.`
        : `Claude Code working directory is not available: ${cwd}.`;
    if (error instanceof Error) throw new ClaudeProviderError("request_failed", message, { cause: error });
    throw new ClaudeProviderError("request_failed", message);
  }
  if (!stat.isDirectory()) {
    throw new ClaudeProviderError("request_failed", `Claude Code working directory is not a directory: ${cwd}.`);
  }
}

function assertClaudeBinary(command: string): void {
  try {
    accessSync(command, constants.X_OK);
  } catch (error) {
    if (errnoOf(error) === "ENOENT") {
      throw new ClaudeProviderError("cli_missing", `Claude Code CLI was not found at ${command}.`);
    }
    const message = `Claude Code CLI is not executable at ${command}.`;
    if (error instanceof Error) throw new ClaudeProviderError("request_failed", message, { cause: error });
    throw new ClaudeProviderError("request_failed", message);
  }
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

class JsonlClaudePeer implements ClaudePeer {
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private readonly queued: unknown[] = [];
  private buffer = "";
  private stderr = "";
  private failError: Error | undefined;
  private isClosed = false;

  constructor(private readonly child: ClaudeChild) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consume(chunk));
    child.stderr.on("data", (chunk) => {
      if (this.stderr.length < 500) this.stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    // EPIPE on a dead CLI is reported by the process error handler.
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => this.fail(error));
    child.once("close", (code, signal) => this.fail(processExitError(code, signal, this.stderr)));
  }

  write(line: string): void {
    if (this.isClosed || this.child.stdin.destroyed) {
      throw new ClaudeProviderError("closed", "Claude Code session is closed.");
    }
    this.child.stdin.write(line);
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
    this.fail(new Error("Claude Code session closed."));
  }

  private consume(chunk: string | Buffer): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (this.buffer.length > MAX_CLAUDE_LINE_CHARS && !this.buffer.includes("\n")) {
      this.buffer = "";
      this.deliver(undefined);
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const decoded = decodeClaudeLine(line);
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
  return new Error(detail ? `Claude Code CLI exited (${status}): ${detail}` : `Claude Code CLI exited (${status}).`);
}
