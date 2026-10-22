import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { growth, killProcessTree, type ProviderUsage, spawnCli } from "@zli-v2/shared";

import {
  ACP_AUTH_REQUIRED,
  ACP_PROTOCOL_VERSION,
  type AcpInbound,
  decodeAcpLine,
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResult,
  InitializeResult,
  initializeParams,
  JSON_RPC_METHOD_NOT_FOUND,
  type JsonRpcId,
  MAX_ACP_LINE_CHARS,
  NewSessionResult,
  type PermissionOption,
  PromptResult,
  parseConfigOptions,
  RequestPermissionParams,
  type SessionConfigOption,
} from "./protocol.js";
import {
  type AcpToolFields,
  type AcpToolUpdate,
  acpToolUpdate,
  mergeToolFields,
  parseSessionNotification,
  promptUsage,
} from "./schema.js";

const VERSION_PROBE_MS = 1_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** ACP agents answer a cancelled prompt with stopReason "cancelled"; a new prompt waits this long for that answer. */
const CANCEL_SETTLE_MS = 5_000;
const MAX_IMAGE_BYTES = 10_000_000;
const STDERR_TAIL_CHARS = 2_000;

export type AcpPermissionMode = "full-access" | "supervised";

export type AcpProviderEvent =
  | { type: "turn.started"; providerTurnId: string }
  | { type: "assistant.delta"; providerTurnId: string; text: string }
  | { type: "turn.completed"; providerTurnId: string; status: string }
  | { type: "turn.failed"; providerTurnId: string; message: string }
  | { type: "tool.updated"; providerTurnId: string; tool: AcpToolUpdate }
  | { type: "usage.updated"; providerTurnId: string; usage: ProviderUsage }
  | { type: "approval.requested"; providerTurnId: string; requestId: string; payload: Record<string, unknown> }
  | { type: "protocol.error"; message: string }
  | { type: "session.closed"; reason: string };

export type AcpTurnResult = { providerTurnId: string };
export type AcpTranscriptTurn = { providerTurnId: string; text: string; status: string; sessionId: string };
export type AcpImageAttachment = { mimeType: string; path: string };
export type AcpPermissionAnswer = { allow: boolean; optionId?: string };

export type AcpChild = {
  readonly pid?: number | undefined;
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

/** ACP stdio MCP server passed in session/new; env is a list of name/value pairs. */
export type AcpMcpServer = {
  name: string;
  command: string;
  args: readonly string[];
  env: ReadonlyArray<{ name: string; value: string }>;
};

export type AcpSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: readonly ["pipe", "pipe", "pipe"];
  windowsHide: true;
};

export type AcpClientOptions = {
  cwd: string;
  command: string;
  /** Arguments that put the CLI in ACP stdio mode, such as ["acp"] or ["--acp"]. */
  args?: readonly string[];
  /** Product name used in messages, such as "OpenCode". */
  displayName?: string;
  /** Shown when the agent reports that it needs a login. */
  authHint?: string;
  env?: NodeJS.ProcessEnv;
  permissionMode?: AcpPermissionMode;
  /** Model selected at session start and kept for turns that do not name one. */
  model?: string;
  /** MCP servers the agent connects to for this session only. */
  mcpServers?: readonly AcpMcpServer[];
  requestTimeoutMs?: number;
  spawnProcess?: (command: string, args: readonly string[], options: AcpSpawnOptions) => AcpChild;
  readAttachment?: (path: string) => Promise<Buffer>;
};

export class AcpProviderError extends Error {
  constructor(
    readonly code: "cli_missing" | "auth_required" | "invalid_response" | "request_failed" | "closed" | "unsupported",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AcpProviderError";
  }
}

/** A JSON-RPC error answer from the agent. */
export class AcpRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

type PendingPermission = {
  rpcId: JsonRpcId;
  turnId: string;
  options: PermissionOption[];
};

type ActiveTurn = {
  id: string;
  text: string;
  tools: Map<string, AcpToolFields>;
  /** False until session/prompt is sent, so late updates from a cancelled prompt are not attributed to this turn. */
  prompted: boolean;
};

type ModelApi = "config" | "legacy" | "none";

