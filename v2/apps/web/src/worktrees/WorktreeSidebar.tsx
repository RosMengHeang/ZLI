import {
  deriveSharedProjectContexts,
  type RuntimeProjection,
  type ThreadProjection,
  threadOccupiesWorktree,
  type WorktreeProjection,
} from "@zli-v2/contracts";
import { useState } from "react";

import { isSelectableProvider, worktreeProviderLabel } from "../agent/providers.js";
import { Icon } from "../ui/Icon.js";
import { ProjectContextCard } from "./ProjectContextCard.js";

type Props = {
  projection: RuntimeProjection | undefined;
  activeWorktreeId: string | undefined;
  onSelect(worktree: WorktreeProjection): void;
  onOpenProject(): void;
  onCreateWorktree(): void;
  onOpenHelp?(): void;
  onWorktreeAction?(worktree: WorktreeProjection, action: WorktreeAction): void;
};

export type WorktreeAction = "retry" | "cancel" | "remove";

const inProgress = new Set<WorktreeProjection["status"]>(["queued", "fetching", "creating", "bootstrapping"]);

const statusLabel: Record<WorktreeProjection["status"], string> = {
  queued: "Queued",
  fetching: "Fetching",
  creating: "Creating",
  bootstrapping: "Preparing",
  ready: "Ready",
  failed: "Failed",
  cancelling: "Cancelling",
  cancelled: "Cancelled",
};

type Activity = { label: string; tone: "busy" | "attention" | "failed" };

/** The most urgent live agent state in a worktree, so the row answers "does this need me?". */
function worktreeActivity(threads: readonly ThreadProjection[], worktreeId: string): Activity | undefined {
  const states = new Set(
    threads
      .filter((thread) => thread.worktreeId === worktreeId && isSelectableProvider(thread.provider))
      .map((thread) => thread.status),
  );
  if (states.has("waiting")) return { label: "Needs input", tone: "attention" };
  if (states.has("failed")) return { label: "Agent failed", tone: "failed" };
  if (states.has("working")) return { label: "Working", tone: "busy" };
  if (states.has("starting")) return { label: "Starting", tone: "busy" };
  return undefined;
}

