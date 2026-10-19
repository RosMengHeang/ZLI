import { randomUUID } from "node:crypto";

import { CommandId, ProviderKind, ThreadId, TurnId, type RuntimeEventEnvelope } from "@zli-v2/contracts";

import type { Engine } from "../orchestration/Engine.js";
import type { ProviderService, ProviderEvent } from "./ProviderService.js";

type StartIntent = Extract<RuntimeEventEnvelope["event"], { type: "thread.start.requested" }>;

export class ProviderReactor {
  private readonly tasks = new Set<Promise<void>>();
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
  }

  async waitForIdle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.all([...this.tasks]);
    await this.engine.projection();
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
      await this.status(intent.thread.threadId, "idle", undefined, this.service.getCapabilities(session.provider));
    } catch (error) {
      await this.status(
        intent.thread.threadId,
        "failed",
        error instanceof Error ? error.message : "Provider session failed to start.",
      );
    }
  }

  private async send(threadId: string, text: string, model?: string): Promise<void> {
    try {
      const result = await this.service.sendTurn({
        threadId: ThreadId.parse(threadId),
        text,
        ...(model ? { model } : {}),
      });
      await this.status(threadId, "working", result.turnId);
      await this.message(threadId, "user", text, result.turnId);
    } catch (error) {
      await this.status(threadId, "failed", error instanceof Error ? error.message : "Provider turn failed.");
    }
  }

  private async interrupt(threadId: string, turnId?: string): Promise<void> {
    try {
      await this.service.interruptTurn({ threadId: ThreadId.parse(threadId), ...(turnId ? { turnId } : {}) });
      await this.status(threadId, "idle");
    } catch (error) {
      await this.status(threadId, "failed", error instanceof Error ? error.message : "Provider interruption failed.");
    }
  }

  private async stopSession(threadId: string): Promise<void> {
    try {
      await this.service.stopSession({ threadId: ThreadId.parse(threadId) });
      await this.status(threadId, "stopped");
    } catch (error) {
      await this.status(threadId, "failed", error instanceof Error ? error.message : "Provider session stop failed.");
    }
  }

  private onProviderEvent(event: ProviderEvent): void {
    if (event.type === "assistant.delta") {
      this.track(this.message(event.threadId, "assistant", event.text, event.turnId));
      return;
    }
    if (event.type === "turn.started") {
      this.track(this.status(event.threadId, "working", event.turnId));
      return;
    }
    if (event.type === "turn.completed") {
      this.track(this.status(event.threadId, "idle", event.turnId));
      return;
    }
    if (event.type === "approval.requested" || event.type === "user-input.requested") {
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
      this.track(this.status(event.threadId, "stopped"));
      return;
    }
    if (event.threadId) this.track(this.status(event.threadId, "failed", event.message));
  }

  private status(
    threadId: string,
    status: "starting" | "idle" | "working" | "waiting" | "stopped" | "failed",
    turnId?: string,
    capabilities?: ReturnType<ProviderService["getCapabilities"]>,
  ): Promise<void> {
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "thread.status",
          threadId: ThreadId.parse(threadId),
          status,
          ...(turnId ? { turnId: safeTurnId(turnId) } : {}),
          ...(capabilities ? { capabilities } : {}),
        },
      })
      .then(() => undefined);
  }

  private async respond(threadId: string, requestId: string, decision: unknown): Promise<void> {
    try {
      await this.service.respondToRequest({ threadId: ThreadId.parse(threadId), requestId, decision });
      await this.resolveRequest(threadId, requestId);
    } catch (error) {
      await this.status(threadId, "failed", error instanceof Error ? error.message : "Approval response failed.");
    }
  }

  private async respondUserInput(threadId: string, requestId: string, answers: Record<string, string>): Promise<void> {
    try {
      await this.service.respondToUserInput({ threadId: ThreadId.parse(threadId), requestId, answers });
      await this.resolveRequest(threadId, requestId);
    } catch (error) {
      await this.status(threadId, "failed", error instanceof Error ? error.message : "User input response failed.");
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

  private resolveRequest(threadId: string, requestId: string): Promise<void> {
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: { type: "thread.request.resolved", threadId: ThreadId.parse(threadId), requestId },
      })
      .then(() => this.status(threadId, "idle"));
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

function safeTurnId(value: string): TurnId {
  return TurnId.safeParse(value).success ? TurnId.parse(value) : TurnId.parse(randomUUID());
}
