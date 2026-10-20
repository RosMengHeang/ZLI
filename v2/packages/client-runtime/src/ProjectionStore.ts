import {
  RuntimeEventEnvelope,
  RuntimeProjection,
  appendThreadMessage,
  deriveSharedProjectContexts,
  removeSession,
  upsertThreadActivity,
  type RuntimeEventEnvelope as RuntimeEventEnvelopeValue,
  type RuntimeProjection as RuntimeProjectionValue,
} from "@zli-v2/contracts";

function touchThread(
  threads: RuntimeProjectionValue["threads"],
  threadId: string,
  occurredAt: string,
): RuntimeProjectionValue["threads"] {
  return threads.map((thread) => (thread.threadId === threadId ? { ...thread, updatedAt: occurredAt } : thread));
}

/** Why the projection changed, so a listener can forward the event instead of the whole projection. */
export type ProjectionChange = { kind: "replace" } | { kind: "event"; envelope: RuntimeEventEnvelopeValue };
export type ProjectionListener = (projection: RuntimeProjectionValue, change: ProjectionChange) => void;
export type EventApplication = "applied" | "duplicate" | "gap";

export class ProjectionStore {
  #projection: RuntimeProjectionValue | undefined;
  readonly #listeners = new Set<ProjectionListener>();

  current(): RuntimeProjectionValue | undefined {
    return this.#projection;
  }

  replace(input: unknown): RuntimeProjectionValue {
    const parsed = RuntimeProjection.parse(input);
    this.#projection = { ...parsed, projectContexts: deriveSharedProjectContexts(parsed) };
    this.#publish({ kind: "replace" });
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
        const projects = current.projects.filter((project) => project.projectId !== event.project.projectId);
        this.#projection = {
          ...current,
          projects: [...projects, event.project],
          lastSequence: envelope.sequence,
        };
        break;
      }
      case "project.archived":
        this.#projection = {
          ...current,
          projects: current.projects.filter((project) => project.projectId !== event.projectId),
          lastSequence: envelope.sequence,
        };
        break;
      case "worktree.create.requested":
      case "worktree.imported":
        this.#projection = {
          ...current,
          worktrees: [
            ...current.worktrees.filter((worktree) => worktree.worktreeId !== event.worktree.worktreeId),
            event.worktree,
          ],
          lastSequence: envelope.sequence,
        };
        break;
      case "worktree.status.changed":
        this.#projection = {
          ...current,
          worktrees: current.worktrees.map((worktree) =>
            worktree.worktreeId === event.worktreeId
              ? {
                  ...worktree,
                  status: event.status,
                  ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
                  ...(event.branch ? { branch: event.branch } : {}),
                }
              : worktree,
          ),
          lastSequence: envelope.sequence,
        };
        break;
      case "worktree.removed":
      case "worktree.archived":
        this.#projection = {
          ...current,
          worktrees: current.worktrees.filter((worktree) => worktree.worktreeId !== event.worktreeId),
          lastSequence: envelope.sequence,
        };
        break;
      case "terminal.create.requested":
        this.#projection = {
          ...current,
          terminals: [
            ...current.terminals.filter((terminal) => terminal.terminalId !== event.terminal.terminalId),
            { ...event.terminal, createdAt: envelope.occurredAt, updatedAt: envelope.occurredAt },
          ],
          lastSequence: envelope.sequence,
        };
        break;
      case "terminal.status.changed":
        this.#projection = {
          ...current,
          terminals: current.terminals.map((terminal) =>
            terminal.terminalId === event.terminalId
              ? {
                  ...terminal,
                  status: event.status,
                  updatedAt: envelope.occurredAt,
                  ...(event.lastSequence === undefined ? {} : { lastSequence: event.lastSequence }),
                  ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
                }
              : terminal,
          ),
          lastSequence: envelope.sequence,
        };
        break;
      case "review.updated":
        this.#projection = {
          ...current,
          reviews: [
            ...(current.reviews ?? []).filter((review) => review.worktreeId !== event.review.worktreeId),
            event.review,
          ],
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
      case "thread.a2a.delivered":
        this.#projection = {
          ...current,
          messages: [
            ...(current.messages ?? []).filter((message) => message.messageId !== event.message.messageId),
            event.message,
          ].slice(-2_000),
          lastSequence: envelope.sequence,
        };
        break;
      case "thread.message.appended":
        this.#projection = {
          ...current,
          messages: appendThreadMessage(current.messages ?? [], event.message),
          threads: touchThread(current.threads, event.message.threadId, envelope.occurredAt),
          lastSequence: envelope.sequence,
        };
        break;
      case "thread.activity.updated":
        this.#projection = {
          ...current,
          activities: upsertThreadActivity(current.activities ?? [], event.activity),
          threads: touchThread(current.threads, event.activity.threadId, envelope.occurredAt),
          lastSequence: envelope.sequence,
        };
        break;
      case "thread.start.requested":
        this.#projection = {
          ...current,
          threads: [
            ...current.threads.filter((thread) => thread.threadId !== event.thread.threadId),
            { ...event.thread, createdAt: envelope.occurredAt, updatedAt: envelope.occurredAt },
          ],
          lastSequence: envelope.sequence,
        };
        break;
      case "thread.status.changed":
        this.#projection = {
          ...current,
          threads: current.threads.map((thread) =>
            thread.threadId === event.threadId
              ? {
                  ...thread,
                  status: event.status,
                  updatedAt: envelope.occurredAt,
                  ...(event.turnId ? { activeTurnId: event.turnId } : {}),
                  ...(event.capabilities ? { capabilities: event.capabilities } : {}),
                  ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
                }
              : thread,
          ),
          lastSequence: envelope.sequence,
        };
        break;
      case "session.deleted":
        this.#projection = {
          ...removeSession(current, event.terminalIds, event.threadIds),
          lastSequence: envelope.sequence,
        };
        break;
      case "browser.updated":
        this.#projection = {
          ...current,
          browserTabs: [...current.browserTabs.filter((tab) => tab.browserTabId !== event.tab.browserTabId), event.tab],
          lastSequence: envelope.sequence,
        };
        break;
      case "browser.closed":
        this.#projection = {
          ...current,
          browserTabs: current.browserTabs.filter((tab) => tab.browserTabId !== event.browserTabId),
          lastSequence: envelope.sequence,
        };
        break;
      default:
        // Events this store cannot fold locally still change the server projection, so ask for a
        // fresh copy instead of leaving lastSequence behind until an unrelated event arrives.
        return "gap";
    }

    if (this.#projection && this.#projection !== current) {
      this.#projection = {
        ...this.#projection,
        projectContexts: deriveSharedProjectContexts(this.#projection),
      };
    }

    this.#publish({ kind: "event", envelope });
    return "applied";
  }

  subscribe(listener: ProjectionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #publish(change: ProjectionChange): void {
    if (this.#projection === undefined) return;
    for (const listener of this.#listeners) listener(this.#projection, change);
  }
}
