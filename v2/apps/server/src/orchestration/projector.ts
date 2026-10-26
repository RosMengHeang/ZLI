import {
  appendCheckpoint,
  appendThreadMessage,
  deriveSharedProjectContexts,
  type EnvironmentDescriptor,
  pruneDevServers,
  RuntimeEvent,
  type RuntimeEventEnvelope,
  type RuntimeProjection,
  removeDevServer,
  removeSession,
  upsertDevServer,
  upsertThreadActivity,
  upsertUsageRecord,
} from "@zli-v2/contracts";

export function createEmptyProjection(environment: EnvironmentDescriptor): RuntimeProjection {
  return {
    environment,
    projects: [],
    projectContexts: [],
    worktrees: [],
    threads: [],
    terminals: [],
    browserTabs: [],
    legacyImport: { status: "idle", importedProjectIds: [], importedWorktreeIds: [] },
    attention: [],
    lastSequence: 0,
  };
}

export function projectEvent(projection: RuntimeProjection, envelope: RuntimeEventEnvelope): RuntimeProjection {
  const next = applyProjectionEvent(projection, envelope);
  return {
    ...next,
    projectContexts: deriveSharedProjectContexts(next),
    ...(next.devServers ? { devServers: pruneDevServers(next) } : {}),
  };
}

