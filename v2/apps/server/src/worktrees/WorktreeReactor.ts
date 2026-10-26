import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import {
  CommandId,
  ProjectId,
  type RuntimeEventEnvelope,
  WorktreeId,
  type WorktreeProjection,
} from "@zli-v2/contracts";

import type { Engine } from "../orchestration/Engine.js";
import { isNotGitRepository, type WorktreeService, type WorktreeState } from "./WorktreeService.js";

type WorktreeReactorOptions = {
  bootstrap?: (context: { worktreePath: string; signal: AbortSignal }) => Promise<void>;
  /** Project setup (zli.json) for a newly created worktree. Runs after `bootstrap`, before "ready". */
  setup?: (context: {
    worktreeId: string;
    projectId: string;
    repoPath: string;
    worktreePath: string;
    signal: AbortSignal;
  }) => Promise<void>;
};

type CreateIntent = Extract<RuntimeEventEnvelope["event"], { type: "worktree.create.requested" }>;

export class WorktreeReactor {
  private readonly intents = new Map<string, CreateIntent>();
  private readonly creating = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly engine: Engine,
    private readonly service: WorktreeService,
    private readonly options: WorktreeReactorOptions = {},
  ) {
    this.unsubscribe = engine.subscribe((envelope) => this.onEvent(envelope));
    // A folder can gain or lose its .git while ZLI is closed.
    this.track(
      engine.projection().then(async (projection) => {
        await Promise.all(projection.projects.map((project) => this.checkGit(project.projectId)));
      }),
    );
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
      case "project.registered":
        this.track(this.checkGit(envelope.event.project.projectId));
        return;
      case "worktree.create.requested":
        this.intents.set(envelope.event.worktree.worktreeId, envelope.event);
        this.startCreate(envelope.event);
        return;
      case "worktree.status.changed":
        if (envelope.event.status === "cancelling") {
          const worktreeId = envelope.event.worktreeId;
          // Nothing is running for this worktree, so no job will ever report "cancelled".
          if (!this.service.cancel(worktreeId) && !this.creating.has(worktreeId)) {
            this.track(this.dispatchStatus(worktreeId, "cancelled"));
          }
        } else if (envelope.event.status === "queued") {
          this.track(this.retry(envelope.event.worktreeId));
        }
        return;
      case "worktree.imported":
        if (envelope.event.worktree.kind === "checkout") this.track(this.runPlacement(envelope.event.worktree));
        return;
      case "worktree.remove.requested":
        this.startRemove(envelope.event.worktreeId, envelope.event.force, envelope.event.deleteBranch ?? false);
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
    if (this.creating.has(worktreeId)) return;
    this.creating.add(worktreeId);
    this.track(this.runCreate(intent).finally(() => this.creating.delete(worktreeId)));
  }

  /** Imported worktrees and checkouts have no create intent; retrying one re-reads the folder instead. */
  private async retry(worktreeId: string): Promise<void> {
    const intent = await this.intentFor(worktreeId);
    if (intent) {
      this.startCreate(intent);
      return;
    }
    const worktree = (await this.engine.projection()).worktrees.find((entry) => entry.worktreeId === worktreeId);
    if (worktree) await this.runPlacement(worktree, true);
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
    const { bootstrap, setup } = this.options;
    const prepare =
      bootstrap || setup
        ? async (context: { worktreePath: string; signal: AbortSignal }) => {
            await bootstrap?.(context);
            await setup?.({
              ...context,
              worktreeId: intent.worktree.worktreeId,
              projectId: project.projectId,
              repoPath: project.path,
            });
          }
        : undefined;
    const job = this.service.create({
      jobId: intent.worktree.worktreeId,
      repoPath: project.path,
      workspaceRoot: intent.workspaceRoot,
      worktreePath: intent.worktree.path,
      branch: intent.worktree.branch,
      ...(intent.baseRef ? { baseRef: intent.baseRef } : {}),
      ...(intent.checkoutExistingBranch ? { checkoutExistingBranch: true } : {}),
      ...(prepare ? { bootstrap: prepare } : {}),
      onState: reportState,
    });
    try {
      await job.promise;
    } catch (error) {
      if (isNotGitRepository(error instanceof Error ? error.cause : undefined)) await this.checkGit(project.projectId);
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
    }
  }

  /** Intents are cached in memory; after a restart they are recovered from the durable event log. */
  private async intentFor(worktreeId: string): Promise<CreateIntent | undefined> {
    const cached = this.intents.get(worktreeId);
    if (cached) return cached;
    for (const envelope of await this.engine.eventsAfter(0)) {
      const event = envelope.event;
      if (event.type === "worktree.create.requested" && event.worktree.worktreeId === worktreeId) {
        this.intents.set(worktreeId, event);
        return event;
      }
    }
    return undefined;
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }

  private startRemove(worktreeId: string, force: boolean, deleteBranch: boolean): void {
    const task = this.runRemove(worktreeId, force, deleteBranch);
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }

  private async runRemove(worktreeId: string, force: boolean, deleteBranch: boolean): Promise<void> {
    const projection = await this.engine.projection();
    const worktree = projection.worktrees.find((entry) => entry.worktreeId === worktreeId);
    const project = worktree ? projection.projects.find((entry) => entry.projectId === worktree.projectId) : undefined;
    if (!worktree || !project) return;
    // A checkout is the project's own working copy. Removing it from the workspace must never touch disk.
    if (worktree.kind === "checkout") {
      await this.dispatchCompletion("worktree.removed", worktreeId);
      return;
    }
    const intent = await this.intentFor(worktreeId);
    try {
      await this.service.remove({
        repoPath: project.path,
        // Imported checkouts have no create intent; their parent folder is the narrowest safe root.
        workspaceRoot: intent?.workspaceRoot ?? dirname(worktree.path),
        worktreePath: worktree.path,
        branch: worktree.branch,
        force,
        deleteBranch,
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

  /**
   * The client imports a checkout with a placeholder branch; the real one comes from git.
   * A checkout of a folder that is not a Git repository stays ready so agents can still run in it.
   */
  private async runPlacement(worktree: WorktreeProjection, markReady = false): Promise<void> {
    if (worktree.kind === "checkout") await this.checkGit(worktree.projectId);
    try {
      const branch = await this.service.currentBranch(worktree.path);
      if (markReady || branch !== worktree.branch) {
        await this.dispatchStatus(worktree.worktreeId, "ready", undefined, branch);
      }
    } catch (error) {
      if (worktree.kind === "checkout" && isNotGitRepository(error)) {
        if (markReady) await this.dispatchStatus(worktree.worktreeId, "ready");
        return;
      }
      await this.dispatchStatus(
        worktree.worktreeId,
        "failed",
        error instanceof Error ? error.message : "Could not read the checkout's branch.",
      );
    }
  }

  /** Records whether the project folder is a Git repository, when that differs from what is known. */
  private async checkGit(projectId: string): Promise<void> {
    try {
      const project = (await this.engine.projection()).projects.find((entry) => entry.projectId === projectId);
      if (!project) return;
      const git = await this.service.isRepository(project.path);
      if (git === undefined || git === (project.git ?? true)) return;
      await this.engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: { type: "project.git", projectId: ProjectId.parse(projectId), git },
      });
    } catch {
      // The flag only steers the UI; a project archived meanwhile needs no update.
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

  private dispatchStatus(
    worktreeId: string,
    status: WorktreeState,
    errorMessage?: string,
    branch?: string,
  ): Promise<void> {
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "worktree.status",
          worktreeId: WorktreeId.parse(worktreeId),
          status,
          ...(errorMessage ? { errorMessage } : {}),
          ...(branch ? { branch } : {}),
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
