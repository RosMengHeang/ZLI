import type { ProviderDiscovery, SharedProjectContext, ThreadProjection, WorktreeProjection } from "@zli-v2/contracts";

import { providerDisplayName } from "../agent/providers.js";

const worktreeStatusLabel: Record<WorktreeProjection["status"], string> = {
  queued: "Queued",
  fetching: "Fetching",
  creating: "Creating",
  bootstrapping: "Preparing",
  ready: "Ready",
  failed: "Failed",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
};

const threadStatusLabel: Record<ThreadProjection["status"], string> = {
  starting: "Starting",
  idle: "Idle",
  working: "Working",
  waiting: "Waiting",
  stopped: "Stopped",
  failed: "Failed",
};

export function ProjectContextCard({
  context,
  providers,
}: {
  context: SharedProjectContext;
  providers: readonly ProviderDiscovery[] | undefined;
}) {
  return (
    <section className="project-context" aria-label="Project context" aria-live="polite">
      <p className="eyebrow">Project context</p>
      <p className="project-context-root" title={context.repoRoot}>
        {context.repoRoot}
      </p>
      <p className="eyebrow">Worktrees</p>
      {context.worktrees.length === 0 ? (
        <p className="tree-note">No worktrees in this project.</p>
      ) : (
        <ul className="project-context-list">
          {context.worktrees.map((worktree) => (
            <li className="project-context-row" key={worktree.worktreeId}>
              <span className={`status-dot status-${worktree.status}`} aria-hidden="true" />
              <span className="project-context-copy">
                <span className="project-context-title">{worktree.branch}</span>
                <span className="project-context-id" title={worktree.path}>
                  {worktree.path}
                </span>
              </span>
              <span className="project-context-status">{worktreeStatusLabel[worktree.status]}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="eyebrow">Threads</p>
      {context.threads.length === 0 ? (
        <p className="tree-note">No threads in this project.</p>
      ) : (
        <ul className="project-context-list">
          {context.threads.map((thread) => (
            <li className="project-context-row" key={thread.threadId}>
              <span className={`status-dot status-${thread.status}`} aria-hidden="true" />
              <span className="project-context-copy">
                <span className="project-context-title">{providerDisplayName(thread.provider, providers)}</span>
                <span className="project-context-id" title={thread.threadId}>
                  {thread.threadId}
                </span>
              </span>
              <span className="project-context-status">{threadStatusLabel[thread.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