function applyProjectionEvent(projection: RuntimeProjection, envelope: RuntimeEventEnvelope): RuntimeProjection {
  const event = RuntimeEvent.parse(envelope.event);
  if (envelope.sequence !== projection.lastSequence + 1) {
    throw new Error(
      `Projection sequence mismatch: expected ${projection.lastSequence + 1}, received ${envelope.sequence}`,
    );
  }

  switch (event.type) {
    case "project.registered":
      return {
        ...projection,
        projects: [...projection.projects, event.project],
        lastSequence: envelope.sequence,
      };
    case "project.archived":
      return {
        ...projection,
        projects: projection.projects.filter((project) => project.projectId !== event.projectId),
        lastSequence: envelope.sequence,
      };
    case "project.archive.requested":
      return { ...projection, lastSequence: envelope.sequence };
    case "project.git.changed":
      return {
        ...projection,
        projects: projection.projects.map((project) =>
          project.projectId === event.projectId ? { ...project, git: event.git } : project,
        ),
        lastSequence: envelope.sequence,
      };
    case "worktree.create.requested":
      return {
        ...projection,
        worktrees: [...projection.worktrees, event.worktree],
        lastSequence: envelope.sequence,
      };
    case "worktree.imported":
      return {
        ...projection,
        worktrees: [...projection.worktrees, event.worktree],
        lastSequence: envelope.sequence,
      };
    case "worktree.status.changed":
      return {
        ...projection,
        worktrees: projection.worktrees.map((worktree) =>
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
    case "worktree.branch.changed":
      return {
        ...projection,
        worktrees: projection.worktrees.map((worktree) =>
          worktree.worktreeId === event.worktreeId ? { ...worktree, branch: event.branch } : worktree,
        ),
        lastSequence: envelope.sequence,
      };
    case "worktree.removed":
    case "worktree.archived":
      return {
        ...projection,
        worktrees: projection.worktrees.filter((worktree) => worktree.worktreeId !== event.worktreeId),
        ...(projection.worktreeSetups
          ? { worktreeSetups: projection.worktreeSetups.filter((setup) => setup.worktreeId !== event.worktreeId) }
          : {}),
        lastSequence: envelope.sequence,
      };
    case "worktree.remove.requested":
    case "worktree.archive.requested":
      return { ...projection, lastSequence: envelope.sequence };
    case "terminal.create.requested":
      return {
        ...projection,
        terminals: [
          ...projection.terminals,
          { ...event.terminal, createdAt: envelope.occurredAt, updatedAt: envelope.occurredAt },
        ],
        lastSequence: envelope.sequence,
      };
    case "terminal.status.changed":
      return {
        ...projection,
        terminals: projection.terminals.map((terminal) =>
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
    case "terminal.write.requested":
    case "terminal.resize.requested":
    case "terminal.stop.requested":
      return { ...projection, lastSequence: envelope.sequence };
    case "thread.start.requested":
      return {
        ...projection,
        threads: [
          ...projection.threads,
          { ...event.thread, createdAt: envelope.occurredAt, updatedAt: envelope.occurredAt },
        ],
        lastSequence: envelope.sequence,
      };
    case "thread.status.changed":
      return {
        ...projection,
        threads: projection.threads.map((thread) => {
          if (thread.threadId !== event.threadId) return thread;
          const { errorMessage: _previousError, ...rest } = thread;
          const keepPreviousError = !event.errorMessage && (event.status === "failed" || event.status === "stopped");
          return {
            ...rest,
            status: event.status,
            updatedAt: envelope.occurredAt,
            ...(event.turnId ? { activeTurnId: event.turnId } : {}),
            ...(event.capabilities ? { capabilities: event.capabilities } : {}),
            ...(event.errorMessage
              ? { errorMessage: event.errorMessage }
              : keepPreviousError && thread.errorMessage
                ? { errorMessage: thread.errorMessage }
                : {}),
          };
        }),
        lastSequence: envelope.sequence,
      };
    case "thread.message.appended":
      return {
        ...projection,
        messages: appendThreadMessage(projection.messages ?? [], event.message),
        threads: touchThread(projection.threads, event.message.threadId, envelope.occurredAt),
        lastSequence: envelope.sequence,
      };
    case "thread.activity.updated":
      return {
        ...projection,
        activities: upsertThreadActivity(projection.activities ?? [], event.activity),
        threads: touchThread(projection.threads, event.activity.threadId, envelope.occurredAt),
        lastSequence: envelope.sequence,
      };
    case "thread.a2a.delivered":
      return {
        ...projection,
        messages: [
          ...(projection.messages ?? []).filter((message) => message.messageId !== event.message.messageId),
          event.message,
        ].slice(-2_000),
        lastSequence: envelope.sequence,
      };
    case "thread.request.requested":
      return {
        ...projection,
        requests: [
          ...(projection.requests ?? []).filter((request) => request.requestId !== event.request.requestId),
          event.request,
        ],
        attention: [
          ...projection.attention.filter((item) => item.id !== `thread-request:${event.request.requestId}`),
          {
            id: `thread-request:${event.request.requestId}`,
            kind: event.request.kind,
            title: event.request.kind === "approval" ? "Agent approval required" : "Agent input required",
          },
        ],
        lastSequence: envelope.sequence,
      };
    case "thread.request.resolved":
      return {
        ...projection,
        requests: (projection.requests ?? []).filter((request) => request.requestId !== event.requestId),
        attention: projection.attention.filter((item) => item.id !== `thread-request:${event.requestId}`),
        lastSequence: envelope.sequence,
      };
    case "thread.respond.requested":
    case "thread.user-input.requested":
      return { ...projection, lastSequence: envelope.sequence };
    case "thread.send.requested": {
      const { permissionMode } = event;
      return {
        ...projection,
        threads: projection.threads.map((thread) => {
          if (thread.threadId !== event.threadId) return thread;
          // Working from the moment a message is accepted, so a second message queues instead of racing it.
          return {
            ...thread,
            ...(thread.status === "idle" ? { status: "working" as const, updatedAt: envelope.occurredAt } : {}),
            ...(permissionMode ? { permissionMode } : {}),
          };
        }),
        lastSequence: envelope.sequence,
      };
    }
    case "thread.queued":
      return {
        ...projection,
        queuedMessages: [
          ...(projection.queuedMessages ?? []).filter((queued) => queued.queueId !== event.message.queueId),
          { ...event.message, queuedAt: envelope.occurredAt },
        ],
        lastSequence: envelope.sequence,
      };
    case "thread.checkpoint.recorded":
      return {
        ...projection,
        checkpoints: appendCheckpoint(projection.checkpoints ?? [], {
          ...event.checkpoint,
          recordedAt: envelope.occurredAt,
        }),
        lastSequence: envelope.sequence,
      };
    case "thread.usage.recorded":
      return {
        ...projection,
        usage: upsertUsageRecord(projection.usage ?? [], { ...event.record, recordedAt: envelope.occurredAt }),
        lastSequence: envelope.sequence,
      };
    case "thread.queue.removed":
      return {
        ...projection,
        queuedMessages: (projection.queuedMessages ?? []).filter(
          (queued) => !(queued.threadId === event.threadId && queued.queueId === event.queueId),
        ),
        lastSequence: envelope.sequence,
      };
    case "thread.queue.prioritized": {
      const queue = projection.queuedMessages ?? [];
      const target = queue.find((queued) => queued.threadId === event.threadId && queued.queueId === event.queueId);
      if (!target) return { ...projection, lastSequence: envelope.sequence };
      return {
        ...projection,
        queuedMessages: [target, ...queue.filter((queued) => queued !== target)],
        lastSequence: envelope.sequence,
      };
    }
    case "thread.interrupt.requested":
    case "thread.stop.requested":
      return { ...projection, lastSequence: envelope.sequence };
    case "session.deleted":
      return { ...removeSession(projection, event.terminalIds, event.threadIds), lastSequence: envelope.sequence };
    case "browser.updated":
      return {
        ...projection,
        browserTabs: [
          ...projection.browserTabs.filter((tab) => tab.browserTabId !== event.tab.browserTabId),
          event.tab,
        ],
        lastSequence: envelope.sequence,
      };
    case "browser.closed":
      return {
        ...projection,
        browserTabs: projection.browserTabs.filter((tab) => tab.browserTabId !== event.browserTabId),
        lastSequence: envelope.sequence,
      };
    case "review.updated":
      return {
        ...projection,
        reviews: [
          ...(projection.reviews ?? []).filter((review) => review.worktreeId !== event.review.worktreeId),
          event.review,
        ],
        lastSequence: envelope.sequence,
      };
    case "review.archived":
      return {
        ...projection,
        reviews: (projection.reviews ?? []).filter((review) => review.worktreeId !== event.worktreeId),
        lastSequence: envelope.sequence,
      };
    case "review.refresh.requested":
    case "review.diff.requested":
    case "review.commit.requested":
    case "review.merge.requested":
    case "review.abortMerge.requested":
      return { ...projection, lastSequence: envelope.sequence };
    case "diagnostics.bundle.requested":
      return { ...projection, lastSequence: envelope.sequence };
    case "diagnostics.bundle.created":
      return {
        ...projection,
        diagnostics: { lastBundle: event.bundle },
        lastSequence: envelope.sequence,
      };
    case "diagnostics.bundle.failed":
      return {
        ...projection,
        diagnostics: { ...(projection.diagnostics ?? {}), lastError: event.message },
        lastSequence: envelope.sequence,
      };
    case "legacy.scan.completed":
      return {
        ...projection,
        legacyImport: {
          status: "ready",
          preview: event.preview,
          batchId: event.preview.batchId,
          importedProjectIds: [],
          importedWorktreeIds: [],
        },
        lastSequence: envelope.sequence,
      };
    case "legacy.scan.requested":
      return {
        ...projection,
        legacyImport: {
          ...(projection.legacyImport ?? { importedProjectIds: [], importedWorktreeIds: [] }),
          status: "scanning",
          batchId: event.batchId,
        },
        lastSequence: envelope.sequence,
      };
    case "legacy.import.requested":
      return {
        ...projection,
        legacyImport: {
          ...(projection.legacyImport ?? { importedProjectIds: [], importedWorktreeIds: [] }),
          status: "importing",
          batchId: event.batchId,
        },
        lastSequence: envelope.sequence,
      };
    case "legacy.import.completed":
      return {
        ...projection,
        legacyImport: {
          ...(projection.legacyImport ?? { importedProjectIds: [], importedWorktreeIds: [] }),
          status: "imported",
          batchId: event.batchId,
          importedProjectIds: event.importedProjectIds,
          importedWorktreeIds: event.importedWorktreeIds,
          error: undefined,
        },
        lastSequence: envelope.sequence,
      };
    case "legacy.rollback.requested":
      return {
        ...projection,
        legacyImport: {
          ...(projection.legacyImport ?? { importedProjectIds: [], importedWorktreeIds: [] }),
          status: "importing",
          batchId: event.batchId,
        },
        lastSequence: envelope.sequence,
      };
    case "legacy.rollback.completed":
      return {
        ...projection,
        legacyImport: {
          ...(projection.legacyImport ?? { importedProjectIds: [], importedWorktreeIds: [] }),
          status: "rolled-back",
          batchId: event.batchId,
          importedProjectIds: [],
          importedWorktreeIds: [],
          error: undefined,
        },
        lastSequence: envelope.sequence,
      };
    case "legacy.operation.failed":
      return {
        ...projection,
        legacyImport: {
          ...(projection.legacyImport ?? { importedProjectIds: [], importedWorktreeIds: [] }),
          status: "failed",
          batchId: event.batchId,
          error: event.message,
        },
        lastSequence: envelope.sequence,
      };
    case "runtime.ready":
    case "runtime.reactor.failed":
      return { ...projection, lastSequence: envelope.sequence };
    case "devserver.detected":
      return {
        ...projection,
        devServers: upsertDevServer(projection.devServers ?? [], {
          ...event.devServer,
          detectedAt: envelope.occurredAt,
        }),
        lastSequence: envelope.sequence,
      };
    case "devserver.stopped":
      return {
        ...projection,
        devServers: removeDevServer(projection.devServers ?? [], event.terminalId, event.port),
        lastSequence: envelope.sequence,
      };
    case "worktree.setup.changed":
      return {
        ...projection,
        worktreeSetups: [
          ...(projection.worktreeSetups ?? []).filter((setup) => setup.worktreeId !== event.setup.worktreeId),
          event.setup,
        ],
        lastSequence: envelope.sequence,
      };
    case "worktree.setup.responded":
      return { ...projection, lastSequence: envelope.sequence };
    case "project.setup.trusted":
      return {
        ...projection,
        setupTrust: [
          ...(projection.setupTrust ?? []).filter(
            (trust) => trust.projectId !== event.projectId || trust.commandsHash !== event.commandsHash,
          ),
          { projectId: event.projectId, commandsHash: event.commandsHash, trustedAt: envelope.occurredAt },
        ],
        lastSequence: envelope.sequence,
      };
  }
}

function touchThread(
  threads: RuntimeProjection["threads"],
  threadId: string,
  occurredAt: string,
): RuntimeProjection["threads"] {
  return threads.map((thread) => (thread.threadId === threadId ? { ...thread, updatedAt: occurredAt } : thread));
}
