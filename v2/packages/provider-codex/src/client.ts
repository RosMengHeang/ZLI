import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { spawnCli } from "@zli-v2/shared";

import { decodeJsonRpc, encodeJsonRpc, JsonRpcId, JsonRpcMessage, JsonRpcResponse } from "./protocol.js";
import {
  type CodexToolUpdate,
  codexItemTool,
  ThreadReadResponse,
  ThreadStartResponse,
  TurnStartResponse,
} from "./schema.js";

export type CodexPeer = {
  request(method: string, params?: unknown): Promise<unknown>;
  notify?(method: string, params?: unknown): Promise<void>;
  respond(requestId: JsonRpcId, result: unknown): Promise<void>;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
  close(): Promise<void>;
};

export type CodexProviderEvent =
  | { type: "thread.started"; providerThreadId: string }
  | { type: "turn.started"; providerThreadId: string; providerTurnId: string }
  | { type: "assistant.delta"; providerThreadId: string; providerTurnId: string; text: string }
  | { type: "turn.completed"; providerThreadId: string; providerTurnId: string; status: string }
  | { type: "tool.updated"; providerThreadId: string; providerTurnId: string; tool: CodexToolUpdate }
  | {
      type: "approval.requested";
      requestId: string;
      providerThreadId: string;
      providerTurnId: string;
      payload: Record<string, unknown>;
    }
  | {
      type: "user-input.requested";
      requestId: string;
      providerThreadId: string;
      providerTurnId: string;
      payload: Record<string, unknown>;
    }
  | { type: "protocol.notification"; method: string; payload: unknown }
  | { type: "protocol.error"; message: string }
  | { type: "session.closed"; reason: string };

export type CodexAppServerClientOptions = {
  peer?: CodexPeer;
  command?: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type CodexSessionStartInput = {
  cwd: string;
  model?: string;
  approvalPolicy?: unknown;
  sandboxPolicy?: unknown;
  /** Dotted config keys overridden for this thread only, like `-c` on the command line. */
  config?: Record<string, unknown>;
};
export type CodexTurnInput = {
  providerThreadId: string;
  text: string;
  model?: string;
  effort?: string;
  /** Local image files sent as localImage inputs next to the text. */
  imagePaths?: readonly string[];
};
export type CodexTurnResult = { providerTurnId: string };

export class CodexProviderError extends Error {
  constructor(
    readonly code: "invalid_response" | "request_failed" | "closed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexProviderError";
  }
}

export class CodexAppServerClient {
  private readonly eventListeners = new Set<(event: CodexProviderEvent) => void>();
  private readonly serverRequestIds = new Map<string, JsonRpcId>();
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeClose: () => void;
  private closed = false;

  private constructor(private readonly peer: CodexPeer) {
    this.unsubscribeMessage = peer.onMessage((message) => this.handleMessage(message));
    this.unsubscribeClose = peer.onClose((error) => {
      if (this.closed) return;
      this.closed = true;
      this.emit({ type: "session.closed", reason: error?.message ?? "Codex process closed." });
    });
  }

  static async connect(options: CodexAppServerClientOptions = {}): Promise<CodexAppServerClient> {
    const peer = options.peer ?? (await spawnCodexPeer(options));
    const client = new CodexAppServerClient(peer);
    try {
      await peer.request("initialize", {
        clientInfo: { name: "zli-v2", version: "0.0.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
      });
      await peer.notify?.("initialized", {});
      return client;
    } catch (error) {
      await peer.close();
      throw new CodexProviderError("request_failed", "Codex app-server initialization failed.", { cause: error });
    }
  }

  subscribe(listener: (event: CodexProviderEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async startSession(input: CodexSessionStartInput): Promise<{ providerThreadId: string }> {
    const result = ThreadStartResponse.parse(
      await this.request("thread/start", {
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
        ...(input.sandboxPolicy === undefined ? {} : { sandbox: input.sandboxPolicy }),
        ...(input.config ? { config: input.config } : {}),
      }),
    );
    return { providerThreadId: result.thread.id };
  }

  async sendTurn(input: CodexTurnInput): Promise<CodexTurnResult> {
    const result = TurnStartResponse.parse(
      await this.request("turn/start", {
        threadId: input.providerThreadId,
        input: [
          { type: "text", text: input.text },
          ...(input.imagePaths ?? []).map((path) => ({ type: "localImage", path })),
        ],
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
      }),
    );
    return { providerTurnId: result.turn.id };
  }

  async interruptTurn(providerThreadId: string, providerTurnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId: providerThreadId, turnId: providerTurnId });
  }

  async respondToRequest(requestId: string | number, result: unknown): Promise<void> {
    const key = String(requestId);
    const providerRequestId = this.serverRequestIds.get(key) ?? JsonRpcId.parse(requestId);
    this.serverRequestIds.delete(key);
    await this.peer.respond(providerRequestId, result);
  }

  async readThread(providerThreadId: string): Promise<{ providerThreadId: string; turns: unknown[] }> {
    const result = ThreadReadResponse.parse(
      await this.request("thread/read", { threadId: providerThreadId, includeTurns: true }),
    );
    return { providerThreadId: result.thread.id, turns: result.thread.turns ?? [] };
  }

  async rollbackThread(
    providerThreadId: string,
    numTurns: number,
  ): Promise<{ providerThreadId: string; turns: unknown[] }> {
    if (!Number.isInteger(numTurns) || numTurns < 1)
      throw new CodexProviderError("request_failed", "Rollback requires at least one turn.");
    const result = ThreadReadResponse.parse(
      await this.request("thread/rollback", { threadId: providerThreadId, numTurns }),
    );
    return { providerThreadId: result.thread.id, turns: result.thread.turns ?? [] };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeMessage();
    this.unsubscribeClose();
    await this.peer.close();
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new CodexProviderError("closed", "Codex app-server is closed.");
    try {
      return await this.peer.request(method, params);
    } catch (error) {
      throw new CodexProviderError("request_failed", `Codex request failed: ${method}.`, { cause: error });
    }
  }

  private handleMessage(raw: unknown): void {
    const parsed = JsonRpcMessage.safeParse(raw);
    if (!parsed.success) {
      this.emit({ type: "protocol.error", message: "Malformed Codex server message." });
      return;
    }
    if (!("method" in parsed.data)) return;
    const params = asRecord(parsed.data.params);
    const method = parsed.data.method;
    if ("id" in parsed.data && isApprovalMethod(method)) {
      const requestId = String(parsed.data.id);
      this.serverRequestIds.set(requestId, parsed.data.id);
      if (method.includes("requestUserInput")) {
        this.emit({
          type: "user-input.requested",
          requestId,
          providerThreadId: String(params?.threadId ?? ""),
          providerTurnId: String(params?.turnId ?? ""),
          payload: params ?? {},
        });
      } else {
        this.emit({
          type: "approval.requested",
          requestId,
          providerThreadId: String(params?.threadId ?? ""),
          providerTurnId: String(params?.turnId ?? ""),
          payload: params ?? {},
        });
      }
      return;
    }
    const event = normalizeNotification(method, params);
    if (event) this.emit(event);
    else if (isKnownNotificationMethod(method))
      this.emit({ type: "protocol.error", message: "Malformed Codex server message." });
    else this.emit({ type: "protocol.notification", method, payload: parsed.data.params });
  }

  private emit(event: CodexProviderEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Event consumers cannot invalidate the provider transport.
      }
    }
  }
}

