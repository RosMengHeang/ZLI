import { randomUUID } from "node:crypto";

import { CommandId, ReviewProjection, type RuntimeEventEnvelope, WorktreeId } from "@zli-v2/contracts";

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
        this.start(event.worktreeId, () => this.runMerge(event.worktreeId, event.targetRef, event.commitMessage));
        return;
      case "review.abortMerge.requested":
        this.start(event.worktreeId, () => this.runAbortMerge(event.worktreeId));
        return;
      case "thread.status.changed":
        // A completed turn reports idle with its turn id; that is when an agent's edits land on disk.
        if (event.status === "idle" && event.turnId) this.track(this.refreshAfterTurn(event.threadId));
        return;
      default:
        return;
    }
  }

  private async refreshAfterTurn(threadId: string): Promise<void> {
    const projection = await this.engine.projection();
    const worktreeId = projection.threads.find((thread) => thread.threadId === threadId)?.worktreeId;
    const review = projection.reviews?.find((candidate) => candidate.worktreeId === worktreeId);
    if (!worktreeId || !review) return;
    this.start(worktreeId, () => this.runRefresh(worktreeId, review.baseRef));
  }

  private start(worktreeId: string, taskFactory: () => Promise<void>): void {
    this.track(taskFactory().catch((error) => this.dispatchError(worktreeId, error)));
  }

  private track(task: Promise<void>): void {
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

  private async runMerge(worktreeId: string, targetRef: string, commitMessage: string | undefined): Promise<void> {
    const input = await this.input(worktreeId, await this.baseRef(worktreeId));
    // The target branch may be checked out in another worktree of the project, such as a chat's own one: the
    // merge runs there, since Git keeps a branch in one working copy at a time.
    const projection = await this.engine.projection();
    const source = projection.worktrees.find((candidate) => candidate.worktreeId === worktreeId);
    const holder = projection.worktrees.find(
      (candidate) =>
        candidate.worktreeId !== worktreeId &&
        candidate.projectId === source?.projectId &&
        candidate.status === "ready" &&
        candidate.branch === targetRef,
    );
    let merged: ReviewProjection;
    try {
      merged = await this.service.merge({
        ...input,
        ...(holder ? { repositoryPath: holder.path } : {}),
        targetRef,
        ...(commitMessage ? { commitMessage } : {}),
      });
    } catch (error) {
      await this.dispatchError(worktreeId, error, true);
      return;
    }
    await this.dispatchUpdated({ ...merged, mergedAt: new Date().toISOString() });
  }

  private async runAbortMerge(worktreeId: string): Promise<void> {
    const input = await this.input(worktreeId, await this.baseRef(worktreeId));
    // The merge may have run in another worktree that holds the target branch; abort it where it stopped. The
    // project folder comes first, as before, then the project's other worktrees.
    const projection = await this.engine.projection();
    const source = projection.worktrees.find((candidate) => candidate.worktreeId === worktreeId);
    const places = [
      input.repositoryPath,
      ...projection.worktrees
        .filter(
          (candidate) =>
            candidate.worktreeId !== worktreeId &&
            candidate.projectId === source?.projectId &&
            candidate.status === "ready",
        )
        .map((candidate) => candidate.path),
    ];
    let repositoryPath = input.repositoryPath;
    for (const place of places) {
      if (await this.service.mergeInProgress(place)) {
        repositoryPath = place;
        break;
      }
    }
    await this.dispatchUpdated(await this.service.abortMerge({ ...input, repositoryPath }));
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

  private async dispatchError(worktreeId: string, error: unknown, fromMerge = false): Promise<void> {
    const projection = await this.engine.projection();
    const review = projection.reviews?.find((candidate) => candidate.worktreeId === worktreeId);
    if (!review) return;
    const now = new Date().toISOString();
    const { mergedAt: _earlier, ...rest } = review;
    await this.dispatchUpdated({
      ...rest,
      errorMessage: error instanceof Error ? error.message : "Git review operation failed.",
      ...(fromMerge ? { mergedAt: now } : {}),
      updatedAt: now,
    });
  }
}