export class AcpClient {
  private readonly listeners = new Set<(event: AcpProviderEvent) => void>();
  private readonly completed: AcpTranscriptTurn[] = [];
  private readonly permissions = new Map<string, PendingPermission>();
  private sessionId = "";
  private imageInput = false;
  private authDescription: string | undefined;
  private configOptions: SessionConfigOption[] = [];
  private legacyModelId: string | undefined;
  private legacyModels = false;
  private modelApi: ModelApi | undefined;
  private active: ActiveTurn | undefined;
  /** Usage arrives in pieces and can land just after the prompt settles, so it stays with its turn. */
  private usageTurn: { id: string; costBefore?: number; usage: ProviderUsage } | undefined;
  private sessionCostUsd: number | undefined;
  private promptSettled: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly connection: AcpConnection,
    private readonly cwd: string,
    private readonly displayName: string,
    private readonly authHint: string | undefined,
    private readonly permissionMode: AcpPermissionMode,
    private readonly timeoutMs: number,
    private readonly readAttachment: (path: string) => Promise<Buffer>,
  ) {
    connection.onNotification = (method, params) => this.onNotification(method, params);
    connection.onRequest = (id, method, params) => this.onRequest(id, method, params);
    connection.onClose = (error) => this.onConnectionClose(error);
    connection.onOverflow = () =>
      this.emit({ type: "protocol.error", message: `${this.displayName} sent a message larger than ZLI accepts.` });
  }

  static async start(options: AcpClientOptions): Promise<AcpClient> {
    const displayName = options.displayName?.trim() || "ACP agent";
    const command = options.command;
    if (!command.trim()) throw new AcpProviderError("cli_missing", `${displayName} CLI was not found.`);
    if (!options.spawnProcess) {
      assertWorktree(options.cwd, displayName);
      await assertCommand(command, displayName);
    }
    const spawnProcess = options.spawnProcess ?? defaultSpawn;
    let child: AcpChild;
    try {
      child = spawnProcess(command, options.args ?? [], {
        cwd: options.cwd,
        env: sessionEnv(options.env, options.cwd),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw startError(error, command, displayName);
    }
    const client = new AcpClient(
      new AcpConnection(child, displayName),
      options.cwd,
      displayName,
      options.authHint?.trim() || undefined,
      options.permissionMode ?? "full-access",
      options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      options.readAttachment ?? ((path) => readFile(path)),
    );
    try {
      await client.handshake(options.model?.trim() || undefined, options.mcpServers ?? []);
    } catch (error) {
      await client.close();
      throw startError(error, command, displayName);
    }
    return client;
  }

  /** True when the agent accepts image content blocks in prompts. */
  get supportsImages(): boolean {
    return this.imageInput;
  }

  get agentSessionId(): string {
    return this.sessionId;
  }

  subscribe(listener: (event: AcpProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transcript(): readonly AcpTranscriptTurn[] {
    return this.completed;
  }

  async sendTurn(input: {
    text: string;
    model?: string;
    attachments?: readonly AcpImageAttachment[];
  }): Promise<AcpTurnResult> {
    this.assertOpen();
    if (this.active)
      throw new AcpProviderError("request_failed", `${this.displayName} already has a turn in progress.`);
    const turn: ActiveTurn = { id: randomUUID(), text: "", tools: new Map(), prompted: false };
    this.active = turn;
    let prompt: Array<Record<string, unknown>>;
    try {
      await settleWithin(this.promptSettled, CANCEL_SETTLE_MS);
      this.assertOpen();
      const model = input.model?.trim();
      if (model) await this.applyModel(model);
      prompt = [{ type: "text", text: input.text }, ...(await this.imageBlocks(input.attachments ?? []))];
      this.assertOpen();
    } catch (error) {
      if (this.active === turn) this.active = undefined;
      throw error;
    }
    turn.prompted = true;
    const response = this.connection.request("session/prompt", { sessionId: this.sessionId, prompt });
    this.promptSettled = response.then(
      () => undefined,
      () => undefined,
    );
    this.emit({ type: "turn.started", providerTurnId: turn.id });
    response.then(
      (result) => this.onPromptResult(turn.id, result),
      (error: unknown) => this.onPromptError(turn.id, error),
    );
    return { providerTurnId: turn.id };
  }

  async interruptTurn(providerTurnId?: string): Promise<void> {
    this.assertOpen();
    const active = this.active;
    if (!active) return;
    if (providerTurnId && providerTurnId !== active.id) {
      throw new AcpProviderError("request_failed", `${this.displayName} turn does not match the active turn.`);
    }
    this.connection.notify("session/cancel", { sessionId: this.sessionId });
    this.cancelPermissions(active.id);
    this.finishTurn("interrupted");
  }

  /** Answers a session/request_permission raised while the session runs supervised. */
  async respondToPermission(requestId: string, answer: AcpPermissionAnswer): Promise<void> {
    this.assertOpen();
    const pending = this.permissions.get(requestId);
    if (!pending) {
      throw new AcpProviderError("request_failed", `${this.displayName} approval request not found: ${requestId}`);
    }
    this.permissions.delete(requestId);
    const explicit = answer.optionId
      ? pending.options.find((option) => option.optionId === answer.optionId)
      : undefined;
    const option =
      explicit ??
      (answer.allow
        ? pickOption(pending.options, ["allow_once", "allow_always"], "allow")
        : pickOption(pending.options, ["reject_once", "reject_always"], "reject"));
    this.connection.respond(pending.rpcId, permissionOutcome(option));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.active = undefined;
    this.permissions.clear();
    await this.connection.close();
  }

  private async handshake(model: string | undefined, mcpServers: readonly AcpMcpServer[]): Promise<void> {
    const init = InitializeResult.safeParse(
      await this.connection.request("initialize", initializeParams(), this.timeoutMs),
    );
    if (!init.success) {
      throw new AcpProviderError("invalid_response", `${this.displayName} sent an invalid ACP initialize response.`);
    }
    if (init.data.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new AcpProviderError(
        "unsupported",
        `${this.displayName} speaks ACP version ${init.data.protocolVersion}; ZLI supports version ${ACP_PROTOCOL_VERSION}.`,
      );
    }
    this.imageInput = init.data.agentCapabilities?.promptCapabilities?.image === true;
    this.authDescription = init.data.authMethods?.find((method) => method.description?.trim())?.description?.trim();
    let created: unknown;
    try {
      created = await this.connection.request("session/new", { cwd: this.cwd, mcpServers }, this.timeoutMs);
    } catch (error) {
      if (isAuthError(error)) throw new AcpProviderError("auth_required", this.authMessage(error), { cause: error });
      throw error;
    }
    const session = NewSessionResult.safeParse(created);
    if (!session.success) {
      throw new AcpProviderError("invalid_response", `${this.displayName} did not return an ACP session id.`);
    }
    this.sessionId = session.data.sessionId;
    this.configOptions = parseConfigOptions(session.data.configOptions);
    if (session.data.models) {
      this.legacyModels = true;
      this.legacyModelId = session.data.models.currentModelId;
    }
    // Kimi Code opens a session while signed out, then ends every prompt at once with no reply.
    // An empty model picker with no current model is the only sign of that before the first prompt.
    const modelOption = this.modelOption();
    if (modelOption && (modelOption.options ?? []).length === 0 && !modelOption.currentValue) {
      throw new AcpProviderError("auth_required", `${this.displayName} has no model set up. ${this.authMessage()}`);
    }
    if (model) await this.applyModel(model);
  }

  /**
   * Prefers session config options (current ACP), then the older session/set_model.
   * An agent without either keeps its own model; a rejected model id is an error.
   */
  private async applyModel(model: string): Promise<void> {
    if (this.currentModel() === model) return;
    const option = this.modelOption();
    if (option && this.modelApi !== "legacy" && this.modelApi !== "none") {
      try {
        const result = await this.connection.request(
          "session/set_config_option",
          { sessionId: this.sessionId, configId: option.id, value: model },
          this.timeoutMs,
        );
        const updated = parseConfigOptions(asRecord(result)?.configOptions);
        if (updated.length > 0) this.configOptions = updated;
        else option.currentValue = model;
        this.modelApi = "config";
        return;
      } catch (error) {
        if (!isMethodNotFound(error)) throw this.modelError(model, error);
      }
    }
    if (this.modelApi === "none") return;
    try {
      await this.connection.request("session/set_model", { sessionId: this.sessionId, modelId: model }, this.timeoutMs);
      this.legacyModelId = model;
      this.modelApi = "legacy";
    } catch (error) {
      if (!isMethodNotFound(error)) throw this.modelError(model, error);
      this.modelApi = "none";
    }
  }

  private modelOption(): SessionConfigOption | undefined {
    return (
      this.configOptions.find((option) => option.category === "model") ??
      this.configOptions.find((option) => option.id === "model")
    );
  }

  private currentModel(): string | undefined {
    const value = this.modelOption()?.currentValue;
    if (typeof value === "string" && value.length > 0) return value;
    return this.legacyModels ? this.legacyModelId : undefined;
  }

  private modelError(model: string, error: unknown): AcpProviderError {
    return new AcpProviderError(
      "request_failed",
      `${this.displayName} could not switch to model ${model}: ${errorDetail(error)}`,
      { cause: error },
    );
  }

  private async imageBlocks(attachments: readonly AcpImageAttachment[]): Promise<Array<Record<string, unknown>>> {
    if (!this.imageInput || attachments.length === 0) return [];
    const blocks: Array<Record<string, unknown>> = [];
    for (const attachment of attachments) {
      try {
        const bytes = await this.readAttachment(attachment.path);
        if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) continue;
        blocks.push({ type: "image", mimeType: attachment.mimeType, data: bytes.toString("base64") });
      } catch {
        // The prompt text already lists the path, so an unreadable image is not fatal.
      }
    }
    return blocks;
  }

  private onPromptResult(turnId: string, result: unknown): void {
    if (this.closed || this.active?.id !== turnId) return;
    this.cancelPermissions(turnId);
    const usage = promptUsage(result);
    if (usage) this.noteUsage(turnId, usage);
    const parsed = PromptResult.safeParse(result);
    if (!parsed.success) {
      this.emit({ type: "protocol.error", message: `${this.displayName} sent an invalid prompt response.` });
      this.finishTurn("completed");
      return;
    }
    this.finishTurn(turnStatus(parsed.data.stopReason));
  }

  private onPromptError(turnId: string, error: unknown): void {
    if (this.closed || this.active?.id !== turnId) return;
    this.cancelPermissions(turnId);
    const message = isAuthError(error)
      ? this.authMessage(error)
      : `${this.displayName} turn failed: ${errorDetail(error)}`;
    this.finishTurn("error", message);
  }

  private onNotification(method: string, params: unknown): void {
    if (this.closed || method !== "session/update") return;
    const notification = parseSessionNotification(params);
    if (!notification) {
      this.emit({ type: "protocol.error", message: `Malformed ${this.displayName} session update.` });
      return;
    }
    if (notification.sessionId !== this.sessionId) return;
    const { update } = notification;
    const active = this.active?.prompted ? this.active : undefined;
    switch (update.kind) {
      case "text": {
        if (!active) return;
        active.text += update.text;
        this.emit({ type: "assistant.delta", providerTurnId: active.id, text: update.text });
        return;
      }
      case "tool": {
        if (!active) return;
        const fields = mergeToolFields(active.tools.get(update.toolCallId), update.fields);
        active.tools.set(update.toolCallId, fields);
        this.emit({
          type: "tool.updated",
          providerTurnId: active.id,
          tool: acpToolUpdate(update.toolCallId, fields),
        });
        return;
      }
      case "config":
        if (update.configOptions.length > 0) this.configOptions = update.configOptions;
        return;
      case "usage": {
        const turnId = active?.id ?? this.usageTurn?.id;
        if (turnId) this.noteUsage(turnId, update.usage, update.totalCostUsd);
        else if (update.totalCostUsd !== undefined) this.sessionCostUsd = update.totalCostUsd;
        return;
      }
      case "invalid":
        this.emit({ type: "protocol.error", message: `Malformed ${this.displayName} session update.` });
        return;
      default:
        return;
    }
  }

  private onRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (method !== "session/request_permission") {
      this.connection.respondError(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
      return;
    }
    const parsed = RequestPermissionParams.safeParse(params);
    if (!parsed.success) {
      this.connection.respondError(id, -32602, "Invalid session/request_permission params.");
      return;
    }
    const active = this.active?.prompted ? this.active : undefined;
    if (this.closed || !active || (parsed.data.sessionId && parsed.data.sessionId !== this.sessionId)) {
      this.connection.respond(id, permissionOutcome(undefined));
      return;
    }
    const { options } = parsed.data;
    if (this.permissionMode === "full-access") {
      this.connection.respond(id, permissionOutcome(pickOption(options, ["allow_always", "allow_once"], "allow")));
      return;
    }
    const requestId = randomUUID();
    this.permissions.set(requestId, { rpcId: id, turnId: active.id, options });
    this.emit({
      type: "approval.requested",
      providerTurnId: active.id,
      requestId,
      payload: permissionPayload(parsed.data.toolCall ?? {}, options),
    });
  }

  private noteUsage(turnId: string, reported: ProviderUsage, totalCostUsd?: number): void {
    if (this.usageTurn?.id !== turnId) {
      this.usageTurn = {
        id: turnId,
        ...(this.sessionCostUsd === undefined ? {} : { costBefore: this.sessionCostUsd }),
        usage: {},
      };
    }
    const turn = this.usageTurn;
    turn.usage = { ...turn.usage, ...reported };
    if (totalCostUsd !== undefined) {
      const costUsd = growth(totalCostUsd, turn.costBefore);
      if (costUsd !== undefined) turn.usage.costUsd = costUsd;
      this.sessionCostUsd = totalCostUsd;
    }
    if (Object.keys(turn.usage).length > 0)
      this.emit({ type: "usage.updated", providerTurnId: turnId, usage: { ...turn.usage } });
  }

  private cancelPermissions(turnId: string): void {
    for (const [requestId, pending] of this.permissions) {
      if (pending.turnId !== turnId) continue;
      this.permissions.delete(requestId);
      this.connection.respond(pending.rpcId, permissionOutcome(undefined));
    }
  }

  private finishTurn(status: string, errorMessage?: string): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    if (errorMessage) {
      this.completed.push({ providerTurnId: active.id, text: errorMessage, status, sessionId: this.sessionId });
      this.emit({ type: "turn.failed", providerTurnId: active.id, message: errorMessage });
      return;
    }
    this.completed.push({ providerTurnId: active.id, text: active.text, status, sessionId: this.sessionId });
    this.emit({ type: "turn.completed", providerTurnId: active.id, status });
  }

  private onConnectionClose(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.permissions.clear();
    if (this.active) this.finishTurn("error", error.message);
    this.emit({ type: "session.closed", reason: error.message });
  }

  /** An error recognized only by its wording keeps the agent's own text, which may say more than "sign in". */
  private authMessage(error?: unknown): string {
    const hint = this.authHint
      ? this.authHint
      : this.authDescription
        ? `Sign in to ${this.displayName} first: ${this.authDescription}`
        : `Sign in to ${this.displayName} in a terminal first.`;
    if (error instanceof AcpRpcError && error.rpcCode !== ACP_AUTH_REQUIRED) {
      return `${this.displayName} reported: ${errorDetail(error)} ${hint}`;
    }
    return hint;
  }

  private assertOpen(): void {
    if (this.closed) throw new AcpProviderError("closed", `${this.displayName} session is closed.`);
  }

  private emit(event: AcpProviderEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener cannot take down the agent transport.
      }
    }
  }
}

