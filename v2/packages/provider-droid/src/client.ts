import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { hostname } from "node:os";

import { type ProviderUsage, spawnCli } from "@zli-v2/shared";

import {
  type DroidPermissionMode,
  decodeDroidLine,
  droidArgs,
  droidErrorResponse,
  droidRequest,
  droidResponse,
  droidSessionSettings,
  MAX_DROID_LINE_CHARS,
} from "./protocol.js";
import {
  classifyDroidMessage,
  type DroidNotification,
  type DroidQuestion,
  type DroidReportedSettings,
  type DroidToolUse,
  modelDefaults,
  parsePermissionRequest,
  parseQuestions,
  reportedSettings,
} from "./schema.js";

const VERSION_PROBE_MS = 1_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** How long a new turn waits for Droid to wind down a turn that ended early on this side. */
const SETTLE_MS = 5_000;
const MESSAGE_SEPARATOR = "\n\n";

export type DroidProviderEvent =
  | { type: "turn.started"; providerTurnId: string }
  | { type: "assistant.delta"; providerTurnId: string; text: string }
  | { type: "turn.completed"; providerTurnId: string; status: string }
  | { type: "turn.failed"; providerTurnId: string; message: string }
  | { type: "tool.updated"; providerTurnId: string; tool: DroidToolUpdate }
  | { type: "usage.updated"; providerTurnId: string; usage: ProviderUsage }
  | { type: "approval.requested"; requestId: string; payload: Record<string, unknown> }
  | { type: "user-input.requested"; requestId: string; payload: Record<string, unknown> }
  | { type: "protocol.error"; message: string }
  /** The session id a later process continues with droid.load_session. */
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
  /** A session from an earlier process. The first turn loads it instead of starting a new one. */
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
  /** False until Droid accepts the message; events wait in queued until then. */
  started: boolean;
  queued: DroidProviderEvent[];
  text: string;
  sawText: boolean;
  lastBlock?: string;
  streamedMessages: Set<string>;
  /** Tool calls Droid announced, with the latest input it streamed for each. */
  calls: Map<string, DroidToolUse>;
  running: Map<string, { name: string; input?: Record<string, unknown> }>;
  finishedTools: Set<string>;
  busy: boolean;
  error?: string;
};

