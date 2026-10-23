import { createHash, randomUUID } from "node:crypto";

import {
  CommandId,
  ProviderKind,
  type RuntimeEventEnvelope,
  type ThreadAttachment,
  ThreadId,
  TurnId,
} from "@zli-v2/contracts";

import type { Engine } from "../orchestration/Engine.js";
import type { ProviderEvent, ProviderService } from "./ProviderService.js";

type StartIntent = Extract<RuntimeEventEnvelope["event"], { type: "thread.start.requested" }>;
type SendIntent = Extract<RuntimeEventEnvelope["event"], { type: "thread.send.requested" }>;
type ActivityEvent = Extract<ProviderEvent, { type: "activity" }>;
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

export class ProviderReactor {
  private readonly tasks = new Set<Promise<void>>();
  private readonly pendingDeltas = new Map<string, PendingDelta>();
  /** Threads whose session was deleted. Late provider output for them has no record to land on. */
  private readonly deleted = new Set<string>();
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
        this.track(this.send(envelope.event));
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
      case "session.deleted":
        for (const threadId of envelope.event.threadIds) this.track(this.forget(threadId));
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
        worktreeId: intent.thread.worktreeId,
        ...(intent.thread.permissionMode ? { permissionMode: intent.thread.permissionMode } : {}),
        ...(intent.thread.model ? { model: intent.thread.model } : {}),
      });
      if (this.deleted.has(intent.thread.threadId)) {
        await this.forget(intent.thread.threadId);
        return;
      }
      await this.status(intent.thread.threadId, "idle", {
        capabilities: this.service.getCapabilities(session.provider),
      });
    } catch (error) {
      await this.fail(intent.thread.threadId, error, "Provider session failed to start.");
    }
  }

  private async send(intent: SendIntent): Promise<void> {
    const { threadId, text, model, permissionMode } = intent;
    const attachments = intent.attachments ?? [];
    await this.message(threadId, "user", text, undefined, attachments);
    try {
      const result = await this.service.sendTurn({
        threadId: ThreadId.parse(threadId),
        text: promptWithAttachments(text, attachments),
        ...(model ? { model } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
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

  private async forget(threadId: string): Promise<void> {
    this.deleted.add(threadId);
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
      this.track(this.status(event.threadId, "working", { turnId: event.turnId }));
      return;
    }
    if (event.type === "activity") {
      // Text streamed before the tool call has to land first so the work log keeps the provider's order.
      this.flushThreadDeltas(event.threadId);
      this.track(this.activity(event));
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
          },
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

function errorText(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  const message = error.message.trim() || fallback;
  return cause && !message.includes(cause) ? `${message} ${cause}` : message;
}

/** Text paths are the baseline every CLI understands; adapters with native image input also get the list. */
export function promptWithAttachments(text: string, attachments: readonly ThreadAttachment[]): string {
  if (attachments.length === 0) return text;
  const lines = attachments.map((attachment) => `- ${attachment.path}`).join("\n");
  return `${text}\n\nAttached images (read them from disk):\n${lines}`;
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
