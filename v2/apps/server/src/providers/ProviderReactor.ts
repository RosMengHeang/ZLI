import { createHash, randomUUID } from "node:crypto";

import {
  CommandId,
  type ListedProviderKind,
  ProviderKind,
  type RuntimeEventEnvelope,
  type ThreadAttachment,
  ThreadId,
  type ThreadProjection,
  TurnId,
} from "@zli-v2/contracts";

import type { TurnCheckpoints, TurnStart } from "../checkpoints/TurnCheckpoints.js";
import type { Engine } from "../orchestration/Engine.js";
import { trustedProject } from "../terminal/agentTrust.js";
import type {
  ProviderAccount,
  ProviderEvent,
  ProviderService,
  ProviderSession,
  ProviderSessionStart,
} from "./ProviderService.js";

/** Turns a thread's account into the environment its agent runs with. Undefined means the usual login. */
export type ThreadAccountResolver = (
  provider: ListedProviderKind,
  accountId?: string,
) => Promise<ProviderAccount | undefined>;

type StartIntent = Extract<RuntimeEventEnvelope["event"], { type: "thread.start.requested" }>;
type SendIntent = Extract<RuntimeEventEnvelope["event"], { type: "thread.send.requested" }>;
type SessionInput = ProviderSessionStart & { provider: ProviderKind };
type ActivityEvent = Extract<ProviderEvent, { type: "activity" }>;
type UsageEvent = Extract<ProviderEvent, { type: "usage" }>;
type ThreadStatus = "starting" | "idle" | "working" | "waiting" | "stopped" | "failed";
type StatusDetail = {
  turnId?: string;
  capabilities?: ReturnType<ProviderService["getCapabilities"]>;
  errorMessage?: string;
};
type PendingDelta = { threadId: string; turnId: string; text: string; timer: ReturnType<typeof setTimeout> };

/** Streaming fragments are coalesced so one reply is one durable event per flush, not one per token. */
const DELTA_FLUSH_MS = 120;
const LIVE_STATUSES = new Set<ThreadStatus>(["starting", "idle", "working", "waiting"]);
const MAX_ACTIVITY_TITLE = 500;
const MAX_ACTIVITY_DETAIL = 4_000;
const MAX_ACTIVITY_ID = 200;
const MAX_ENDED_TURNS = 20;
const MAX_PROVIDER_SESSION_ID = 500;
const FRESH_START_NOTE =
  "The earlier conversation could not be resumed, so the agent started over. It does not remember the messages above.";

export class ProviderReactor {
  private readonly tasks = new Set<Promise<void>>();
  private readonly pendingDeltas = new Map<string, PendingDelta>();
  /** Threads whose session was deleted. Late provider output for them has no record to land on. */
  private readonly deleted = new Set<string>();
  /** The provider's id for each thread's current turn, as the provider reports it. */
  private readonly activeTurns = new Map<string, string>();
  /**
   * Turns that already ended, per thread. An interrupted turn can still report completion after the
   * next queued message has started, and that late report must not mark the new turn idle.
   */
  private readonly endedTurns = new Map<string, string[]>();
  /** The files before each running turn, keyed by thread and the provider's turn id. */
  private readonly turnStarts = new Map<string, TurnStart>();
  /** Reply characters recorded so far per turn, keyed like pendingDeltas. Tool calls note it as their place. */
  private readonly replyLengths = new Map<string, number>();
  /**
   * Threads started again on an earlier conversation that have not finished a turn yet. Some CLIs only
   * reject a stale conversation id on the first turn, so that turn's message is kept to send again.
   */
  private readonly resuming = new Map<string, { retry?: SendIntent }>();
  /** The send still waiting for the provider's turn id, per thread. */
  private readonly sending = new Map<string, object>();
  /**
   * Sends that were stopped before the provider returned a turn id. Stop has nothing to interrupt yet,
   * so the turn is interrupted as soon as its id arrives instead of being left running.
   */
  private readonly stoppedSends = new Set<object>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeProvider: () => void;

