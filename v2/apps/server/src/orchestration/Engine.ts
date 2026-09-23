import { createHash, randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";

import {
  ProjectRegisterResult,
  RpcRequest,
  RuntimeEvent,
  RuntimeEventEnvelope,
  RuntimeProjection,
  EventId,
  type EnvironmentDescriptor,
  type RuntimeCommand,
} from "@zli-v2/contracts";

import { Database } from "../db/Database.js";
import { StructuredLogger, type LogCorrelation } from "../diagnostics/StructuredLogger.js";
import { DomainError, decide } from "./decider.js";
import { createEmptyProjection, projectEvent } from "./projector.js";
import { ReactorRunner, type NamedReactor, type Reactor, type ReactorContext } from "./ReactorRunner.js";

export type CommandReceipt = {
  commandId: string;
  status: "accepted" | "rejected";
  firstSequence: number | null;
  lastSequence: number | null;
  eventTypes: string[];
  result?: { projectId: string };
  error?: { code: string; message: string };
};

export type ProjectEvent = (projection: RuntimeProjection, event: RuntimeEventEnvelope) => RuntimeProjection;

export type EngineOptions = {
  database: Database;
  environment: EnvironmentDescriptor;
  logger?: StructuredLogger;
  projectEvent?: ProjectEvent;
  reactors?: readonly (NamedReactor | Reactor)[];
};

export class StoredEventCompatibilityError extends Error {
  constructor(
    readonly sequence: number,
    cause: unknown,
  ) {
    super(`Stored event at sequence ${sequence} is incompatible with the current protocol.`, {
      cause,
    });
    this.name = "StoredEventCompatibilityError";
  }
}

export class Engine {
  readonly database: Database;
  private readonly environment: EnvironmentDescriptor;
  private readonly applyEvent: ProjectEvent;
  private readonly reactorRunner: ReactorRunner;
  private readonly logger: StructuredLogger;
  private readonly listeners = new Set<(event: RuntimeEventEnvelope) => void>();
  private commandQueue: Promise<void> = Promise.resolve();
  private reactorTasks = new Set<Promise<void>>();

  constructor(options: EngineOptions) {
    this.database = options.database;
    this.environment = options.environment;
    this.logger = options.logger ?? new StructuredLogger();
    this.applyEvent = options.projectEvent ?? projectEvent;
    this.reactorRunner = new ReactorRunner(
      (options.reactors ?? []).map((reactor, index) =>
        typeof reactor === "function" ? { name: `reactor-${index + 1}`, run: reactor } : reactor,
      ),
    );
  }

  dispatch(request: RpcRequest): Effect.Effect<CommandReceipt, Error> {
    return Effect.tryPromise({
      try: () => this.dispatchPromise(request),
      catch: toError,
    });
  }

  /** Promise interop for existing async boundaries; new orchestration code should compose dispatch(). */
  dispatchPromise(request: RpcRequest): Promise<CommandReceipt> {
    const parsed = RpcRequest.parse(request);
    const operation = this.commandQueue.then(() => this.dispatchSerialized(parsed));
    this.commandQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  eventsAfter(sequence: number): Promise<RuntimeEventEnvelope[]> {
    return this.commandQueue.then(() => this.readEventsAfter(sequence));
  }

  projection(): Promise<RuntimeProjection> {
    return this.commandQueue.then(() => this.readProjection());
  }

  receipt(commandId: string): Promise<CommandReceipt | undefined> {
    return this.commandQueue.then(() => this.readReceipt(commandId));
  }

  subscribe(listener: (event: RuntimeEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async rebuildProjection(): Promise<void> {
    const operation = this.commandQueue.then(() => {
      const events = this.readEventsAfter(0);
      let projection = createEmptyProjection(this.environment);
      for (const event of events) {
        projection = this.applyEvent(projection, event);
      }
      this.database.transaction(() => {
        this.database.execute(
          "INSERT INTO projection_state (projection_id, revision, projection_json) VALUES (1, ?, ?) ON CONFLICT(projection_id) DO UPDATE SET revision = excluded.revision, projection_json = excluded.projection_json",
          [projection.lastSequence, JSON.stringify(projection)],
        );
      });
      return undefined;
    });
    this.commandQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  async waitForReactors(): Promise<void> {
    while (this.reactorTasks.size > 0) {
      await Promise.all([...this.reactorTasks]);
    }
  }

  private async dispatchSerialized(request: RpcRequest): Promise<CommandReceipt> {
    this.logger.record("info", "runtime command received", commandCorrelation(request, this.environment.environmentId));
    const intentHash = hashIntent(request.command);
    const existing = this.readReceiptRow(request.commandId);
    if (existing) {
      const storedIntentHash = this.readIntentHash(request.commandId);
      if (storedIntentHash !== intentHash) {
        return {
          commandId: request.commandId,
          status: "rejected",
          firstSequence: null,
          lastSequence: null,
          eventTypes: [],
          error: {
            code: "command_id_conflict",
            message: "The command id has already been used for a different intent.",
          },
        };
      }
      return existing;
    }

    const projection = this.readProjection();
    try {
      const decisions = decide(projection, request.command);
      const committed = this.commitAccepted(request, intentHash, projection, decisions);
      this.publish(committed.events);
      this.scheduleReactors(committed.events, committed.projection);
      this.logger.record(
        "info",
        "runtime command accepted",
        commandCorrelation(request, this.environment.environmentId),
        {
          eventCount: committed.events.length,
        },
      );
      return committed.receipt;
    } catch (error) {
      if (!(error instanceof DomainError)) {
        throw error;
      }
      const receipt: CommandReceipt = {
        commandId: request.commandId,
        status: "rejected",
        firstSequence: null,
        lastSequence: null,
        eventTypes: [],
        error: { code: error.code, message: error.message },
      };
      this.database.transaction(() => {
        this.insertReceipt(receipt, intentHash);
      });
      this.logger.record(
        "warn",
        "runtime command rejected",
        commandCorrelation(request, this.environment.environmentId),
        { code: error.code },
      );
      return receipt;
    }
  }

  private commitAccepted(
    request: RpcRequest,
    intentHash: string,
    projection: RuntimeProjection,
    decisions: ReturnType<typeof decide>,
  ): { receipt: CommandReceipt; events: RuntimeEventEnvelope[]; projection: RuntimeProjection } {
    let nextProjection = projection;
    let nextSequence = this.latestSequence();
    const events: RuntimeEventEnvelope[] = [];

    for (const decision of decisions) {
      nextSequence += 1;
      const event = RuntimeEvent.parse(decision);
      const envelope: RuntimeEventEnvelope = {
        protocolVersion: 1,
        sequence: nextSequence,
        eventId: EventId.parse(randomUUID()),
        occurredAt: new Date().toISOString(),
        event,
      };
      nextProjection = this.applyEvent(nextProjection, envelope);
      events.push(envelope);
    }

    const firstSequence = events[0]?.sequence ?? null;
    const lastSequence = events.at(-1)?.sequence ?? null;
    const firstEvent = events[0]?.event;
    const result =
      firstEvent?.type === "project.registered"
        ? ProjectRegisterResult.parse({ projectId: firstEvent.project.projectId })
        : undefined;
    const receipt: CommandReceipt = {
      commandId: request.commandId,
      status: "accepted",
      firstSequence,
      lastSequence,
      eventTypes: events.map((event) => event.event.type),
      ...(result ? { result } : {}),
    };

    this.database.transaction(() => {
      this.insertReceipt(receipt, intentHash);
      for (const event of events) {
        this.database.execute(
          "INSERT INTO events (sequence, event_id, command_id, event_type, event_version, event_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            event.sequence,
            event.eventId,
            request.commandId,
            event.event.type,
            1,
            JSON.stringify(event),
            event.occurredAt,
          ],
        );
      }
      this.saveProjection(nextProjection);
    });

    return { receipt, events, projection: nextProjection };
  }

  private scheduleReactors(events: RuntimeEventEnvelope[], projection: RuntimeProjection): void {
    const task = this.runReactors({ events, projection });
    this.reactorTasks.add(task);
    void task.then(
      () => this.reactorTasks.delete(task),
      () => this.reactorTasks.delete(task),
    );
  }

  private async runReactors(context: ReactorContext): Promise<void> {
    const failures = await this.reactorRunner.run(context);
    for (const failure of failures) {
      await this.appendReactorFailure(failure.name, errorMessage(failure.error));
    }
  }

  private async appendReactorFailure(reactor: string, message: string): Promise<void> {
    const operation = this.commandQueue.then(() => {
      const projection = this.readProjection();
      const sequence = this.latestSequence() + 1;
      const event: RuntimeEventEnvelope = {
        protocolVersion: 1,
        sequence,
        eventId: EventId.parse(randomUUID()),
        occurredAt: new Date().toISOString(),
        event: { type: "runtime.reactor.failed", reactor, message },
      };
      const nextProjection = this.applyEvent(projection, event);
      this.database.transaction(() => {
        this.database.execute(
          "INSERT INTO events (sequence, event_id, command_id, event_type, event_version, event_json, occurred_at) VALUES (?, ?, NULL, ?, ?, ?, ?)",
          [sequence, event.eventId, event.event.type, 1, JSON.stringify(event), event.occurredAt],
        );
        this.saveProjection(nextProjection);
      });
      this.publish([event]);
    });
    this.commandQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  private readProjection(): RuntimeProjection {
    const row = this.database.raw
      .prepare("SELECT projection_json FROM projection_state WHERE projection_id = 1")
      .get() as { projection_json?: string } | undefined;
    if (!row?.projection_json) {
      return createEmptyProjection(this.environment);
    }
    return JSON.parse(row.projection_json) as RuntimeProjection;
  }

  private saveProjection(projection: RuntimeProjection): void {
    this.database.execute(
      "INSERT INTO projection_state (projection_id, revision, projection_json) VALUES (1, ?, ?) ON CONFLICT(projection_id) DO UPDATE SET revision = excluded.revision, projection_json = excluded.projection_json",
      [projection.lastSequence, JSON.stringify(projection)],
    );
  }

  private readEventsAfter(sequence: number): RuntimeEventEnvelope[] {
    const rows = this.database.raw
      .prepare("SELECT sequence, event_json FROM events WHERE sequence > ? ORDER BY sequence ASC")
      .all(sequence) as Array<{ sequence: number; event_json: string }>;
    return rows.map((row) => {
      try {
        return RuntimeEventEnvelope.parse(JSON.parse(row.event_json));
      } catch (error) {
        throw new StoredEventCompatibilityError(row.sequence, error);
      }
    });
  }

  private readReceipt(commandId: string): CommandReceipt | undefined {
    const row = this.readReceiptRow(commandId);
    return row;
  }

  private readReceiptRow(commandId: string): CommandReceipt | undefined {
    const row = this.database.raw.prepare("SELECT receipt_json FROM commands WHERE command_id = ?").get(commandId) as
      | { receipt_json?: string }
      | undefined;
    return row?.receipt_json ? (JSON.parse(row.receipt_json) as CommandReceipt) : undefined;
  }

  private readIntentHash(commandId: string): string | undefined {
    const row = this.database.raw.prepare("SELECT intent_hash FROM commands WHERE command_id = ?").get(commandId) as
      | { intent_hash?: string }
      | undefined;
    return row?.intent_hash;
  }

  private insertReceipt(receipt: CommandReceipt, intentHash: string): void {
    this.database.execute(
      "INSERT INTO commands (command_id, intent_hash, status, receipt_json, created_at) VALUES (?, ?, ?, ?, ?)",
      [receipt.commandId, intentHash, receipt.status, JSON.stringify(receipt), new Date().toISOString()],
    );
  }

  private latestSequence(): number {
    const row = this.database.raw.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events").get() as
      | { sequence?: number }
      | undefined;
    return row?.sequence ?? 0;
  }

  private publish(events: RuntimeEventEnvelope[]): void {
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // A disconnected subscriber cannot invalidate a committed command.
        }
      }
    }
  }
}

function hashIntent(command: RuntimeCommand): string {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function commandCorrelation(request: RpcRequest, workspaceId: string): LogCorrelation {
  const command = request.command;
  return {
    commandId: request.commandId,
    workspaceId,
    ...(command.type === "thread.a2a"
      ? { threadId: command.targetThreadId }
      : command.type.startsWith("thread.") && "threadId" in command && typeof command.threadId === "string"
        ? { threadId: command.threadId }
        : {}),
    ...(command.type.startsWith("terminal.") && "terminalId" in command && typeof command.terminalId === "string"
      ? { terminalId: command.terminalId }
      : {}),
    ...(command.type.startsWith("browser.") &&
    "tab" in command &&
    typeof command.tab === "object" &&
    command.tab !== null &&
    "browserTabId" in command.tab &&
    typeof command.tab.browserTabId === "string"
      ? { browserTabId: command.tab.browserTabId }
      : {}),
  };
}
