import type { ProjectProjection, RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { threadOccupiesWorktree } from "@zli-v2/contracts";
import { useEffect, useState } from "react";

import { providerDisplayName } from "../agent/providers.js";
import {
  type AgentSession,
  relativeTime,
  sessionStatusLabel,
  sessionStopCommands,
  sessionTitle,
} from "../sessions/sessions.js";
import { Icon } from "../ui/Icon.js";
import { ProviderMark } from "../ui/ProviderMark.js";

export type WorktreeAction = "retry" | "cancel" | "remove";

const inProgress = new Set<WorktreeProjection["status"]>(["queued", "fetching", "creating", "bootstrapping"]);

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

type Props = {
  projection: RuntimeProjection | undefined;
  sessions: readonly AgentSession[];
  activeSessionId: string | undefined;
  /** Running sessions without a tile on the board. */
  backgroundSessionIds: ReadonlySet<string>;
  activeWorktreeId: string | undefined;
  onSelectSession(session: AgentSession): void;
  onStopSession(session: AgentSession): void;
  onDeleteSession(session: AgentSession): void;
  onSelectWorktree(worktree: WorktreeProjection): void;
  onNewAgent(project?: ProjectProjection): void;
  onOpenProject(): void;
  onCreateWorktree(project?: ProjectProjection): void;
  onWorktreeAction(worktree: WorktreeProjection, action: WorktreeAction): void;
  onOpenHelp(): void;
  onHideSidebar(): void;
};

export function Sidebar({
  projection,
  sessions,
  activeSessionId,
  backgroundSessionIds,
  activeWorktreeId,
  onSelectSession,
  onStopSession,
  onDeleteSession,
  onSelectWorktree,
  onNewAgent,
  onOpenProject,
  onCreateWorktree,
  onWorktreeAction,
  onOpenHelp,
  onHideSidebar,
}: Props) {
  const [confirmRemoveId, setConfirmRemoveId] = useState<string>();
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<string[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const projects = projection?.projects ?? [];
  const worktrees = projection?.worktrees ?? [];
  const threads = projection?.threads ?? [];

  // Relative times only need minute precision.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <aside className="sidebar" aria-label="Projects and agents">
      <div className="sidebar-top">
        <button
          className="icon-button"
          type="button"
          onClick={onHideSidebar}
          aria-label="Hide sidebar"
          title="Hide sidebar (Ctrl B)"
        >
          <Icon name="panelLeft" size={15} />
        </button>
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            Z
          </span>
          <span className="wordmark">ZLI</span>
        </span>
        <button
          className="icon-button sidebar-top-end"
          type="button"
          onClick={onOpenProject}
          aria-label="Open project"
          title="Open project"
        >
          <Icon name="folderOpen" size={15} />
        </button>
      </div>
      <button className="sidebar-new-agent" type="button" onClick={() => onNewAgent()} disabled={projects.length === 0}>
        <Icon name="plus" size={14} />
        <span>New agent</span>
        <kbd>Ctrl N</kbd>
      </button>
      <div className="sidebar-scroll">
        {projects.length === 0 ? (
          <div className="sidebar-empty">
            <p>Open a Git repository. Each agent gets its own terminal, and its own worktree if you want one.</p>
            <button className="secondary-button" type="button" onClick={onOpenProject}>
              <Icon name="folderOpen" size={14} />
              Open a folder
            </button>
          </div>
        ) : (
          projects.map((project) => {
            const projectWorktrees = worktrees.filter((worktree) => worktree.projectId === project.projectId);
            const worktreeIds = new Set<string>(projectWorktrees.map((worktree) => worktree.worktreeId));
            const projectSessions = sessions
              .filter((session) => worktreeIds.has(session.worktreeId))
              .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
            const worktreesOpen = !collapsedWorktrees.includes(project.projectId);
            return (
              <section className="sidebar-project" key={project.projectId}>
                <div className="project-label" title={project.path}>
                  <Icon name="folder" size={14} />
                  <span className="project-name">{project.name}</span>
                  <button
                    className="icon-button is-small project-action"
                    type="button"
                    aria-label={`New agent in ${project.name}`}
                    title="New agent"
                    onClick={() => onNewAgent(project)}
                  >
                    <Icon name="plus" size={13} />
                  </button>
                </div>
                {projectSessions.length === 0 ? (
                  <p className="sidebar-note">No agents yet.</p>
                ) : (
                  <ul className="session-list">
                    {projectSessions.map((session) => {
                      const worktree = projectWorktrees.find((entry) => entry.worktreeId === session.worktreeId);
                      const title = sessionTitle(session, projection?.messages, projection?.providers);
                      const provider = providerDisplayName(session.provider, projection?.providers);
                      const status = sessionStatusLabel[session.status];
                      const active = session.sessionId === activeSessionId;
                      const background = backgroundSessionIds.has(session.sessionId);
                      const stoppable = sessionStopCommands(session).length > 0;
                      return (
                        <li className="session-entry" key={session.sessionId}>
                          <button
                            className={`session-row${active ? " is-active" : ""}`}
                            type="button"
                            aria-label={`${title}, ${provider}, ${status}${background ? ", in the background" : ""}`}
                            aria-current={active ? "true" : undefined}
                            onClick={() => onSelectSession(session)}
                            title={worktree ? `${title}\n${worktree.branch} · ${worktree.path}` : title}
                          >
                            <ProviderMark provider={session.provider} size={14} />
                            <span className="session-copy">
                              <span className="session-title">{title}</span>
                              <span className="session-meta">
                                <span className="session-branch">{worktree?.branch ?? "worktree"}</span>
                                <span className="session-provider">{provider}</span>
                                {background ? <span className="session-background">background</span> : null}
                              </span>
                            </span>
                            <span className="session-side">
                              <span className={`session-status is-${session.status}`}>
                                {session.status === "ready" || session.status === "ended" ? (
                                  <span className={`status-dot status-session-${session.status}`} aria-hidden="true" />
                                ) : (
                                  status
                                )}
                              </span>
                              <span className="session-time">{relativeTime(session.updatedAt, now)}</span>
                            </span>
                          </button>
                          <span className="session-actions">
                            {stoppable ? (
                              <button
                                className="icon-button is-small"
                                type="button"
                                aria-label={`Stop ${title}`}
                                title="Stop agent"
                                onClick={() => onStopSession(session)}
                              >
                                <Icon name="square" size={11} />
                              </button>
                            ) : null}
                            <button
                              className="icon-button is-small"
                              type="button"
                              aria-label={`Delete ${title}`}
                              title="Delete agent"
                              onClick={() => onDeleteSession(session)}
                            >
                              <Icon name="trash" size={12} />
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="worktree-heading">
                  <button
                    className="worktree-toggle"
                    type="button"
                    aria-expanded={worktreesOpen}
                    onClick={() =>
                      setCollapsedWorktrees((current) =>
                        worktreesOpen
                          ? [...current, project.projectId]
                          : current.filter((projectId) => projectId !== project.projectId),
                      )
                    }
                  >
                    <Icon name="chevronRight" size={11} className="worktree-toggle-chevron" />
                    Worktrees
                    <span className="worktree-count">{projectWorktrees.length}</span>
                  </button>
                  <button
                    className="icon-button is-small"
                    type="button"
                    aria-label="Create worktree"
                    title="Create worktree"
                    onClick={() => onCreateWorktree(project)}
                  >
                    <Icon name="plus" size={13} />
                  </button>
                </div>
                {worktreesOpen ? (
                  projectWorktrees.length === 0 ? (
                    <p className="sidebar-note">No worktrees yet.</p>
                  ) : (
                    <ul className="worktree-list">
                      {projectWorktrees.map((worktree) => {
                        const live = threads.some(
                          (thread) =>
                            thread.worktreeId === worktree.worktreeId && threadOccupiesWorktree(thread.status),
                        );
                        const changed = projection?.reviews?.find((review) => review.worktreeId === worktree.worktreeId)
                          ?.files.length;
                        const checkout = worktree.kind === "checkout";
                        const confirming = confirmRemoveId === worktree.worktreeId;
                        return (
                          <li className="worktree-entry" key={worktree.worktreeId}>
                            <button
                              className={`worktree-row${activeWorktreeId === worktree.worktreeId ? " is-active" : ""}`}
                              type="button"
                              onClick={() => onSelectWorktree(worktree)}
                              title={[worktree.path, worktree.status === "failed" ? worktree.errorMessage : undefined]
                                .filter(Boolean)
                                .join("\n")}
                              data-live-agent={live ? "true" : "false"}
                              aria-current={activeWorktreeId === worktree.worktreeId ? "true" : undefined}
                            >
                              <span className={`status-dot status-${worktree.status}`} aria-hidden="true" />
                              <span className="worktree-name">{worktree.branch}</span>
                              {checkout ? <span className="worktree-kind">checkout</span> : null}
                              <span className="worktree-status">{worktreeStatusLabel[worktree.status]}</span>
                              {changed ? (
                                <span className="worktree-changes" title={`${changed} changed files`}>
                                  {changed}
                                </span>
                              ) : null}
                            </button>
                            {worktree.status === "failed" && worktree.errorMessage ? (
                              <p className="sidebar-note is-error" role="status">
                                {worktree.errorMessage}
                              </p>
                            ) : null}
                            <div
                              className={`worktree-actions${
                                worktree.status === "failed" || confirming ? " is-persistent" : ""
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
                              ) : confirming ? (
                                <>
                                  <button
                                    className="quiet-button is-danger"
                                    type="button"
                                    onClick={() => {
                                      setConfirmRemoveId(undefined);
                                      onWorktreeAction(worktree, "remove");
                                    }}
                                  >
                                    {checkout ? "Forget checkout" : "Delete checkout"}
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
                                  aria-label="Remove worktree"
                                  title={
                                    live
                                      ? "Stop the agents in this worktree first."
                                      : checkout
                                        ? "Remove from ZLI. Files stay on disk."
                                        : "Delete this worktree and its folder"
                                  }
                                  onClick={() => setConfirmRemoveId(worktree.worktreeId)}
                                >
                                  <Icon name="trash" size={12} />
                                </button>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )
                ) : null}
              </section>
            );
          })
        )}
      </div>
      <div className="sidebar-footer">
        <span className={`connection-dot${projection ? " is-connected" : ""}`} aria-hidden="true" />
        <span>{projection ? "Local runtime" : "Waiting for runtime"}</span>
        <button
          className="icon-button sidebar-help"
          type="button"
          onClick={onOpenHelp}
          aria-label="Help"
          title="Help and diagnostics"
        >
          <Icon name="help" size={15} />
        </button>
      </div>
    </aside>
  );
}