  constructor(
    private readonly engine: Engine,
    private readonly service: ProviderService,
    private readonly checkpoints?: Pick<TurnCheckpoints, "capture" | "record">,
    private readonly options: { resolveAccount?: ThreadAccountResolver } = {},
  ) {
    this.unsubscribe = engine.subscribe((envelope) => this.onEvent(envelope));
    this.unsubscribeProvider = service.subscribe((event) => this.onProviderEvent(event));
  }

  stop(): void {
    this.unsubscribe();
    this.unsubscribeProvider();
    for (const pending of this.pendingDeltas.values()) clearTimeout(pending.timer);
    this.pendingDeltas.clear();
  }

  async waitForIdle(): Promise<void> {
    this.flushAllDeltas();
    while (this.tasks.size > 0) await Promise.all([...this.tasks]);
    await this.engine.projection();
  }

  /**
   * Provider sessions live in this process only. Threads persisted as live by a
   * previous run have no session behind them, so they are marked stopped
   * instead of appearing idle and failing on the next send.
   */
  async reconcileOrphanedThreads(): Promise<void> {
    const projection = await this.engine.projection();
    for (const thread of projection.threads) {
      if (!LIVE_STATUSES.has(thread.status)) continue;
      if (this.service.hasSession(ThreadId.parse(thread.threadId))) continue;
      await this.status(thread.threadId, "stopped", {
        errorMessage: thread.providerSessionId
          ? "The agent stopped when ZLI restarted. Send a message to pick up where it left off."
          : "The agent session ended when ZLI restarted. Start a new chat to continue.",
      });
    }
  }

  private onEvent(envelope: RuntimeEventEnvelope): void {
    switch (envelope.event.type) {
      case "thread.start.requested":
        this.track(this.start(envelope.event));
        return;
      case "thread.send.requested":
        this.track(this.send(envelope.event));
        return;
      case "thread.interrupt.requested":
        this.track(this.interrupt(envelope.event.threadId, envelope.event.turnId));
        return;
      case "thread.stop.requested":
        this.track(this.stopSession(envelope.event.threadId));
        return;
      case "thread.resume.requested":
        this.track(this.resume(envelope.event.threadId, envelope.event.cwd));
        return;
      case "thread.status.changed":
        if (envelope.event.status === "idle") this.track(this.flushQueue(envelope.event.threadId));
        return;
      case "thread.respond.requested":
        this.track(this.respond(envelope.event.threadId, envelope.event.requestId, envelope.event.decision));
        return;
      case "thread.user-input.requested":
        this.track(this.respondUserInput(envelope.event.threadId, envelope.event.requestId, envelope.event.answers));
        return;
      case "session.deleted":
        for (const threadId of envelope.event.threadIds) this.track(this.forget(threadId));
        return;
      default:
        return;
    }
  }

  private async sessionInput(thread: ThreadProjection, cwd: string): Promise<SessionInput> {
    const provider = ProviderKind.parse(thread.provider);
    const account = await this.options.resolveAccount?.(provider, thread.accountId);
    const trustedProjectPath = await trustedProject(this.engine, thread.worktreeId);
    return {
      provider,
      threadId: ThreadId.parse(thread.threadId),
      cwd,
      worktreeId: thread.worktreeId,
      ...(thread.permissionMode ? { permissionMode: thread.permissionMode } : {}),
      ...(thread.model ? { model: thread.model } : {}),
      ...(account ? { account } : {}),
      ...(trustedProjectPath ? { trustedProjectPath } : {}),
    };
  }

  private sessionCapabilities(session: ProviderSession): NonNullable<StatusDetail["capabilities"]> {
    return {
      ...this.service.getCapabilities(session.provider),
      ...(session.reasoningEfforts?.length ? { reasoningEfforts: [...session.reasoningEfforts] } : {}),
    };
  }

