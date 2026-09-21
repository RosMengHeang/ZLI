import { randomUUID } from "node:crypto";

import {
  CommandId,
  ProjectId,
  WorktreeId,
  type LegacyImportPreview,
  type RuntimeEventEnvelope,
} from "@zli-v2/contracts";

import { Engine } from "../orchestration/Engine.js";
import { LegacyImporter } from "./LegacyImporter.js";
import { LegacyScanner } from "./LegacyScanner.js";

export class LegacyImportReactor {
  private readonly tasks = new Set<Promise<void>>();
  private readonly previews = new Map<string, LegacyImportPreview>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly engine: Engine,
    private readonly scanner = new LegacyScanner(),
    private readonly importer = new LegacyImporter(engine),
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
    const event = envelope.event;
    switch (event.type) {
      case "legacy.scan.requested":
        this.start(() => this.scan(event.batchId, event.snapshotPath));
        return;
      case "legacy.import.requested":
        this.start(() => this.import(event.batchId, event.selectedRecordIds));
        return;
      case "legacy.rollback.requested":
        this.start(() => this.rollback(event.batchId));
        return;
      default:
        return;
    }
  }

  private start(factory: () => Promise<void>): void {
    const task = factory();
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }

  private async scan(batchId: string, snapshotPath: string): Promise<void> {
    try {
      const result = await this.scanner.scan(snapshotPath, batchId);
      this.previews.set(batchId, result.preview);
      await this.dispatch({ type: "legacy.scan.completed", preview: result.preview });
    } catch (error) {
      await this.fail(batchId, error instanceof Error ? error.message : "Legacy scan failed.");
    }
  }

  private async import(batchId: string, selectedRecordIds: readonly string[]): Promise<void> {
    try {
      const preview = this.previews.get(batchId) ?? (await this.engine.projection()).legacyImport?.preview;
      if (!preview || preview.batchId !== batchId) throw new Error("Scan the legacy snapshot before importing it.");
      const result = await this.importer.import(preview, selectedRecordIds);
      await this.dispatch({
        type: "legacy.import.completed",
        batchId,
        importedProjectIds: result.importedProjectIds.map((id) => ProjectId.parse(id)),
        importedWorktreeIds: result.importedWorktreeIds.map((id) => WorktreeId.parse(id)),
      });
    } catch (error) {
      await this.fail(batchId, error instanceof Error ? error.message : "Legacy import failed.");
    }
  }

  private async rollback(batchId: string): Promise<void> {
    try {
      const projection = await this.engine.projection();
      const state = projection.legacyImport;
      if (state?.batchId !== batchId) throw new Error("No imported legacy batch is available to roll back.");
      await this.importer.rollback({
        importedProjectIds: state.importedProjectIds,
        importedWorktreeIds: state.importedWorktreeIds,
      });
      await this.dispatch({ type: "legacy.rollback.completed", batchId });
    } catch (error) {
      await this.fail(batchId, error instanceof Error ? error.message : "Legacy rollback failed.");
    }
  }

  private async fail(batchId: string, message: string): Promise<void> {
    await this.dispatch({ type: "legacy.operation.failed", batchId, message });
  }

  private dispatch(command: Parameters<Engine["dispatch"]>[0]["command"]): Promise<void> {
    return this.engine.dispatch({
      protocolVersion: 1,
      commandId: CommandId.parse(randomUUID()),
      command,
    }).then(() => undefined);
  }
}
