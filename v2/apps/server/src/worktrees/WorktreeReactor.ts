import { randomUUID } from "node:crypto";

import { CommandId, WorktreeId, type RuntimeEventEnvelope } from "@zli-v2/contracts";

import type { Engine } from "../orchestration/Engine.js";
import type { WorktreeService, WorktreeState } from "./WorktreeService.js";

type WorktreeReactorOptions = {
  bootstrap?: (context: { worktreePath: string; signal: AbortSignal }) => Promise<void>;
};

type CreateIntent = Extract<RuntimeEventEnvelope["event"], { type: "worktree.create.requested" }>;

export class WorktreeReactor {
  private readonly intents = new Map<string, CreateIntent>();
  private readonly active = new Map<string, ReturnType<WorktreeService["create"]>>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly engine: Engine,
    private readonly service: WorktreeService,
    private readonly options: WorktreeReactorOptions = {},
  ) {
    this.unsubscribe = engine.subscribe((envelope) => this.onEvent(envelope));
  }

  stop(): void {
    this.unsubscribe();
  }

  async waitForIdle(): Promise<void> {
    while (this.tasks.size > 0) {
      await Promise.all([...this.tasks]);
    }
    await this.engine.projection();
  }

  private onEvent(envelope: RuntimeEventEnvelope): void {
    switch (envelope.event.type) {
      case "worktree.create.requested":
        this.intents.set(envelope.event.worktree.worktreeId, envelope.event);
        this.startCreate(envelope.event);
        return;
      case "worktree.status.changed":
        if (envelope.event.status === "cancelling") {
          this.service.cancel(envelope.event.worktreeId);
        } else if (envelope.event.status === "queued") {
          const intent = this.intents.get(envelope.event.worktreeId);
          if (intent) this.startCreate(intent);
        }
        return;
      case "worktree.remove.requested":
        this.startRemove(envelope.event.worktreeId, envelope.event.force);
        return;
      case "worktree.archive.requested":
        this.startArchive(envelope.event.worktreeId);
        return;
      default:
        return;
    }
  }

  private startCreate(intent: CreateIntent): void {
    const worktreeId = intent.worktree.worktreeId;
    if (this.active.has(worktreeId)) return;
    const task = this.runCreate(intent);
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }

  private async runCreate(intent: CreateIntent): Promise<void> {
    const projection = await this.engine.projection();
    const project = projection.projects.find((entry) => entry.projectId === intent.worktree.projectId);
    if (!project) {
      await this.dispatchStatus(intent.worktree.worktreeId, "failed", "Project no longer exists.");
      return;
    }

    let lastState: WorktreeState = "queued";
    let statusQueue = Promise.resolve();
    const reportState = (state: WorktreeState) => {
      lastState = state;
      if (state === "queued") return;
      statusQueue = statusQueue.then(() => this.dispatchStatus(intent.worktree.worktreeId, state));
    };
    const job = this.service.create({
      jobId: intent.worktree.worktreeId,
      repoPath: project.path,
      workspaceRoot: intent.workspaceRoot,
      worktreePath: intent.worktree.path,
      branch: intent.worktree.branch,
      ...(intent.baseRef ? { baseRef: intent.baseRef } : {}),
      ...(intent.checkoutExistingBranch ? { checkoutExistingBranch: true } : {}),
      ...(this.options.bootstrap ? { bootstrap: this.options.bootstrap } : {}),
      onState: reportState,
    });
    this.active.set(intent.worktree.worktreeId, job);
    try {
      await job.promise;
    } catch (error) {
      const finalState = lastState as WorktreeState;
      if (finalState !== "cancelled") {
        if (finalState !== "failed") reportState("failed");
        statusQueue = statusQueue.then(() =>
          this.dispatchStatus(
            intent.worktree.worktreeId,
            "failed",
            error instanceof Error ? error.message : "Worktree creation failed.",
          ),
        );
      }
    } finally {
      await statusQueue;
      this.active.delete(intent.worktree.worktreeId);
    }
  }

  private startRemove(worktreeId: string, force: boolean): void {
    const task = this.runRemove(worktreeId, force);
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }

  private async runRemove(worktreeId: string, force: boolean): Promise<void> {
    const projection = await this.engine.projection();
    const worktree = projection.worktrees.find((entry) => entry.worktreeId === worktreeId);
    const project = worktree ? projection.projects.find((entry) => entry.projectId === worktree.projectId) : undefined;
    const intent = this.intents.get(worktreeId);
    if (!worktree || !project || !intent) return;
    try {
      await this.service.remove({
        repoPath: project.path,
        workspaceRoot: intent.workspaceRoot,
        worktreePath: worktree.path,
        branch: worktree.branch,
        force,
      });
      await this.dispatchCompletion("worktree.removed", worktreeId);
    } catch (error) {
      await this.dispatchStatus(
        worktreeId,
        "failed",
        error instanceof Error ? error.message : "Worktree removal failed.",
      );
    }
  }

  private startArchive(worktreeId: string): void {
    const task = this.dispatchCompletion("worktree.archived", worktreeId);
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }

  private dispatchStatus(worktreeId: string, status: WorktreeState, errorMessage?: string): Promise<void> {
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "worktree.status",
          worktreeId: WorktreeId.parse(worktreeId),
          status,
          ...(errorMessage ? { errorMessage } : {}),
        },
      })
      .then(() => undefined);
  }

  private dispatchCompletion(type: "worktree.removed" | "worktree.archived", worktreeId: string): Promise<void> {
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: { type, worktreeId: WorktreeId.parse(worktreeId) },
      })
      .then(() => undefined);
  }
}
