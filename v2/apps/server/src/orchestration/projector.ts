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
    case "worktree.create.requested":
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
    case "runtime.ready":
    case "runtime.reactor.failed":
      return { ...projection, lastSequence: envelope.sequence };
  }
}