type SpawnedPeer = CodexPeer & { notify(method: string, params?: unknown): Promise<void> };

async function spawnCodexPeer(options: CodexAppServerClientOptions): Promise<SpawnedPeer> {
  const child = spawnCli(options.command ?? "codex", ["app-server", ...(options.args ?? [])], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new CodexProviderError("request_failed", "Codex did not provide stdio pipes.");
  }
  // Unread stderr would eventually fill the pipe and stall the app server.
  child.stderr.resume();
  return new JsonlCodexPeer(child as ChildProcessWithoutNullStreams);
}

class JsonlCodexPeer implements SpawnedPeer {
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private nextId = 1;
  private buffer = "";
  private isClosed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.once("error", (error) => this.fail(error));
    child.once("close", (code, signal) =>
      this.fail(new Error(`Codex process exited (${code ?? "unknown"}${signal ? `/${signal}` : ""}).`)),
    );
  }

  request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(String(id), { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  respond(requestId: JsonRpcId, result: unknown): Promise<void> {
    this.write({ jsonrpc: "2.0", id: requestId, result });
    return Promise.resolve();
  }

  notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    return Promise.resolve();
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.child.kill();
    this.fail(new Error("Codex app-server closed."));
  }

  private write(message: JsonRpcMessage): void {
    if (this.isClosed || this.child.stdin.destroyed)
      throw new CodexProviderError("closed", "Codex app-server is closed.");
    this.child.stdin.write(encodeJsonRpc(message));
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      const message = decodeJsonRpc(line);
      if (!message) {
        for (const listener of this.messageListeners) listener(undefined);
      } else if ("id" in message && !("method" in message)) {
        const pending = this.pending.get(String(message.id));
        if (pending) {
          this.pending.delete(String(message.id));
          const response = JsonRpcResponse.parse(message);
          if (response.error) pending.reject(new Error(response.error.message));
          else pending.resolve(response.result);
        }
      } else {
        for (const listener of this.messageListeners) listener(message);
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private fail(error: Error): void {
    if (this.isClosed && this.pending.size === 0) return;
    this.isClosed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const listener of this.closeListeners) listener(error);
  }
}

function normalizeNotification(
  method: string,
  params: Record<string, unknown> | undefined,
): CodexProviderEvent | undefined {
  if (!params) return undefined;
  if (method === "item/started" || method === "item/completed") {
    const tool = codexItemTool(params, method === "item/completed");
    return tool ? { type: "tool.updated", ...tool } : undefined;
  }
  const threadId = params.threadId;
  // app-server v2 nests the turn ({ threadId, turn: { id, status } }); older builds sent turnId at the top level.
  const turn = asRecord(params.turn);
  const turnId = params.turnId ?? turn?.id;
  if (method === "thread/started") {
    const providerThreadId = typeof threadId === "string" ? threadId : asRecord(params.thread)?.id;
    return typeof providerThreadId === "string" && providerThreadId.length > 0
      ? { type: "thread.started", providerThreadId }
      : undefined;
  }
  if (typeof threadId !== "string" || typeof turnId !== "string") return undefined;
  if (method === "turn/started") return { type: "turn.started", providerThreadId: threadId, providerTurnId: turnId };
  if (method === "item/agentMessage/delta")
    return {
      type: "assistant.delta",
      providerThreadId: threadId,
      providerTurnId: turnId,
      text: String(params.delta ?? params.text ?? ""),
    };
  if (method === "turn/completed")
    return {
      type: "turn.completed",
      providerThreadId: threadId,
      providerTurnId: turnId,
      status: String(params.status ?? turn?.status ?? "completed"),
    };
  return undefined;
}

function isKnownNotificationMethod(method: string): boolean {
  return (
    method === "thread/started" ||
    method === "turn/started" ||
    method === "item/agentMessage/delta" ||
    method === "turn/completed"
  );
}

function isApprovalMethod(method: string): boolean {
  return (
    method.includes("requestApproval") || method.includes("requestUserInput") || method.includes("request_user_input")
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