function turnStatus(stopReason: string): string {
  if (stopReason === "end_turn") return "completed";
  if (stopReason === "cancelled") return "interrupted";
  return stopReason;
}

function pickOption(
  options: readonly PermissionOption[],
  preferred: readonly string[],
  prefix: string,
): PermissionOption | undefined {
  for (const kind of preferred) {
    const match = options.find((option) => option.kind === kind);
    if (match) return match;
  }
  return options.find((option) => option.kind?.startsWith(prefix));
}

function permissionOutcome(option: PermissionOption | undefined): Record<string, unknown> {
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function permissionPayload(
  toolCall: Record<string, unknown>,
  options: readonly PermissionOption[],
): Record<string, unknown> {
  const title = typeof toolCall.title === "string" && toolCall.title.trim() ? toolCall.title.trim() : undefined;
  const input = asRecord(toolCall.rawInput);
  return {
    toolName: title ?? "Tool",
    input: input ?? {},
    ...(typeof toolCall.toolCallId === "string" ? { toolCallId: toolCall.toolCallId } : {}),
    ...(typeof toolCall.kind === "string" ? { kind: toolCall.kind } : {}),
    options: options.map((option) => ({
      optionId: option.optionId,
      ...(option.name ? { name: option.name } : {}),
      ...(option.kind ? { kind: option.kind } : {}),
    })),
  };
}

const AUTH_TEXT = /\b(auth\w*|log(?:ged)? ?in|sign(?:ed)? ?in|unauthori[sz]ed|credentials?|api[ _-]?key)\b/iu;

export function isAuthError(error: unknown): boolean {
  if (error instanceof AcpProviderError) return error.code === "auth_required";
  if (!(error instanceof AcpRpcError)) return false;
  if (error.rpcCode === ACP_AUTH_REQUIRED) return true;
  return AUTH_TEXT.test(errorDetail(error));
}

function isMethodNotFound(error: unknown): boolean {
  return error instanceof AcpRpcError && error.rpcCode === JSON_RPC_METHOD_NOT_FOUND;
}

function errorDetail(error: unknown): string {
  if (error instanceof AcpRpcError) {
    const data = asRecord(error.data);
    const details = typeof data?.details === "string" ? data.details : undefined;
    return sanitizeDetail(details ? `${error.message} (${details})` : error.message);
  }
  return error instanceof Error ? sanitizeDetail(error.message) : "Unknown error.";
}

function startError(error: unknown, command: string, displayName: string): Error {
  if (error instanceof AcpProviderError) return error;
  if (errnoOf(error) === "ENOENT" || errnoOf(error instanceof Error ? error.cause : undefined) === "ENOENT") {
    return new AcpProviderError(
      "cli_missing",
      `${displayName} CLI was not found at ${command}.`,
      error instanceof Error ? { cause: error } : undefined,
    );
  }
  if (error instanceof AcpRpcError) {
    return new AcpProviderError(
      "request_failed",
      `${displayName} could not start an ACP session: ${errorDetail(error)}`,
      {
        cause: error,
      },
    );
  }
  return error instanceof Error ? error : new AcpProviderError("request_failed", `${displayName} could not start.`);
}

async function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
  if (timer) clearTimeout(timer);
}

