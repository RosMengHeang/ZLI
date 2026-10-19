import { randomUUID } from "node:crypto";

import { CommandId, ReviewProjection, WorktreeId, type RuntimeEventEnvelope } from "@zli-v2/contracts";

import type { Engine } from "../orchestration/Engine.js";
import type { ReviewService, ReviewServiceInput } from "./ReviewService.js";

export class ReviewReactor {
  private readonly tasks = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly engine: Engine,
    private readonly service: ReviewService,
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
      case "review.refresh.requested":
        this.start(event.worktreeId, () => this.runRefresh(event.worktreeId, event.baseRef));
        return;
      case "review.diff.requested":
        this.start(event.worktreeId, () => this.runDiff(event.worktreeId, event.path));
        return;
      case "review.commit.requested":
        this.start(event.worktreeId, () => this.runCommit(event.worktreeId, event.message));
        return;
      case "review.merge.requested":
        this.start(event.worktreeId, () => this.runMerge(event.worktreeId, event.targetRef));
        return;
      case "review.abortMerge.requested":
        this.start(event.worktreeId, () => this.runAbortMerge(event.worktreeId));
        return;
      default:
        return;
    }
  }

  private start(worktreeId: string, taskFactory: () => Promise<void>): void {
    const task = taskFactory().catch((error) => this.dispatchError(worktreeId, error));
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }

  private async runRefresh(worktreeId: string, baseRef: string): Promise<void> {
    await this.dispatchUpdated(await this.service.refresh(await this.input(worktreeId, baseRef)));
  }

  private async runCommit(worktreeId: string, message: string): Promise<void> {
    const input = await this.input(worktreeId, await this.baseRef(worktreeId));
    await this.dispatchUpdated(await this.service.commit({ ...input, message }));
  }

  private async runDiff(worktreeId: string, path: string): Promise<void> {
    const input = await this.input(worktreeId, await this.baseRef(worktreeId));
    await this.dispatchUpdated(await this.service.diff({ ...input, path }));
  }

  private async runMerge(worktreeId: string, targetRef: string): Promise<void> {
    const input = await this.input(worktreeId, await this.baseRef(worktreeId));
    await this.dispatchUpdated(await this.service.merge({ ...input, targetRef }));
  }

  private async runAbortMerge(worktreeId: string): Promise<void> {
    const input = await this.input(worktreeId, await this.baseRef(worktreeId));
    await this.dispatchUpdated(await this.service.abortMerge(input));
  }

  private async input(worktreeId: string, baseRef: string): Promise<ReviewServiceInput> {
    const projection = await this.engine.projection();
    const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === worktreeId);
    const project = worktree
      ? projection.projects.find((candidate) => candidate.projectId === worktree.projectId)
      : undefined;
    if (!worktree || !project) throw new Error(`Cannot review missing worktree ${worktreeId}.`);
    return {
      worktreeId: WorktreeId.parse(worktreeId),
      worktreePath: worktree.path,
      repositoryPath: project.path,
      branch: worktree.branch,
      baseRef,
    };
  }

  private async baseRef(worktreeId: string): Promise<string> {
    const projection = await this.engine.projection();
    return projection.reviews?.find((review) => review.worktreeId === worktreeId)?.baseRef ?? "main";
  }

  private dispatchUpdated(review: unknown): Promise<void> {
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: { type: "review.updated", review: ReviewProjection.parse(review) },
      })
      .then(() => undefined);
  }

  private async dispatchError(worktreeId: string, error: unknown): Promise<void> {
    const projection = await this.engine.projection();
    const review = projection.reviews?.find((candidate) => candidate.worktreeId === worktreeId);
    if (!review) return;
    await this.dispatchUpdated({
      ...review,
      errorMessage: error instanceof Error ? error.message : "Git review operation failed.",
      updatedAt: new Date().toISOString(),
    });
  }
}
