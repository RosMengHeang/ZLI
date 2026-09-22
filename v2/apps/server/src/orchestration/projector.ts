import {
  RuntimeEvent,
  RuntimeEventEnvelope,
  type EnvironmentDescriptor,
  type RuntimeProjection,
} from "@zli-v2/contracts";

export function createEmptyProjection(environment: EnvironmentDescriptor): RuntimeProjection {
  return {
    environment,
    projects: [],
    worktrees: [],
    threads: [],
    terminals: [],
    browserTabs: [],
    legacyImport: { status: "idle", importedProjectIds: [], importedWorktreeIds: [] },
    attention: [],
    lastSequence: 0,
  };
}

export function projectEvent(
  projection: RuntimeProjection,
  envelope: RuntimeEventEnvelope,
): RuntimeProjection {
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
              }
            : worktree,
        ),
        lastSequence: envelope.sequence,
      };
    case "worktree.removed":
    case "worktree.archived":
      return {
        ...projection,
        worktrees: projection.worktrees.filter((worktree) => worktree.worktreeId !== event.worktreeId),
        lastSequence: envelope.sequence,
      };
    case "worktree.remove.requested":
    case "worktree.archive.requested":
      return { ...projection, lastSequence: envelope.sequence };
    case "terminal.create.requested":
      return {
        ...projection,
        terminals: [...projection.terminals, event.terminal],
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
        threads: [...projection.threads, event.thread],
        lastSequence: envelope.sequence,
      };
    case "thread.status.changed":
      return {
        ...projection,
        threads: projection.threads.map((thread) =>
          thread.threadId === event.threadId
            ? {
                ...thread,
                status: event.status,
                ...(event.turnId ? { activeTurnId: event.turnId } : {}),
                ...(event.capabilities ? { capabilities: event.capabilities } : {}),
                ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
              }
            : thread,
        ),
        lastSequence: envelope.sequence,
      };
    case "thread.message.appended":
      return {
        ...projection,
        messages: [...(projection.messages ?? []), event.message].slice(-2_000),
        lastSequence: envelope.sequence,
      };
    case "thread.request.requested":
      return {
        ...projection,
        requests: [...(projection.requests ?? []).filter((request) => request.requestId !== event.request.requestId), event.request],
        attention: [
          ...projection.attention.filter((item) => item.id !== "thread-request:" + event.request.requestId),
          {
            id: "thread-request:" + event.request.requestId,
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
        attention: projection.attention.filter((item) => item.id !== "thread-request:" + event.requestId),
        lastSequence: envelope.sequence,
      };
    case "thread.respond.requested":
    case "thread.user-input.requested":
      return { ...projection, lastSequence: envelope.sequence };
    case "thread.send.requested":
    case "thread.interrupt.requested":
    case "thread.stop.requested":
      return { ...projection, lastSequence: envelope.sequence };
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
        reviews: [...(projection.reviews ?? []).filter((review) => review.worktreeId !== event.review.worktreeId), event.review],
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
  }
}