function defaultSpawn(command: string, args: readonly string[], options: AcpSpawnOptions): AcpChild {
  const child = spawnCli(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill();
    throw new AcpProviderError("request_failed", "The ACP agent did not provide stdio pipes.");
  }
  // Agents start language servers and shells of their own, so stopping only the
  // direct child would leave those running.
  const kill = child.kill.bind(child);
  child.kill = (signal?: NodeJS.Signals | number) => killProcessTree({ pid: child.pid, kill: () => kill(signal) });
  return child as AcpChild;
}

function sessionEnv(base: NodeJS.ProcessEnv | undefined, cwd: string): NodeJS.ProcessEnv {
  return { ...process.env, ...(base ?? {}), PWD: cwd };
}

function assertWorktree(cwd: string, displayName: string): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(cwd);
  } catch (error) {
    const message =
      errnoOf(error) === "ENOENT"
        ? `${displayName} working directory does not exist: ${cwd}.`
        : `${displayName} working directory is not available: ${cwd}.`;
    if (error instanceof Error) throw new AcpProviderError("request_failed", message, { cause: error });
    throw new AcpProviderError("request_failed", message);
  }
  if (!stat.isDirectory()) {
    throw new AcpProviderError("request_failed", `${displayName} working directory is not a directory: ${cwd}.`);
  }
}