  private async start(intent: StartIntent): Promise<void> {
    try {
      const session = await this.service.startSession(await this.sessionInput(intent.thread, intent.cwd));
      if (this.deleted.has(intent.thread.threadId)) {
        await this.forget(intent.thread.threadId);
        return;
      }
      await this.recordProviderSession(intent.thread.threadId, session.providerSessionId);
      await this.status(intent.thread.threadId, "idle", { capabilities: this.sessionCapabilities(session) });
    } catch (error) {
      await this.fail(intent.thread.threadId, error, "Provider session failed to start.");
    }
  }

  /** Starts an ended chat's agent on its earlier conversation, or on a new one when that is gone. */
  private async resume(threadId: string, cwd: string): Promise<void> {
    if (this.deleted.has(threadId)) return;
    const thread = (await this.engine.projection()).threads.find((entry) => entry.threadId === threadId);
    if (!thread) return;
    let input: SessionInput;
    try {
      await this.closeSession(threadId);
      input = await this.sessionInput(thread, cwd);
    } catch (error) {
      await this.fail(threadId, error, "Provider session failed to start.");
      return;
    }
    if (thread.providerSessionId) {
      try {
        const session = await this.service.startSession({ ...input, resumeSessionId: thread.providerSessionId });
        if (this.deleted.has(threadId)) {
          await this.forget(threadId);
          return;
        }
        this.resuming.set(threadId, {});
        await this.recordProviderSession(threadId, session.providerSessionId);
        await this.status(threadId, "idle", { capabilities: this.sessionCapabilities(session) });
        return;
      } catch {
        // The CLI refused the earlier conversation at startup. A fresh one below keeps the chat usable.
      }
    }
    await this.startFresh(threadId, input);
  }

  /** The earlier conversation is gone: start a new one in the same chat and say so once. */
  private async startFresh(threadId: string, input: SessionInput, retry?: SendIntent): Promise<void> {
    try {
      await this.closeSession(threadId);
      const session = await this.service.startSession(input);
      if (this.deleted.has(threadId)) {
        await this.forget(threadId);
        return;
      }
      await this.recordProviderSession(threadId, session.providerSessionId);
      await this.message(threadId, "system", FRESH_START_NOTE);
      const capabilities = this.sessionCapabilities(session);
      if (!retry) {
        await this.status(threadId, "idle", { capabilities });
        return;
      }
      // Not idle, so the queue does not send its next message before this one.
      await this.status(threadId, "starting", { capabilities });
      await this.send(retry, { record: false });
    } catch (error) {
      await this.fail(threadId, error, "Provider session failed to start.");
    }
  }

  private async recoverResume(threadId: string, retry?: SendIntent): Promise<void> {
    const projection = await this.engine.projection();
    const thread = projection.threads.find((entry) => entry.threadId === threadId);
    const cwd = projection.worktrees.find((worktree) => worktree.worktreeId === thread?.worktreeId)?.path;
    if (!thread || !cwd || this.deleted.has(threadId)) return;
    try {
      await this.startFresh(threadId, await this.sessionInput(thread, cwd), retry);
    } catch (error) {
      await this.fail(threadId, error, "Provider session failed to start.");
    }
  }

  private async closeSession(threadId: string): Promise<void> {
    const id = ThreadId.parse(threadId);
    if (!this.service.hasSession(id)) return;
    try {
      await this.service.stopSession({ threadId: id });
    } catch {
      // The process is already gone.
    }
  }

