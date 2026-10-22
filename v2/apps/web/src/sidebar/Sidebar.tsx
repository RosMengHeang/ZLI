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
import { setupBadge, worktreeSetup } from "../setup/setup.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { Kbd } from "../ui/Kbd.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { ariaShortcut } from "../ui/shortcuts.js";
import "./sidebar.css";

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
  onReviewSetup(worktree: WorktreeProjection): void;
  onShowSetupOutput(worktree: WorktreeProjection): void;
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
  onReviewSetup,
  onShowSetupOutput,
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
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            Z
          </span>
          <span className="wordmark">ZLI</span>
        </span>
        <span className="sidebar-top-actions">
          <IconButton label="Hide sidebar" icon="panelLeft" shortcut="Mod+B" onClick={onHideSidebar} />
        </span>
      </div>
      <div className="sidebar-primary">
        <button
          className="btn btn-secondary sidebar-new-agent"
          type="button"
          onClick={() => onNewAgent()}
          disabled={projects.length === 0}
          aria-keyshortcuts={ariaShortcut("Mod+N")}
        >
          <Icon name="plus" size={14} />
          <span>New agent</span>
          <Kbd shortcut="Mod+N" />
        </button>
        <button className="btn btn-ghost sidebar-add-project" type="button" onClick={onOpenProject}>
          <Icon name="folderPlus" size={14} />
          <span>Add project</span>
        </button>
      </div>
      <div className="sidebar-scroll">
        {projects.length === 0 ? (
          <div className="sidebar-empty">
            <p>
              Add a Git repository to start. Each agent gets its own terminal, and its own worktree if you want one.
            </p>
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
              <section className="sidebar-project" key={project.projectId} aria-label={project.name}>
                <div className="project-label" title={project.path}>
                  <Icon name="folder" size={14} />
                  <span className="project-name">{project.name}</span>
                  <IconButton
                    className="project-action"
                    label={`New agent in ${project.name}`}
                    tooltip="New agent here"
                    icon="plus"
                    size="xs"
                    iconSize={13}
                    onClick={() => onNewAgent(project)}
                  />
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
                      const quiet = session.status === "ready" || session.status === "ended";
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
                                {background ? <span className="session-background">Background</span> : null}
                              </span>
                            </span>
                            <span className="session-side">
                              {quiet ? (
                                <span className="session-time">{relativeTime(session.updatedAt, now)}</span>
                              ) : (
                                <span className={`session-status is-${session.status}`}>
                                  <span className="dot" aria-hidden="true" />
                                  {status}
                                </span>
                              )}
                            </span>
                          </button>
                          <span className="session-actions">
                            {stoppable ? (
                              <IconButton
                                label={`Stop ${title}`}
                                tooltip="Stop agent"
                                icon="square"
                                size="xs"
                                iconSize={10}
                                onClick={() => onStopSession(session)}
                              />
                            ) : null}
                            <IconButton
                              label={`Delete ${title}`}
                              tooltip="Delete agent"
                              icon="trash"
                              size="xs"
                              iconSize={12}
                              onClick={() => onDeleteSession(session)}
                            />
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
                  <IconButton
                    label="Create worktree"
                    icon="plus"
                    size="xs"
                    iconSize={13}
                    onClick={() => onCreateWorktree(project)}
                  />
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
                        const setup = worktreeSetup(projection, worktree.worktreeId);
                        const badge = setupBadge(worktree, setup);
                        const setupProblem =
                          badge?.tone === "danger" ? (setup?.errorMessage ?? "Setup failed.") : undefined;
                        const needsApproval = badge?.tone === "attention";
                        const dotClass =
                          badge?.tone === "attention"
                            ? "status-waiting"
                            : badge?.tone === "danger"
                              ? "status-failed"
                              : `status-${worktree.status}`;
                        return (
                          <li className="worktree-entry" key={worktree.worktreeId}>
                            <button
                              className={`worktree-row${activeWorktreeId === worktree.worktreeId ? " is-active" : ""}`}
                              type="button"
                              onClick={() => onSelectWorktree(worktree)}
                              title={[
                                worktree.path,
                                worktree.status === "failed" ? worktree.errorMessage : undefined,
                                setupProblem,
                              ]
                                .filter(Boolean)
                                .join("\n")}
                              data-live-agent={live ? "true" : "false"}
                              aria-current={activeWorktreeId === worktree.worktreeId ? "true" : undefined}
                            >
                              <span className={`status-dot ${dotClass}`} aria-hidden="true" />
                              <span className="worktree-name">{worktree.branch}</span>
                              {checkout ? <span className="worktree-kind">checkout</span> : null}
                              <span
                                className={`worktree-status${
                                  badge
                                    ? badge.tone === "danger"
                                      ? " is-danger"
                                      : badge.tone === "attention"
                                        ? " is-attention"
                                        : ""
                                    : worktree.status === "ready"
                                      ? " is-ready"
                                      : ""
                                }`}
                              >
                                {badge?.label ?? worktreeStatusLabel[worktree.status]}
                              </span>
                              {changed ? (
                                <span className="count" title={`${changed} changed files`}>
                                  {changed}
                                </span>
                              ) : null}
                            </button>
                            {worktree.status === "failed" && worktree.errorMessage ? (
                              <p className="sidebar-note is-error" role="status">
                                {worktree.errorMessage}
                              </p>
                            ) : setupProblem ? (
                              <p className="sidebar-note is-error" role="status">
                                {setupProblem}
                              </p>
                            ) : null}
                            <div
                              className={`worktree-actions${
                                worktree.status === "failed" || confirming || needsApproval || setupProblem
                                  ? " is-persistent"
                                  : ""
                              }`}
                            >
                              {needsApproval ? (
                                <Button variant="ghost" size="xs" icon="check" onClick={() => onReviewSetup(worktree)}>
                                  Review setup
                                </Button>
                              ) : null}
                              {setup?.terminalId ? (
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  icon="terminal"
                                  onClick={() => onShowSetupOutput(worktree)}
                                >
                                  Setup output
                                </Button>
                              ) : null}
                              {worktree.status === "failed" ? (
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  icon="reload"
                                  onClick={() => onWorktreeAction(worktree, "retry")}
                                >
                                  Retry
                                </Button>
                              ) : null}
                              {inProgress.has(worktree.status) ? (
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  icon="x"
                                  onClick={() => onWorktreeAction(worktree, "cancel")}
                                >
                                  Cancel
                                </Button>
                              ) : confirming ? (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="xs"
                                    className="is-danger"
                                    onClick={() => {
                                      setConfirmRemoveId(undefined);
                                      onWorktreeAction(worktree, "remove");
                                    }}
                                  >
                                    {checkout ? "Forget checkout" : "Delete checkout"}
                                  </Button>
                                  <Button variant="ghost" size="xs" onClick={() => setConfirmRemoveId(undefined)}>
                                    Keep
                                  </Button>
                                </>
                              ) : (
                                <IconButton
                                  label="Remove worktree"
                                  tooltip={
                                    live
                                      ? "Stop the agents in this worktree first"
                                      : checkout
                                        ? "Remove from ZLI. Files stay on disk."
                                        : "Delete this worktree and its folder"
                                  }
                                  icon="trash"
                                  size="xs"
                                  iconSize={12}
                                  disabled={live}
                                  onClick={() => setConfirmRemoveId(worktree.worktreeId)}
                                />
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
        <IconButton
          className="sidebar-help"
          label="Help"
          tooltip="Help and diagnostics"
          icon="help"
          onClick={onOpenHelp}
        />
      </div>
    </aside>
  );
}