async function assertCommand(command: string, displayName: string): Promise<void> {
  if (command.includes("/") || command.includes("\\")) {
    try {
      accessSync(command, constants.X_OK);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") {
        throw new AcpProviderError("cli_missing", `${displayName} CLI was not found at ${command}.`);
      }
      const message = `${displayName} CLI is not executable at ${command}.`;
      if (error instanceof Error) throw new AcpProviderError("request_failed", message, { cause: error });
      throw new AcpProviderError("request_failed", message);
    }
    return;
  }
  await assertBareCommand(command, displayName);
}

// Some agent CLIs stay silent on --version without a TTY, so a probe that is
// still running when the timer fires counts as a launchable command.
function assertBareCommand(command: string, displayName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnCli(command, ["--version"], { windowsHide: true, stdio: "ignore" });
    } catch (error) {
      reject(startError(error, command, displayName));
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
        finish(
          new AcpProviderError("cli_missing", `${displayName} CLI was not found at ${command}.`, { cause: error }),
        );
        return;
      }
      finish(
        new AcpProviderError("request_failed", `${displayName} CLI could not be started at ${command}.`, {
          cause: error,
        }),
      );
    });
    child.once("close", () => finish());
  });
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function sanitizeDetail(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 300);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

/** Newline-delimited JSON-RPC 2.0 over the agent's stdio. */
class AcpConnection {
  onNotification: (method: string, params: unknown) => void = () => undefined;
  onRequest: (id: JsonRpcId, method: string, params: unknown) => void = () => undefined;
  onClose: (error: Error) => void = () => undefined;
  onOverflow: () => void = () => undefined;

  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private failure: Error | undefined;