  private recordProviderSession(threadId: string, providerSessionId: string | undefined): Promise<void> {
    const id = providerSessionId?.trim();
    if (!id || id.length > MAX_PROVIDER_SESSION_ID || this.deleted.has(threadId)) return Promise.resolve();
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: { type: "thread.provider-session", threadId: ThreadId.parse(threadId), providerSessionId: id },
      })
      .then(() => undefined);
  }

  private async send(intent: SendIntent, options: { record?: boolean } = {}): Promise<void> {
    const { threadId, text } = intent;
    const attachments = intent.attachments ?? [];
    if (options.record !== false) await this.message(threadId, "user", text, undefined, attachments);
    const resuming = this.resuming.get(threadId);
    if (resuming && !resuming.retry) resuming.retry = intent;
    const sendToken = {};
    this.sending.set(threadId, sendToken);
    try {
      await this.sendTurn(intent, attachments, sendToken);
    } finally {
      if (this.sending.get(threadId) === sendToken) this.sending.delete(threadId);
      this.stoppedSends.delete(sendToken);
    }
  }

  private async sendTurn(
    intent: SendIntent,
    attachments: readonly ThreadAttachment[],
    sendToken: object,
  ): Promise<void> {
    const { threadId, text, model, reasoningEffort, permissionMode } = intent;
    // Taken before the provider sees the message, so none of the turn's edits can land first.
    const start = await this.checkpoints?.capture(threadId);
    try {
      const result = await this.service.sendTurn({
        threadId: ThreadId.parse(threadId),
        text: promptWithAttachments(text, attachments),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      if (start) this.turnStarts.set(turnKey(threadId, result.turnId), start);
      if (this.turnEnded(threadId, result.turnId)) {
        this.recordCheckpoint(threadId, result.turnId);
      } else if (this.stoppedSends.has(sendToken)) {
        await this.interruptStarted(threadId, result.turnId);
      } else {
        this.activeTurns.set(threadId, result.turnId);
        await this.status(threadId, "working", { turnId: result.turnId });
      }
    } catch (error) {
      const retry = this.takeResume(threadId);
      if (retry) {
        await this.recoverResume(threadId, retry);
        return;
      }
      await this.fail(threadId, error, "Provider turn failed.");
    }
  }

  /** Ends a pending resume and returns the message to send again, if the first turn had started. */
  private takeResume(threadId: string): SendIntent | undefined {
    const resuming = this.resuming.get(threadId);
    this.resuming.delete(threadId);
    return resuming?.retry;
  }

  private async interrupt(threadId: string, projectedTurnId?: string): Promise<void> {
    // The projection keeps a sanitized turn id, so the provider's own id is preferred when known.
    const active = this.activeTurns.get(threadId);
    const pendingSend = this.sending.get(threadId);
    if (!active && pendingSend) this.stoppedSends.add(pendingSend);
    const turnId = active ?? projectedTurnId;
    try {
      await this.service.interruptTurn({ threadId: ThreadId.parse(threadId), ...(turnId ? { turnId } : {}) });
      this.flushThreadDeltas(threadId);
      if (active) {
        this.endTurn(threadId, active);
        this.recordCheckpoint(threadId, active);
      }
      await this.status(threadId, "idle");
    } catch (error) {
      await this.fail(threadId, error, "Provider interruption failed.");
    }
  }

  /** Interrupts a turn whose Stop arrived while the provider was still accepting the message. */
  private async interruptStarted(threadId: string, turnId: string): Promise<void> {
    try {
      await this.service.interruptTurn({ threadId: ThreadId.parse(threadId), turnId });
      this.flushThreadDeltas(threadId);
      this.endTurn(threadId, turnId);
      this.recordCheckpoint(threadId, turnId);
      await this.status(threadId, "idle");
    } catch (error) {
      await this.fail(threadId, error, "Provider interruption failed.");
    }
  }

  private async stopSession(threadId: string): Promise<void> {
    this.resuming.delete(threadId);
    try {
      await this.service.stopSession({ threadId: ThreadId.parse(threadId) });
      this.flushThreadDeltas(threadId);
      await this.status(threadId, "stopped");
    } catch (error) {
      await this.fail(threadId, error, "Provider session stop failed.");
    }
  }

  private async forget(threadId: string): Promise<void> {
    this.deleted.add(threadId);
    this.resuming.delete(threadId);
    this.activeTurns.delete(threadId);
    this.endedTurns.delete(threadId);
    for (const key of this.turnStarts.keys()) if (key.startsWith(`${threadId}\u0000`)) this.turnStarts.delete(key);
    for (const key of this.replyLengths.keys()) if (key.startsWith(`${threadId}\u0000`)) this.replyLengths.delete(key);
    for (const [key, pending] of this.pendingDeltas) {
      if (pending.threadId !== threadId) continue;
      clearTimeout(pending.timer);
      this.pendingDeltas.delete(key);
    }
    const id = ThreadId.parse(threadId);
    if (!this.service.hasSession(id)) return;
    try {
      await this.service.stopSession({ threadId: id });
    } catch {
      // The process is already gone.
    }
  }

  private onProviderEvent(event: ProviderEvent): void {
    if (event.threadId && this.deleted.has(event.threadId)) return;
    if (event.type === "assistant.delta") {
      this.bufferDelta(event.threadId, event.turnId, event.text);
      return;
    }
    if (event.type === "turn.started") {
      if (this.turnEnded(event.threadId, event.turnId)) return;
      this.activeTurns.set(event.threadId, event.turnId);
      this.track(this.status(event.threadId, "working", { turnId: event.turnId }));
      return;
    }
    if (event.type === "activity") {
      // Text streamed before the tool call has to land first so the work log keeps the provider's order.
      this.flushThreadDeltas(event.threadId);
      this.track(this.activity(event));
      return;
    }
    if (event.type === "usage") {
      this.track(this.usage(event));
      return;
    }
    if (event.type === "session.identified") {
      this.track(this.recordProviderSession(event.threadId, event.providerSessionId));
      return;
    }
    if (event.type === "turn.completed") {
      this.resuming.delete(event.threadId);
      this.flushThreadDeltas(event.threadId);
      if (this.turnEnded(event.threadId, event.turnId)) return;
      this.endTurn(event.threadId, event.turnId);
      this.recordCheckpoint(event.threadId, event.turnId);
      this.track(this.status(event.threadId, "idle", { turnId: event.turnId }));
      return;
    }
    if (event.type === "approval.requested" || event.type === "user-input.requested") {
      this.flushThreadDeltas(event.threadId);
      this.track(
        this.request(
          event.threadId,
          event.type === "approval.requested" ? "approval" : "user-input",
          event.requestId,
          event.payload,
        ),
      );
      this.track(this.status(event.threadId, "waiting"));
      return;
    }
    if (event.threadId) {
      // A session that ends mid-turn may still have changed files.
      const active = this.activeTurns.get(event.threadId);
      if (active) this.recordCheckpoint(event.threadId, active);
      if (this.resuming.has(event.threadId)) {
        this.flushThreadDeltas(event.threadId);
        if (active) this.endTurn(event.threadId, active);
        this.track(this.recoverResume(event.threadId, this.takeResume(event.threadId)));
        return;
      }
    }
    if (event.type === "session.closed") {
      this.flushThreadDeltas(event.threadId);
      // The turn died with the process. Left active, it would be the one a Stop after the next send interrupts.
      const active = this.activeTurns.get(event.threadId);
      if (active) this.endTurn(event.threadId, active);
      this.track(this.status(event.threadId, "stopped", { errorMessage: event.reason }));
      return;
    }
    if (event.threadId) {
      this.flushThreadDeltas(event.threadId);
      this.track(this.status(event.threadId, "failed", { errorMessage: event.message }));
    }
  }

  private turnEnded(threadId: string, turnId: string): boolean {
    return this.endedTurns.get(threadId)?.includes(turnId) ?? false;
  }

  private endTurn(threadId: string, turnId: string): void {
    if (this.activeTurns.get(threadId) === turnId) this.activeTurns.delete(threadId);
    this.replyLengths.delete(turnKey(threadId, turnId));
    const ended = this.endedTurns.get(threadId) ?? [];
    ended.push(turnId);
    this.endedTurns.set(threadId, ended.slice(-MAX_ENDED_TURNS));
  }

  private recordCheckpoint(threadId: string, turnId: string): void {
    const key = turnKey(threadId, turnId);
    const start = this.turnStarts.get(key);
    if (!start || !this.checkpoints || this.deleted.has(threadId)) return;
    this.turnStarts.delete(key);
    this.track(this.checkpoints.record(threadId, turnId, start));
  }

  /** The decider sends the next queued message only if the thread is still idle with nothing open. */
  private flushQueue(threadId: string): Promise<void> {
    if (this.deleted.has(threadId)) return Promise.resolve();
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: { type: "thread.queue.flush", threadId: ThreadId.parse(threadId) },
      })
      .then(() => undefined);
  }

  private bufferDelta(threadId: string, turnId: string, text: string): void {
    if (text.length === 0) return;
    const key = `${threadId}\u0000${turnId}`;
    const pending = this.pendingDeltas.get(key);
    if (pending) {
      pending.text += text;
      return;
    }
    const timer = setTimeout(() => this.flushDelta(key), DELTA_FLUSH_MS);
    this.pendingDeltas.set(key, { threadId, turnId, text, timer });
  }

  private flushDelta(key: string): void {
    const pending = this.pendingDeltas.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDeltas.delete(key);
    this.replyLengths.set(key, (this.replyLengths.get(key) ?? 0) + pending.text.length);
    this.track(this.message(pending.threadId, "assistant", pending.text, pending.turnId));
  }

  private flushThreadDeltas(threadId: string): void {
    for (const [key, pending] of this.pendingDeltas) {
      if (pending.threadId === threadId) this.flushDelta(key);
    }
  }

  private flushAllDeltas(): void {
    for (const key of [...this.pendingDeltas.keys()]) this.flushDelta(key);
  }

  private fail(threadId: string, error: unknown, fallback: string): Promise<void> {
    return this.status(threadId, "failed", { errorMessage: errorText(error, fallback) });
  }

  private status(threadId: string, status: ThreadStatus, detail: StatusDetail = {}): Promise<void> {
    if (this.deleted.has(threadId)) return Promise.resolve();
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "thread.status",
          threadId: ThreadId.parse(threadId),
          status,
          ...(detail.turnId ? { turnId: safeTurnId(detail.turnId) } : {}),
          ...(detail.capabilities ? { capabilities: detail.capabilities } : {}),
          ...(detail.errorMessage?.trim() ? { errorMessage: detail.errorMessage.trim().slice(0, 2_000) } : {}),
        },
      })
      .then(() => undefined);
  }

  private async respond(threadId: string, requestId: string, decision: unknown): Promise<void> {
    try {
      await this.service.respondToRequest({ threadId: ThreadId.parse(threadId), requestId, decision });
      await this.resolveRequest(threadId, requestId);
    } catch (error) {
      await this.fail(threadId, error, "Approval response failed.");
    }
  }

  private async respondUserInput(threadId: string, requestId: string, answers: Record<string, string>): Promise<void> {
    try {
      await this.service.respondToUserInput({ threadId: ThreadId.parse(threadId), requestId, answers });
      await this.resolveRequest(threadId, requestId);
    } catch (error) {
      await this.fail(threadId, error, "User input response failed.");
    }
  }

  private request(
    threadId: string,
    kind: "approval" | "user-input",
    requestId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this.deleted.has(threadId)) return Promise.resolve();
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "thread.request",
          request: { requestId, threadId: ThreadId.parse(threadId), kind, payload },
        },
      })
      .then(() => undefined);
  }

  /** Answering a request resumes the same turn, so the thread goes back to working, not idle. */
  private resolveRequest(threadId: string, requestId: string): Promise<void> {
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: { type: "thread.request.resolved", threadId: ThreadId.parse(threadId), requestId },
      })
      .then(async () => {
        const projection = await this.engine.projection();
        const stillWaiting = (projection.requests ?? []).some((request) => request.threadId === threadId);
        await this.status(threadId, stillWaiting ? "waiting" : "working");
      });
  }

  private activity(event: ActivityEvent): Promise<void> {
    const { activity } = event;
    const title = activity.title.trim().slice(0, MAX_ACTIVITY_TITLE) || "Tool call";
    const detail = activity.detail?.replace(/\s+$/u, "");
    const files = (activity.files ?? []).filter((file) => file.length > 0 && file.length <= 4_000).slice(0, 100);
    const turnId = event.turnId?.trim();
    const lines = activity.lines;
    const textOffset = event.turnId ? this.replyLengths.get(turnKey(event.threadId, event.turnId)) : undefined;
    if (this.deleted.has(event.threadId)) return Promise.resolve();
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "thread.activity",
          activity: {
            activityId: scopedActivityId(event.threadId, activity.activityId),
            threadId: ThreadId.parse(event.threadId),
            ...(turnId ? { turnId } : {}),
            kind: activity.kind,
            title,
            ...(detail ? { detail: detail.slice(-MAX_ACTIVITY_DETAIL) } : {}),
            status: activity.status,
            ...(files.length > 0 ? { files } : {}),
            ...(lines ? { lines } : {}),
            ...(activity.command?.trim() ? { command: activity.command.trim().slice(0, 2_000) } : {}),
            ...(turnId ? { textOffset: textOffset ?? 0 } : {}),
            ...(activity.connector ? { connector: activity.connector } : {}),
          },
        },
      })
      .then(() => undefined);
  }

  private usage(event: UsageEvent): Promise<void> {
    if (this.deleted.has(event.threadId)) return Promise.resolve();
    const turnId = event.turnId.trim();
    if (!turnId) return Promise.resolve();
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "thread.usage",
          threadId: ThreadId.parse(event.threadId),
          turnId: turnId.length <= MAX_ACTIVITY_ID ? turnId : createHash("sha256").update(turnId).digest("hex"),
          usage: event.usage,
        },
      })
      .then(() => undefined);
  }

  private message(
    threadId: string,
    role: "user" | "assistant" | "system",
    text: string,
    turnId?: string,
    attachments: readonly ThreadAttachment[] = [],
  ): Promise<void> {
    if (this.deleted.has(threadId)) return Promise.resolve();
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "thread.message",
          message: {
            messageId: randomUUID(),
            threadId: ThreadId.parse(threadId),
            role,
            text,
            ...(turnId ? { turnId } : {}),
            ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
          },
        },
      })
      .then(() => undefined);
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function errorText(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  const message = error.message.trim() || fallback;
  return cause && !message.includes(cause) ? `${message} ${cause}` : message;
}

