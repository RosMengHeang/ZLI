import { randomUUID } from "node:crypto";

import { CommandId, TerminalId, type RuntimeEventEnvelope } from "@zli-v2/contracts";

import { Engine } from "../orchestration/Engine.js";
import { TerminalService } from "./TerminalService.js";

type CreateIntent = Extract<RuntimeEventEnvelope["event"], { type: "terminal.create.requested" }>;

export class TerminalReactor {
  private readonly intents = new Map<string, CreateIntent>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeExit: () => void;

  constructor(
    private readonly engine: Engine,
    private readonly service: TerminalService,
  ) {
    this.unsubscribe = engine.subscribe((envelope) => this.onEvent(envelope));
    this.unsubscribeExit = service.subscribeExit((terminalId, event) => {
      this.track(this.dispatchStatus(terminalId, "exited", undefined, event.code));
    });
  }

  stop(): void {
    this.unsubscribe();
    this.unsubscribeExit();
  }

  async waitForIdle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.all([...this.tasks]);
    await this.engine.projection();
  }

  async restore(): Promise<void> {
    const projection = await this.engine.projection();
    const events = await this.engine.eventsAfter(0);
    const writes = new Map<string, string[]>();
    for (const envelope of events) {
      if (envelope.event.type === "terminal.write.requested") {
        const existing = writes.get(envelope.event.terminalId) ?? [];
        existing.push(envelope.event.data);
        writes.set(envelope.event.terminalId, existing);
      }
    }
    for (const envelope of events) {
      if (envelope.event.type !== "terminal.create.requested") continue;
      const intent = envelope.event;
      const terminal = projection.terminals.find((candidate) => candidate.terminalId === intent.terminal.terminalId);
      if (!terminal || (terminal.status !== "running" && terminal.status !== "starting") || this.intents.has(terminal.terminalId)) continue;
      this.intents.set(terminal.terminalId, intent);
      this.startCreate(intent, writes.get(terminal.terminalId) ?? []);
    }
    await this.waitForIdle();
  }

  private onEvent(envelope: RuntimeEventEnvelope): void {
    switch (envelope.event.type) {
      case "terminal.create.requested":
        this.intents.set(envelope.event.terminal.terminalId, envelope.event);
        this.startCreate(envelope.event);
        return;
      case "terminal.write.requested":
        this.track(this.runWrite(envelope.event.terminalId, envelope.event.data));
        return;
      case "terminal.resize.requested":
        this.track(this.runResize(envelope.event.terminalId, envelope.event.cols, envelope.event.rows));
        return;
      case "terminal.stop.requested":
        this.track(this.runStop(envelope.event.terminalId));
        return;
      default:
        return;
    }
  }

  private startCreate(intent: CreateIntent, writes: readonly string[] = []): void {
    const task = this.runCreate(intent, writes);
    this.track(task);
  }

  private async runCreate(intent: CreateIntent, writes: readonly string[]): Promise<void> {
    try {
      await this.service.create({
        terminalId: intent.terminal.terminalId,
        worktreeId: intent.terminal.worktreeId,
        cwd: intent.cwd,
        shell: intent.shell,
        cols: intent.cols,
        rows: intent.rows,
        title: intent.terminal.title,
      });
      if (!this.service.wasReused(intent.terminal.terminalId)) {
        for (const data of writes) this.service.write(TerminalId.parse(intent.terminal.terminalId), data);
      }
      await this.dispatchStatus(intent.terminal.terminalId, "running");
    } catch (error) {
      await this.dispatchStatus(
        intent.terminal.terminalId,
        "failed",
        describeTerminalError(error, "Terminal startup failed."),
      );
    }
  }

  private async runWrite(terminalId: string, data: string): Promise<void> {
    try {
      this.service.write(TerminalId.parse(terminalId), data);
    } catch (error) {
      await this.dispatchStatus(
        terminalId,
        "failed",
        error instanceof Error ? error.message : "Terminal write failed.",
      );
    }
  }

  private async runResize(terminalId: string, cols: number, rows: number): Promise<void> {
    try {
      this.service.resize(TerminalId.parse(terminalId), cols, rows);
    } catch (error) {
      await this.dispatchStatus(
        terminalId,
        "failed",
        error instanceof Error ? error.message : "Terminal resize failed.",
      );
    }
  }

  private async runStop(terminalId: string): Promise<void> {
    try {
      this.service.stop(TerminalId.parse(terminalId));
    } catch (error) {
      await this.dispatchStatus(
        terminalId,
        "failed",
        error instanceof Error ? error.message : "Terminal stop failed.",
      );
    }
  }

  private dispatchStatus(
    terminalId: string,
    status: "running" | "exited" | "failed",
    errorMessage?: string,
    _exitCode?: number,
  ): Promise<void> {
    return this.engine
      .dispatch({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "terminal.status",
          terminalId: TerminalId.parse(terminalId),
          status,
          ...(errorMessage ? { errorMessage } : {}),
          ...(status === "exited" ? { lastSequence: this.service.get(TerminalId.parse(terminalId)).lastSequence } : {}),
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

function describeTerminalError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const cause = error.cause instanceof Error ? error.cause.message : typeof error.cause === "string" ? error.cause : undefined;
  return cause ? `${error.message} (${cause})` : error.message;
}