  constructor(
    private readonly child: AcpChild,
    private readonly displayName: string,
  ) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consume(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + (typeof chunk === "string" ? chunk : chunk.toString("utf8"))).slice(
        -STDERR_TAIL_CHARS,
      );
    });
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => this.fail(error));
    child.once("close", (code, signal) => this.fail(this.exitError(code, signal)));
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new AcpProviderError("request_failed", `${this.displayName} did not answer ${method} in time.`));
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write(encodeRequest(id, method, params));
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.tryWrite(encodeNotification(method, params));
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.tryWrite(encodeResult(id, result));
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.tryWrite(encodeError(id, code, message));
  }

  async close(): Promise<void> {
    if (this.failure) return;
    const closing = new AcpProviderError("closed", `${this.displayName} session closed.`);
    this.failure = closing;
    this.rejectPending(closing);
    try {
      this.child.stdin.end?.();
      this.child.kill();
    } catch (error) {
      if (errnoOf(error) !== "ESRCH") throw error;
    }
  }

  private write(data: string): void {
    if (this.child.stdin.destroyed) {
      throw new AcpProviderError("closed", `${this.displayName} session is closed.`);
    }
    this.child.stdin.write(data);
  }

  private tryWrite(data: string): void {
    if (this.failure) return;
    try {
      this.write(data);
    } catch {
      // Notifications and answers have no caller; a dead pipe surfaces through the close event.
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_ACP_LINE_CHARS) {
      this.buffer = "";
      this.onOverflow();
    }
  }

  private handleLine(line: string): void {
    const decoded = decodeAcpLine(line);
    if (decoded.type !== "message") return;
    this.dispatch(decoded.message);
  }

  private dispatch(message: AcpInbound): void {
    if (this.failure) return;
    switch (message.type) {
      case "response": {
        if (typeof message.id !== "number") return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (message.error)
          pending.reject(new AcpRpcError(message.error.code, message.error.message, message.error.data));
        else pending.resolve(message.result);
        return;
      }
      case "request":
        this.onRequest(message.id, message.method, message.params);
        return;
      case "notification":
        this.onNotification(message.method, message.params);
        return;
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.onClose(error);
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      if (request.timer) clearTimeout(request.timer);
      request.reject(error);
    }
  }

  private exitError(code: number | null, signal: NodeJS.Signals | null): Error {
    const status = `${code ?? "unknown"}${signal ? `/${signal}` : ""}`;
    const detail = sanitizeDetail(this.stderr).slice(-180);
    return new AcpProviderError(
      "closed",
      detail ? `${this.displayName} exited (${status}): ${detail}` : `${this.displayName} exited (${status}).`,
    );
  }
}