/** Text paths are the baseline every CLI understands; adapters with native image input also get the images. */
export function promptWithAttachments(text: string, attachments: readonly ThreadAttachment[]): string {
  if (attachments.length === 0) return text;
  const list = (entries: readonly ThreadAttachment[]) => entries.map((entry) => `- ${entry.path}`).join("\n");
  const images = attachments.filter((attachment) => attachment.mimeType !== "text/plain");
  const texts = attachments.filter((attachment) => attachment.mimeType === "text/plain");
  const sections = [text];
  if (images.length > 0) sections.push(`Attached images (read them from disk):\n${list(images)}`);
  if (texts.length > 0) sections.push(`Attached text the person pasted (read it from disk):\n${list(texts)}`);
  return sections.join("\n\n");
}

/** Provider call ids are only unique inside one session, and projected activities are keyed globally. */
function scopedActivityId(threadId: string, activityId: string): string {
  const scoped = `${threadId}:${activityId}`;
  if (scoped.length <= MAX_ACTIVITY_ID && !/[\r\n]/u.test(activityId)) return scoped;
  return `${threadId}:${createHash("sha256").update(activityId).digest("hex").slice(0, 40)}`;
}

function safeTurnId(value: string): TurnId {
  return TurnId.safeParse(value).success ? TurnId.parse(value) : TurnId.parse(randomUUID());
}
