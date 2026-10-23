import { randomUUID } from "node:crypto";

import { CommandId, type RuntimeEventEnvelope } from "@zli-v2/contracts";

import type { Engine } from "../orchestration/Engine.js";
import { createSupportBundle, SupportBundleError } from "./SupportBundle.js";
import { StructuredLogger } from "./StructuredLogger.js";

export class DiagnosticsReactor {
  private readonly tasks = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly engine: Engine,
    private readonly logger = new StructuredLogger(),
  ) {
    this.unsubscribe = engine.subscribe((envelope) => this.onEvent(envelope));
  }

  stop(): void {
    this.unsubscribe();
  }

  async waitForIdle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.all([...this.tasks]);
    await this.engine.projection();
  }

  private onEvent(envelope: RuntimeEventEnvelope): void {
    if (envelope.event.type !== "diagnostics.bundle.requested") return;
    const task = this.createBundle(envelope.event.destinationPath, envelope.event.allowedRoot);
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }

  private async createBundle(destinationPath: string, allowedRoot?: string): Promise<void> {
    try {
      const projection = await this.engine.projection();
      const events = await this.engine.eventsAfter(Math.max(0, projection.lastSequence - 200));
      const request = events.at(-1)?.event;
      const desktopLogs = request?.type === "diagnostics.bundle.requested" ? (request.desktopLogs ?? []) : [];
      const desktopApp = request?.type === "diagnostics.bundle.requested" ? request.desktopApp : undefined;
      const result = await createSupportBundle({
        destinationPath,
        ...(allowedRoot ? { allowedRoot } : {}),
        ...(desktopApp ? { app: desktopApp } : {}),
        projection,
        events,
        logs: [...this.logger.snapshot(), ...desktopLogs],
      });
      await this.engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "diagnostics.bundle.created",
          bundle: {
            path: result.path,
            bytes: result.bytes,
            entries: result.entries,
            createdAt: new Date().toISOString(),
          },
        },
      });
    } catch (error) {
      const message = error instanceof SupportBundleError ? error.message : "Unable to create support bundle.";
      await this.engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: { type: "diagnostics.bundle.failed", message },
      });
    }
  }
}
