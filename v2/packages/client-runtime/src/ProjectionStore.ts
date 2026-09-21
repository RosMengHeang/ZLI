import {
  RuntimeEventEnvelope,
  RuntimeProjection,
  type RuntimeEventEnvelope as RuntimeEventEnvelopeValue,
  type RuntimeProjection as RuntimeProjectionValue,
} from "@zli-v2/contracts";

export type ProjectionListener = (projection: RuntimeProjectionValue) => void;
export type EventApplication = "applied" | "duplicate" | "gap";

export class ProjectionStore {
  #projection: RuntimeProjectionValue | undefined;
  readonly #listeners = new Set<ProjectionListener>();

  current(): RuntimeProjectionValue | undefined {
    return this.#projection;
  }

  replace(input: unknown): RuntimeProjectionValue {
    this.#projection = RuntimeProjection.parse(input);
    this.#publish();
    return this.#projection;
  }

  apply(input: unknown): EventApplication {
    const envelope: RuntimeEventEnvelopeValue = RuntimeEventEnvelope.parse(input);
    const current = this.#projection;
    if (current === undefined) return "gap";
    if (envelope.sequence <= current.lastSequence) return "duplicate";
    if (envelope.sequence !== current.lastSequence + 1) return "gap";

    const event = envelope.event;
    switch (event.type) {
      case "runtime.ready":
        this.#projection = { ...current, lastSequence: envelope.sequence };
        break;
      case "runtime.reactor.failed":
      case "worktree.remove.requested":
      case "worktree.archive.requested":
      case "terminal.write.requested":
      case "terminal.resize.requested":
      case "terminal.stop.requested":
      case "review.refresh.requested":
      case "review.commit.requested":
      case "review.merge.requested":
      case "review.abortMerge.requested":
        this.#projection = { ...current, lastSequence: envelope.sequence };
        break;
      case "project.registered": {
        const projects = current.projects.filter(
          (project) => project.projectId !== event.project.projectId,
        );
        this.#projection = {
          ...current,
          projects: [...projects, event.project],
          lastSequence: envelope.sequence,
        };
        break;
      }
      case "worktree.create.requested":
        this.#projection = {
          ...current,
          worktrees: [...current.worktrees.filter((worktree) => worktree.worktreeId !== event.worktree.worktreeId), event.worktree],
          lastSequence: envelope.sequence,
        };
        break;
      case "worktree.status.changed":
        this.#projection = {
          ...current,
          worktrees: current.worktrees.map((worktree) => worktree.worktreeId === event.worktreeId ? {
            ...worktree,
            status: event.status,
            ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
          } : worktree),
          lastSequence: envelope.sequence,
        };
        break;
      case "worktree.removed":
      case "worktree.archived":
        this.#projection = { ...current, worktrees: current.worktrees.filter((worktree) => worktree.worktreeId !== event.worktreeId), lastSequence: envelope.sequence };
        break;
      case "terminal.create.requested":
        this.#projection = {
          ...current,
          terminals: [...current.terminals.filter((terminal) => terminal.terminalId !== event.terminal.terminalId), event.terminal],
          lastSequence: envelope.sequence,
        };
        break;
      case "terminal.status.changed":
        this.#projection = {
          ...current,
          terminals: current.terminals.map((terminal) => terminal.terminalId === event.terminalId ? {
            ...terminal,
            status: event.status,
            ...(event.lastSequence === undefined ? {} : { lastSequence: event.lastSequence }),
            ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
          } : terminal),
          lastSequence: envelope.sequence,
        };
        break;
      case "review.updated":
        this.#projection = {
          ...current,
          reviews: [...(current.reviews ?? []).filter((review) => review.worktreeId !== event.review.worktreeId), event.review],
          lastSequence: envelope.sequence,
        };
        break;
      case "review.archived":
        this.#projection = {
          ...current,
          reviews: (current.reviews ?? []).filter((review) => review.worktreeId !== event.worktreeId),
          lastSequence: envelope.sequence,
        };
        break;
    }

    this.#publish();
    return "applied";
  }

  subscribe(listener: ProjectionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #publish(): void {
    if (this.#projection === undefined) return;
    for (const listener of this.#listeners) listener(this.#projection);
  }
}