type PendingRequest = {
  method: string;
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Settle = { turnId: string; done: Promise<void>; resolve: () => void };

export class DroidClient {
  private readonly listeners = new Set<(event: DroidProviderEvent) => void>();
  private readonly completed: DroidTranscriptTurn[] = [];
  private readonly requests = new Map<string, PendingRequest>();
  private readonly approvals = new Map<string, { toolNames: string[]; options: string[] }>();
  private readonly userInputs = new Map<string, DroidQuestion[]>();
  private readonly sessionAllowedTools = new Set<string>();
  private sessionId: string | undefined;
  /** False while a resumed id has not been loaded, so a failed first turn is not treated as resumable. */
  private sessionConfirmed = false;
  private reported: DroidReportedSettings = {};
  private defaultEfforts = new Map<string, string>();
  /** The last turn set its own reasoning level, so a turn without one goes back to the model default. */
  private effortPinned = false;
  private active: ActiveTurn | undefined;
  private sending = false;
  private settle: Settle | undefined;
  private peer: DroidPeer | undefined;
  private ready = false;
  private starting: Promise<void> | undefined;
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
   * The first turn starts the CLI and its session. A turn-level model or reasoning level only
   * applies to that turn; a permission mode applies to this turn and every later one.
   */
  async sendTurn(input: {
    text: string;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: DroidPermissionMode;
  }): Promise<DroidTurnResult> {
    this.assertOpen();
    if (this.active || this.sending) {
      throw new DroidProviderError("request_failed", "Droid CLI already has a turn in progress.");
    }
    this.sending = true;
    try {
      if (input.permissionMode) this.permissionMode = input.permissionMode;
      await this.settle?.done;
      await this.ensureSession();
      await this.applySettings(input.model?.trim() || this.model, input.reasoningEffort?.trim() || undefined);
      const turn = newTurn(randomUUID());
      this.active = turn;
      try {
        // The message id comes back as agent_turn_completed's turnId, which ties completions to turns.
        await this.request("droid.add_user_message", { text: input.text, messageId: turn.id });
      } catch (error) {
        if (this.active === turn) this.active = undefined;
        throw error;
      }
      turn.started = true;
      this.emit({ type: "turn.started", providerTurnId: turn.id });
      for (const event of turn.queued.splice(0)) this.emit(event);
      return { providerTurnId: turn.id };
    } finally {
      this.sending = false;
    }
  }

  async interruptTurn(providerTurnId?: string): Promise<void> {
    this.assertOpen();
    const turn = this.active;
    if (!turn) return;
    if (providerTurnId && providerTurnId !== turn.id) {
      throw new DroidProviderError("request_failed", "Droid CLI turn does not match the active turn.");
    }
    this.declinePending();
    this.finishTurn("interrupted");
    this.expectSettle(turn.id);
    try {
      await this.request("droid.interrupt_session", {});
    } catch {
      // The process is gone or already idle; the turn is over either way.
    }
  }

  /**
   * Answers a droid.request_permission request. forSession also allows later calls of the same
   * tools without asking.
   */
  async respondToApproval(requestId: string, allow: boolean, options: { forSession?: boolean } = {}): Promise<void> {
    this.assertOpen();
    const pending = this.approvals.get(requestId);
    if (!pending) throw new DroidProviderError("request_failed", `Droid CLI approval request not found: ${requestId}`);
    this.approvals.delete(requestId);
    if (allow && options.forSession) for (const name of pending.toolNames) this.sessionAllowedTools.add(name);
    this.respond(requestId, { selectedOption: allow ? approveOption(pending.options) : "cancel" });
  }

  /** Answers a droid.ask_user request; answers are keyed by each question's index. */
  async respondToUserInput(requestId: string, answers: Record<string, string>): Promise<void> {
    this.assertOpen();
    const questions = this.userInputs.get(requestId);
    if (!questions) throw new DroidProviderError("request_failed", `Droid CLI question not found: ${requestId}`);
    this.userInputs.delete(requestId);
    this.respond(requestId, {
      answers: questions.map((question) => ({
        index: question.index,
        question: question.question,
        answer: answers[String(question.index)] ?? "",
      })),
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.active = undefined;
    this.approvals.clear();
    this.userInputs.clear();
    await this.stopPeer();
  }

  private async ensureSession(): Promise<void> {
    if (this.peer && this.ready) return;
    if (!this.starting) {
      this.starting = this.startSession().finally(() => {
        this.starting = undefined;
      });
    }
    await this.starting;
  }

  private async startSession(): Promise<void> {
    this.attach(this.spawn());
    try {
      if (this.sessionId) {
        const result = await this.request("droid.load_session", { sessionId: this.sessionId });
        this.noteSettings(result.settings, result.availableModels);
        this.noteSession(this.sessionId);
      } else {
        const result = await this.request("droid.initialize_session", {
          machineId: hostname() || "zli",
          cwd: this.cwd,
          ...droidSessionSettings(this.permissionMode),
          ...(this.model ? { modelId: this.model } : {}),
        });
        const sessionId = typeof result.sessionId === "string" ? result.sessionId.trim() : "";
        if (!sessionId) {
          throw new DroidProviderError("invalid_response", "Droid CLI session init did not include a session id.");
        }
        this.noteSettings(result.settings, result.availableModels);
        this.noteSession(sessionId);
      }
      this.ready = true;
    } catch (error) {
      await this.stopPeer();
      throw error;
    }
  }

  private async applySettings(model: string | undefined, effort: string | undefined): Promise<void> {
    const wanted = droidSessionSettings(this.permissionMode);
    const patch: Record<string, string> = {};
    if (this.reported.interactionMode !== wanted.interactionMode) patch.interactionMode = wanted.interactionMode;
    if (this.reported.autonomyLevel !== wanted.autonomyLevel) patch.autonomyLevel = wanted.autonomyLevel;
    if (model && model !== this.reported.modelId) patch.modelId = model;
    const modelId = model ?? this.reported.modelId;
    const level = effort ?? (this.effortPinned && modelId ? this.defaultEfforts.get(modelId) : undefined);
    if (level && (level !== this.reported.reasoningEffort || patch.modelId)) patch.reasoningEffort = level;
    this.effortPinned = effort !== undefined;
    if (Object.keys(patch).length === 0) return;
    await this.request("droid.update_session_settings", patch);
    this.reported = { ...this.reported, ...patch };
  }

  private spawn(): DroidPeer {
    const spawnProcess = this.spawnProcess ?? defaultSpawn;
    let child: DroidChild;
    try {
      child = spawnProcess(this.command, droidArgs(this.cwd), {
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
    this.ready = false;
    this.failRequests(new DroidProviderError("closed", "Droid CLI session is closed."));
    await peer?.close().catch(() => undefined);
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const peer = this.peer;
    if (!peer) return Promise.reject(new DroidProviderError("closed", "Droid CLI session is closed."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new DroidProviderError("request_failed", `Droid CLI did not answer ${method}.`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.requests.set(id, { method, resolve, reject, timer });
      try {
        peer.write(`${JSON.stringify(droidRequest(id, method, params))}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.requests.delete(id);
        reject(error);
      }
    });
  }

  private respond(id: string, result: Record<string, unknown>): void {
    this.write(droidResponse(id, result));
  }

  private write(message: Record<string, unknown>): void {
    if (!this.peer) throw new DroidProviderError("closed", "Droid CLI session is closed.");
    this.peer.write(`${JSON.stringify(message)}\n`);
  }

  private failRequests(error: Error): void {
    const pending = [...this.requests.values()];
    this.requests.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  private handleMessage(raw: unknown): void {
    if (this.closed) return;
    const message = classifyDroidMessage(raw);
    switch (message.kind) {
      case "invalid":
        this.emit({ type: "protocol.error", message: "Malformed Droid CLI message." });
        return;
      case "response":
      case "error_response": {
        const pending = this.requests.get(message.id);
        if (!pending) return;
        this.requests.delete(message.id);
        clearTimeout(pending.timer);
        if (message.kind === "response") pending.resolve(message.result);
        else pending.reject(new DroidProviderError("request_failed", message.message));
        return;
      }
      case "request":
        this.handleRequest(message.id, message.method, message.params);
        return;
      case "notification":
        if (message.sessionId && this.sessionId && message.sessionId !== this.sessionId) return;
        this.handleNotification(message.notification);
        return;
      default:
        return;
    }
  }

  private handleRequest(id: string, method: string, params: Record<string, unknown>): void {
    try {
      if (method === "droid.request_permission") {
        this.onPermissionRequest(id, params);
        return;
      }
      if (method === "droid.ask_user") {
        this.onAskUser(id, params);
        return;
      }
      if (method === "droid.pick_options") {
        this.respond(id, { cancelled: true, selectedIds: [] });
        return;
      }
      this.write(droidErrorResponse(id, -32601, `ZLI does not handle ${method}.`));
    } catch (error) {
      this.emit({
        type: "protocol.error",
        message: error instanceof Error ? error.message : "Droid CLI request could not be answered.",
      });
    }
  }

  private onPermissionRequest(id: string, params: Record<string, unknown>): void {
    const request = parsePermissionRequest(params);
    const toolNames = request.toolUses.map((tool) => tool.name);
    const allowed =
      this.permissionMode === "full-access" ||
      (toolNames.length > 0 && toolNames.every((name) => this.sessionAllowedTools.has(name)));
    if (allowed) {
      this.respond(id, { selectedOption: approveOption(request.options) });
      return;
    }
    const [first, ...rest] = request.toolUses;
    this.approvals.set(id, { toolNames, options: request.options });
    this.emit({
      type: "approval.requested",
      requestId: id,
      payload: {
        toolName: first?.displayName ?? "Tool",
        input: first?.input ?? {},
        ...(first ? { toolUseId: first.id } : {}),
        ...(rest.length > 0
          ? { toolUses: request.toolUses.map((tool) => ({ toolName: tool.displayName, input: tool.input ?? {} })) }
          : {}),
      },
    });
  }

  private onAskUser(id: string, params: Record<string, unknown>): void {
    const questions = parseQuestions(params);
    if (questions.length === 0) {
      this.respond(id, { cancelled: true, answers: [] });
      return;
    }
    this.userInputs.set(id, questions);
    this.emit({
      type: "user-input.requested",
      requestId: id,
      payload: {
        questions: questions.map((question) => ({
          id: String(question.index),
          ...(question.topic ? { header: question.topic } : {}),
          question: question.question,
          options: question.options.map((label) => ({ label })),
          isOther: true,
        })),
      },
    });
  }

  /** Pending questions cannot outlive the turn that asked them. */
  private declinePending(): void {
    const approvals = [...this.approvals.keys()];
    const inputs = [...this.userInputs.keys()];
    this.approvals.clear();
    this.userInputs.clear();
    try {
      for (const id of approvals) this.respond(id, { selectedOption: "cancel" });
      for (const id of inputs) this.respond(id, { cancelled: true, answers: [] });
    } catch {
      // The process is gone, so nothing waits for these answers.
    }
  }

  private handleNotification(notification: DroidNotification): void {
    const turn = this.active;
    switch (notification.type) {
      case "settings":
        this.reported = { ...this.reported, ...notification.settings };
        return;
      case "permission_resolved":
        this.approvals.delete(notification.requestId);
        return;
      case "turn_completed":
        this.onTurnCompleted(notification);
        return;
      case "working_state":
        if (notification.state !== "idle") {
          if (turn) turn.busy = true;
          return;
        }
        this.settle?.resolve();
        // Droid can report idle more than once after a turn, so idle alone does not end one. A turn
        // that hit an error and went idle without agent_turn_completed has nothing left to send.
        if (turn?.started && turn.busy && turn.error) this.finishTurn("error", turn.error);
        return;
      case "error":
        if (turn) turn.error = notification.message;
        else this.emit({ type: "protocol.error", message: notification.message });
        return;
      default:
        break;
    }
    if (!turn) return;
    switch (notification.type) {
      case "text_delta": {
        turn.streamedMessages.add(notification.messageId);
        this.emitText(turn, notification.text, `${notification.messageId}:${notification.blockIndex}`);
        return;
      }
      case "assistant_message":
        if (!turn.streamedMessages.has(notification.messageId)) {
          notification.texts.forEach((text, index) => {
            this.emitText(turn, text, `${notification.messageId}:full:${index}`);
          });
        }
        for (const tool of notification.toolUses) this.onToolStart(turn, tool);
        return;
      case "tool_call":
        turn.calls.set(notification.tool.id, notification.tool);
        return;
      case "tool_result":
        this.onToolResult(turn, notification);
        return;
      default:
        return;
    }
  }

  private onToolStart(turn: ActiveTurn, tool: DroidToolUse): void {
    if (turn.running.has(tool.id) || turn.finishedTools.has(tool.id)) return;
    const started = { name: tool.name, ...(tool.input ? { input: tool.input } : {}) };
    turn.running.set(tool.id, started);
    this.turnEvent(turn, {
      type: "tool.updated",
      providerTurnId: turn.id,
      tool: { callId: tool.id, ...started, status: "running" },
    });
  }

  private onToolResult(turn: ActiveTurn, result: { callId: string; isError: boolean; output?: string }): void {
    // Droid repeats the result of a call that an interrupt cancelled.
    if (turn.finishedTools.has(result.callId)) return;
    turn.finishedTools.add(result.callId);
    const started = turn.running.get(result.callId) ?? turn.calls.get(result.callId);
    turn.running.delete(result.callId);
    this.turnEvent(turn, {
      type: "tool.updated",
      providerTurnId: turn.id,
      tool: {
        callId: result.callId,
        name: started?.name ?? "Tool",
        ...(started?.input ? { input: started.input } : {}),
        status: result.isError ? "failed" : "completed",
        ...(result.output ? { output: result.output } : {}),
      },
    });
  }

  private onTurnCompleted(message: { turnId?: string; reason: string; usage?: ProviderUsage }): void {
    if (message.turnId && this.settle?.turnId === message.turnId) this.settle.resolve();
    const turn = this.active;
    if (!turn || (message.turnId && message.turnId !== turn.id)) return;
    if (message.usage) this.turnEvent(turn, { type: "usage.updated", providerTurnId: turn.id, usage: message.usage });
    if (message.reason === "completed" && !(turn.error && !turn.sawText)) {
      this.finishTurn("completed");
      return;
    }
    if (message.reason === "cancelled" || message.reason === "interrupted") {
      this.finishTurn("interrupted");
      return;
    }
    this.finishTurn("error", turn.error ?? `Droid CLI turn ended: ${message.reason}.`);
  }

  private emitText(turn: ActiveTurn, text: string, block: string): void {
    if (text.length === 0) return;
    // A new message or text block reads like a new paragraph.
    const delta = turn.sawText && turn.lastBlock !== block ? `${MESSAGE_SEPARATOR}${text}` : text;
    turn.sawText = true;
    turn.lastBlock = block;
    turn.text += delta;
    this.turnEvent(turn, { type: "assistant.delta", providerTurnId: turn.id, text: delta });
  }

  private finishTurn(status: string, errorMessage?: string): void {
    const turn = this.active;
    if (!turn) return;
    this.active = undefined;
    const sessionId = this.sessionId;
    this.completed.push({
      providerTurnId: turn.id,
      text: errorMessage ?? turn.text,
      status,
      ...(sessionId ? { sessionId } : {}),
    });
    this.turnEvent(
      turn,
      errorMessage
        ? { type: "turn.failed", providerTurnId: turn.id, message: errorMessage }
        : { type: "turn.completed", providerTurnId: turn.id, status },
    );
  }

  private turnEvent(turn: ActiveTurn, event: DroidProviderEvent): void {
    if (turn.started) this.emit(event);
    else turn.queued.push(event);
  }

  private expectSettle(turnId: string): void {
    let settled: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const settle: Settle = {
      turnId,
      done,
      resolve: () => {
        clearTimeout(timer);
        if (this.settle === settle) this.settle = undefined;
        settled();
      },
    };
    const timer = setTimeout(settle.resolve, SETTLE_MS);
    timer.unref?.();
    this.settle = settle;
  }

  private onPeerClose(error?: Error): void {
    this.detach();
    this.peer = undefined;
    this.ready = false;
    const reason = error?.message ?? "Droid CLI process closed.";
    this.failRequests(new DroidProviderError("closed", reason));
    this.settle?.resolve();
    this.approvals.clear();
    this.userInputs.clear();
    if (this.closed) return;
    const turn = this.active;
    if (turn && !turn.started) {
      // sendTurn is still waiting on add_user_message, and its rejection reports the failure.
      this.active = undefined;
      return;
    }
    if (!turn) return;
    const resumable = this.sessionConfirmed;
    this.finishTurn("error", reason);
    if (!resumable) {
      this.closed = true;
      this.emit({ type: "session.closed", reason });
    }
  }

  private noteSettings(settings: unknown, models: unknown): void {
    this.reported = { ...this.reported, ...reportedSettings(settings) };
    const defaults = modelDefaults(models);
    if (defaults.size > 0) this.defaultEfforts = defaults;
  }

  private noteSession(sessionId: string): void {
    if (sessionId === this.sessionId && this.sessionConfirmed) return;
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

function newTurn(id: string): ActiveTurn {
  return {
    id,
    started: false,
    queued: [],
    text: "",
    sawText: false,
    streamedMessages: new Set(),
    calls: new Map(),
    running: new Map(),
    finishedTools: new Set(),
    busy: false,
  };
}

/** Allow once when Droid offers it; otherwise the first option that proceeds in this session. */
function approveOption(options: readonly string[]): string {
  if (options.includes("proceed_once")) return "proceed_once";
  return (
    options.find((option) => option.startsWith("proceed") && !option.startsWith("proceed_new_session")) ??
    "proceed_once"
  );
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