export function WorktreeSidebar({
  projection,
  activeWorktreeId,
  onSelect,
  onOpenProject,
  onCreateWorktree,
  onOpenHelp,
  onWorktreeAction,
}: Props) {
  const [confirmRemoveId, setConfirmRemoveId] = useState<string>();
  const projects = projection?.projects ?? [];
  const worktrees = projection?.worktrees ?? [];
  const threads = projection?.threads ?? [];
  const activeProjectId =
    worktrees.find((worktree) => worktree.worktreeId === activeWorktreeId)?.projectId ?? projects[0]?.projectId;
  const contexts = projection ? (projection.projectContexts ?? deriveSharedProjectContexts(projection)) : [];
  const activeContext = contexts.find((context) => context.projectId === activeProjectId);
  return (
    <aside className="worktree-sidebar" aria-label="Projects and worktrees">
      <div className="sidebar-heading">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            Z
          </span>
          <span className="wordmark">ZLI</span>
        </span>
        <button
          className="icon-button"
          type="button"
          onClick={onOpenProject}
          aria-label="Open project"
          title="Open project"
        >
          <Icon name="folderOpen" size={15} />
        </button>
      </div>
      <button
        className="sidebar-new"
        type="button"
        onClick={onCreateWorktree}
        disabled={projects.length === 0}
        aria-label="Create worktree"
      >
        <Icon name="plus" size={15} />
        New worktree
      </button>
      <div className="sidebar-scroll">
        {projects.length === 0 ? (
          <div className="sidebar-empty">
            <p>Open a Git repository to give agents their own worktrees.</p>
            <button className="secondary-button" type="button" onClick={onOpenProject}>
              <Icon name="folderOpen" size={14} />
              Open a folder
            </button>
          </div>
        ) : (
          projects.map((project) => {
            const projectWorktrees = worktrees.filter((worktree) => worktree.projectId === project.projectId);
            return (
              <section className="project-tree" key={project.projectId}>
                <div className="project-label" title={project.path}>
                  <Icon name={project.projectId === activeProjectId ? "folderOpen" : "folder"} size={14} />
                  <span className="project-name">{project.name}</span>
                  {projectWorktrees.length > 0 ? (
                    <span className="project-count">{projectWorktrees.length}</span>
                  ) : null}
                </div>
                {projectWorktrees.length === 0 ? (
                  <p className="tree-note">No worktrees yet.</p>
                ) : (
                  projectWorktrees.map((worktree) => {
                    const providerLabel = worktreeProviderLabel(threads, worktree.worktreeId, projection?.providers);
                    const live = threads.some(
                      (thread) => thread.worktreeId === worktree.worktreeId && threadOccupiesWorktree(thread.status),
                    );
                    const activity = worktreeActivity(threads, worktree.worktreeId);
                    const changed = projection?.reviews?.find((review) => review.worktreeId === worktree.worktreeId)
                      ?.files.length;
                    const title = [
                      worktree.path,
                      providerLabel,
                      worktree.status === "failed" ? worktree.errorMessage : undefined,
                    ]
                      .filter((part) => part)
                      .join(" · ");
                    return (
                      <div className="worktree-entry" key={worktree.worktreeId}>
                        <button
                          className={`worktree-row${activeWorktreeId === worktree.worktreeId ? " is-active" : ""}`}
                          type="button"
                          onClick={() => onSelect(worktree)}
                          title={title}
                          data-live-agent={live ? "true" : "false"}
                          aria-current={activeWorktreeId === worktree.worktreeId ? "true" : undefined}
                        >
                          <span className={`status-dot status-${worktree.status}`} aria-hidden="true" />
                          <span className="worktree-copy">
                            <span className="worktree-name">{worktree.branch}</span>
                            <span className="worktree-meta">
                              {providerLabel ? <span className="worktree-provider">{providerLabel}</span> : null}
                              <span className="worktree-status">{statusLabel[worktree.status]}</span>
                            </span>
                          </span>
                          {activity ? (
                            <span className={`worktree-activity is-${activity.tone}`}>{activity.label}</span>
                          ) : changed ? (
                            <span className="worktree-changes" title={`${changed} changed files`}>
                              {changed}
                            </span>
                          ) : null}
                        </button>
                        {worktree.status === "failed" && worktree.errorMessage ? (
                          <p className="tree-note is-error" role="status">
                            {worktree.errorMessage}
                          </p>
                        ) : null}
                        {onWorktreeAction &&
                        (activeWorktreeId === worktree.worktreeId || worktree.status === "failed") ? (
                          <div
                            className={`worktree-actions${
                              worktree.status === "failed" || confirmRemoveId === worktree.worktreeId
                                ? " is-persistent"
                                : ""
                            }`}
                          >
                            {worktree.status === "failed" ? (
                              <button
                                className="quiet-button"
                                type="button"
                                onClick={() => onWorktreeAction(worktree, "retry")}
                              >
                                <Icon name="reload" size={12} />
                                Retry
                              </button>
                            ) : null}
                            {inProgress.has(worktree.status) ? (
                              <button
                                className="quiet-button"
                                type="button"
                                onClick={() => onWorktreeAction(worktree, "cancel")}
                              >
                                <Icon name="x" size={12} />
                                Cancel
                              </button>
                            ) : confirmRemoveId === worktree.worktreeId ? (
                              <>
                                <button
                                  className="quiet-button is-danger"
                                  type="button"
                                  onClick={() => {
                                    setConfirmRemoveId(undefined);
                                    onWorktreeAction(worktree, "remove");
                                  }}
                                >
                                  Delete checkout
                                </button>
                                <button
                                  className="quiet-button"
                                  type="button"
                                  onClick={() => setConfirmRemoveId(undefined)}
                                >
                                  Keep
                                </button>
                              </>
                            ) : (
                              <button
                                className="quiet-button"
                                type="button"
                                disabled={live}
                                title={
                                  live
                                    ? "Stop the agent in this worktree first."
                                    : "Delete this checkout and its branch"
                                }
                                onClick={() => setConfirmRemoveId(worktree.worktreeId)}
                              >
                                <Icon name="trash" size={12} />
                                Remove
                              </button>
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </section>
            );
          })
        )}
      </div>
      {activeContext ? <ProjectContextCard context={activeContext} providers={projection?.providers} /> : null}
      <div className="sidebar-footer">
        <span className={`connection-dot${projection ? " is-connected" : ""}`} aria-hidden="true" />
        <span>{projection ? "Local runtime" : "Waiting for runtime"}</span>
        {onOpenHelp ? (
          <button
            className="icon-button sidebar-help"
            type="button"
            onClick={onOpenHelp}
            aria-label="Help"
            title="Help and diagnostics"
          >
            <Icon name="help" size={15} />
          </button>
        ) : null}
      </div>
    </aside>
  );
}
