import { randomUUID } from "node:crypto";

import { CommandId, ProviderKind, ThreadId, TurnId, type RuntimeEventEnvelope } from "@zli-v2/contracts";

import type { Engine } from "../orchestration/Engine.js";
import type { ProviderService, ProviderEvent } from "./ProviderService.js";

type StartIntent = Extract<RuntimeEventEnvelope["event"], { type: "thread.start.requested" }>;
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

export class ProviderReactor {
  private readonly tasks = new Set<Promise<void>>();
  private readonly pendingDeltas = new Map<string, PendingDelta>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeProvider: () => void;

  constructor(
    private readonly engine: Engine,
    private readonly service: ProviderService,
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
        errorMessage: "The agent session ended when ZLI restarted. Start a new thread to continue.",
      });
    }
  }

  private onEvent(envelope: RuntimeEventEnvelope): void {
    switch (envelope.event.type) {
      case "thread.start.requested":
        this.track(this.start(envelope.event));
        return;
      case "thread.send.requested":
        this.track(this.send(envelope.event.threadId, envelope.event.text, envelope.event.model));
        return;
      case "thread.interrupt.requested":
        this.track(this.interrupt(envelope.event.threadId, envelope.event.turnId));
        return;
      case "thread.stop.requested":
        this.track(this.stopSession(envelope.event.threadId));
        return;
      case "thread.respond.requested":
        this.track(this.respond(envelope.event.threadId, envelope.event.requestId, envelope.event.decision));
        return;
      case "thread.user-input.requested":
        this.track(this.respondUserInput(envelope.event.threadId, envelope.event.requestId, envelope.event.answers));
        return;
      default:
        return;
    }
  }

  private async start(intent: StartIntent): Promise<void> {
    try {
      const session = await this.service.startSession({
        provider: ProviderKind.parse(intent.thread.provider),
        threadId: intent.thread.threadId,
        cwd: intent.cwd,
      });
      await this.status(intent.thread.threadId, "idle", {
        capabilities: this.service.getCapabilities(session.provider),
      });
    } catch (error) {
      await this.fail(intent.thread.threadId, error, "Provider session failed to start.");
    }
  }

  private async send(threadId: string, text: string, model?: string): Promise<void> {
    await this.message(threadId, "user", text);
    try {
      const result = await this.service.sendTurn({
        threadId: ThreadId.parse(threadId),
        text,
        ...(model ? { model } : {}),
      });
      await this.status(threadId, "working", { turnId: result.turnId });
    } catch (error) {
      await this.fail(threadId, error, "Provider turn failed.");
    }
  }

  private async interrupt(threadId: string, turnId?: string): Promise<void> {
    try {
      await this.service.interruptTurn({ threadId: ThreadId.parse(threadId), ...(turnId ? { turnId } : {}) });
      this.flushThreadDeltas(threadId);
      await this.status(threadId, "idle");
    } catch (error) {
      await this.fail(threadId, error, "Provider interruption failed.");
    }
  }

  private async stopSession(threadId: string): Promise<void> {
    try {
      await this.service.stopSession({ threadId: ThreadId.parse(threadId) });
      this.flushThreadDeltas(threadId);
      await this.status(threadId, "stopped");
    } catch (error) {
      await this.fail(threadId, error, "Provider session stop failed.");
    }
  }

  private onProviderEvent(event: ProviderEvent): void {
    if (event.type === "assistant.delta") {
      this.bufferDelta(event.threadId, event.turnId, event.text);
      return;
    }
    if (event.type === "turn.started") {
      this.track(this.status(event.threadId, "working", { turnId: event.turnId }));
      return;
    }
    if (event.type === "turn.completed") {
      this.flushThreadDeltas(event.threadId);
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
    if (event.type === "session.closed") {
      this.flushThreadDeltas(event.threadId);
      this.track(this.status(event.threadId, "stopped", { errorMessage: event.reason }));
      return;
    }
    if (event.threadId) {
      this.flushThreadDeltas(event.threadId);
      this.track(this.status(event.threadId, "failed", { errorMessage: event.message }));
    }
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

  private message(
    threadId: string,
    role: "user" | "assistant" | "system",
    text: string,
    turnId?: string,
  ): Promise<void> {
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

function errorText(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  const message = error.message.trim() || fallback;
  return cause && !message.includes(cause) ? `${message} ${cause}` : message;
}

function safeTurnId(value: string): TurnId {
  return TurnId.safeParse(value).success ? TurnId.parse(value) : TurnId.parse(randomUUID());
}
