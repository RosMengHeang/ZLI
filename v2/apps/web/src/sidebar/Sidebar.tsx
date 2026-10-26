import type { Account, ProjectProjection, RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { threadOccupiesWorktree } from "@zli-v2/contracts";
import { useEffect, useState } from "react";

import { accountLabel, sessionAccountId } from "../accounts/accounts.js";
import { providerDisplayName } from "../agent/providers.js";
import { trackDescription, trackText } from "../review/branches.js";
import { type PullRequestEntry, usePullRequestEntries } from "../review/pullRequestStore.js";
import type { RunGroup, RunState } from "../sessions/bestOf.js";
import { runStateLabel } from "../sessions/bestOf.js";
import {
  type AgentSession,
  relativeTime,
  sessionStatusLabel,
  sessionStopCommands,
  sessionTitle,
} from "../sessions/sessions.js";
import { groupFinished } from "../sessions/useRunStates.js";
import { setupBadge, worktreeSetup } from "../setup/setup.js";
import { useShortcut } from "../shell/keybindings.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { Kbd } from "../ui/Kbd.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { ariaShortcut } from "../ui/shortcuts.js";
import { ZliLogo } from "../ui/ZliLogo.js";
import { usageGroupKey } from "../usage/usage.js";
import { SidebarUsageStrip } from "./SidebarUsageStrip.js";
import "./sidebar.css";

export type WorktreeAction = "retry" | "cancel" | "remove";

const inProgress = new Set<WorktreeProjection["status"]>(["queued", "fetching", "creating", "bootstrapping"]);

/** A worktree's open or merged pull request, with a CI dot when the branch has checks. */
function pullRequestBadge(
  entry: PullRequestEntry | undefined,
): { label: string; tone: string; title: string } | undefined {
  const pullRequest = entry?.status?.pullRequest;
  if (!pullRequest || pullRequest.state === "CLOSED") return undefined;
  const state = pullRequest.state === "MERGED" ? "Merged" : pullRequest.isDraft ? "Draft" : "Open";
  const checks = pullRequest.checks ?? [];
  const failed = checks.filter((check) => check.state === "failed").length;
  const pending = checks.filter((check) => check.state === "pending").length;
  const tone = pullRequest.state === "MERGED" ? "info" : failed > 0 ? "danger" : pending > 0 ? "warning" : "success";
  const detail =
    checks.length === 0
      ? state
      : failed > 0
        ? `${state}, ${failed} check${failed === 1 ? "" : "s"} failed`
        : pending > 0
          ? `${state}, checks running`
          : `${state}, checks passed`;
  return { label: `#${pullRequest.number}`, tone, title: `Pull request ${detail.toLowerCase()}` };
}

/** Commits to push and pull, from the status lookup the sidebar already polls for pull requests. */
function WorktreeTrack({ entry, branch }: { entry: PullRequestEntry | undefined; branch: string }) {
  const upstream = entry?.status?.branch === branch ? entry.status.upstream : undefined;
  const text = upstream?.gone ? "" : trackText(upstream);
  if (!text) return null;
  return (
    <span className="worktree-track" title={trackDescription(upstream)}>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{trackDescription(upstream)}</span>
    </span>
  );
}

function WorktreePrBadge({ entry }: { entry: PullRequestEntry | undefined }) {
  const badge = pullRequestBadge(entry);
  if (!badge) return null;
  return (
    <span className={`worktree-pr is-${badge.tone}`} title={badge.title}>
      <Icon name="pullRequest" size={10} />
      {badge.label}
    </span>
  );
}

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
  onOpenSettings(): void;
  onOpenUsage(): void;
  onHideSidebar(): void;
  /** Best-of runs still being compared; their sessions list under the chat they came from. */
  runGroups?: readonly RunGroup[];
  runStates?: ReadonlyMap<string, RunState>;
  onCompareRuns?(group: RunGroup): void;
  /** Undefined until the saved accounts have loaded. */
  accounts?: readonly Account[] | undefined;
};

const noGroups: readonly RunGroup[] = [];
const noStates: ReadonlyMap<string, RunState> = new Map();

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
  onOpenSettings,
  onOpenUsage,
  onHideSidebar,
  runGroups = noGroups,
  runStates = noStates,
  onCompareRuns = () => undefined,
  accounts,
}: Props) {
  const newAgentShortcut = useShortcut("newAgent");
  const sidebarShortcut = useShortcut("toggleSidebar");
  const settingsShortcut = useShortcut("settings");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string>();
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<string[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const prEntries = usePullRequestEntries();
  const projects = projection?.projects ?? [];
  const worktrees = projection?.worktrees ?? [];
  const threads = projection?.threads ?? [];
  const activeSession = sessions.find((session) => session.sessionId === activeSessionId);
  const runIds = new Set(runGroups.flatMap((group) => group.sessionIds));
  const groupsBySource = new Map<string, RunGroup[]>();
  for (const group of runGroups) {
    groupsBySource.set(group.sourceSessionId, [...(groupsBySource.get(group.sourceSessionId) ?? []), group]);
  }

  // Relative times only need minute precision.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const renderGroup = (group: RunGroup, projectWorktrees: readonly WorktreeProjection[]) => {
    const finished = groupFinished(group, runStates);
    const count = group.sessionIds.length;
    const doneCount = group.sessionIds.filter((sessionId) => runStates.get(sessionId) !== "running").length;
    return (
      <fieldset className="run-group" aria-label={`Best of ${count} from ${group.label}`}>
        <div className="run-group-head">
          <Icon name="split" size={11} />
          <span className="run-group-title" title={group.prompt}>
            Best of {count}
          </span>
          {finished ? (
            <Button variant="ghost" size="xs" className="run-group-compare" onClick={() => onCompareRuns(group)}>
              Compare
            </Button>
          ) : (
            <span className="run-group-progress">
              {doneCount} of {count} done
            </span>
          )}
        </div>
        <ul className="session-list run-list">
          {group.sessionIds.map((sessionId, index) => {
            const run = sessions.find((session) => session.sessionId === sessionId);
            return run ? renderSession(run, projectWorktrees, undefined, index + 1) : null;
          })}
        </ul>
      </fieldset>
    );
  };

  const renderSession = (
    session: AgentSession,
    projectWorktrees: readonly WorktreeProjection[],
    groups: readonly RunGroup[] | undefined,
    runIndex?: number,
  ) => {
    const worktree = projectWorktrees.find((entry) => entry.worktreeId === session.worktreeId);
    const title = sessionTitle(session, projection?.messages, projection?.providers);
    const account = accountLabel(accounts, sessionAccountId(session));
    const provider = providerDisplayName(session.provider, projection?.providers);
    const providerName = account ? `${provider} (${account})` : provider;
    const runStatus = runIndex === undefined ? undefined : (runStates.get(session.sessionId) ?? "running");
    const status = runStatus ? runStateLabel[runStatus] : sessionStatusLabel[session.status];
    const active = session.sessionId === activeSessionId;
    const background = backgroundSessionIds.has(session.sessionId);
    const stoppable = sessionStopCommands(session).length > 0;
    const quiet = runStatus === undefined && (session.status === "ready" || session.status === "ended");
    const name = runIndex === undefined ? title : `Run ${runIndex}`;
    return (
      <li className={`session-entry${runIndex === undefined ? "" : " is-run"}`} key={session.sessionId}>
        <button
          className={`session-row${active ? " is-active" : ""}`}
          type="button"
          aria-label={`${name}, ${providerName}, ${status}${background ? ", in the background" : ""}`}
          aria-current={active ? "true" : undefined}
          onClick={() => onSelectSession(session)}
          title={`${worktree ? `${title}\n${worktree.branch} · ${worktree.path}` : title}${account ? `\nAccount: ${account}` : ""}`}
        >
          <ProviderMark provider={session.provider} size={14} />
          {runIndex === undefined ? (
            <span className="session-title">{title}</span>
          ) : (
            <>
              <span className="run-badge">Run {runIndex}</span>
              <span className="session-title">{worktree?.branch ?? provider}</span>
            </>
          )}
          <span className="session-side">
            {quiet ? (
              background ? (
                <span className="session-background">Background</span>
              ) : (
                <span className="session-time">{relativeTime(session.updatedAt, now)}</span>
              )
            ) : (
              <span
                className={`session-status is-${runStatus === "running" ? "working" : (runStatus ?? session.status)}`}
              >
                <span className="dot" aria-hidden="true" />
                {status}
              </span>
            )}
          </span>
        </button>
        <span className="session-actions">
          {stoppable ? (
            <IconButton
              label={`Stop ${name}`}
              tooltip="Stop agent"
              icon="square"
              tone="danger"
              size="xs"
              iconSize={10}
              onClick={() => onStopSession(session)}
            />
          ) : null}
          <IconButton
            label={`Delete ${name}`}
            tooltip="Delete agent"
            icon="trash"
            size="xs"
            iconSize={12}
            onClick={() => onDeleteSession(session)}
          />
        </span>
        {groups?.map((group) => (
          <div key={group.groupId}>{renderGroup(group, projectWorktrees)}</div>
        ))}
      </li>
    );
  };

  return (
    <aside className="sidebar" aria-label="Projects and agents">
      <div className="sidebar-top">
        <span className="brand">
          <ZliLogo className="brand-mark" />
          <span className="wordmark">ZLI</span>
        </span>
        <span className="sidebar-top-actions">
          <IconButton label="Hide sidebar" icon="panelLeft" shortcut={sidebarShortcut} onClick={onHideSidebar} />
        </span>
      </div>
      <div className="sidebar-primary">
        <button className="btn btn-ghost sidebar-add-project" type="button" onClick={onOpenProject}>
          <Icon name="folderPlus" size={15} />
          <span>Add project</span>
        </button>
        <button
          className="btn btn-ghost sidebar-new-agent"
          type="button"
          onClick={() => onNewAgent()}
          disabled={projects.length === 0}
          aria-keyshortcuts={ariaShortcut(newAgentShortcut)}
        >
          <Icon name="squarePen" size={15} />
          <span>New agent</span>
          <Kbd shortcut={newAgentShortcut} />
        </button>
      </div>
      <div className="sidebar-scroll">
        {projects.length > 0 ? <h2 className="sidebar-heading">Projects</h2> : null}
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
                      if (runIds.has(session.sessionId)) return null;
                      return renderSession(session, projectWorktrees, groupsBySource.get(session.sessionId));
                    })}
                    {runGroups
                      .filter(
                        (group) =>
                          !projectSessions.some((session) => session.sessionId === group.sourceSessionId) &&
                          projectSessions.some((session) => group.sessionIds.includes(session.sessionId)),
                      )
                      .map((group) => (
                        <li className="session-entry is-orphan-group" key={group.groupId}>
                          {renderGroup(group, projectWorktrees)}
                        </li>
                      ))}
                  </ul>
                )}{" "}
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
                    {...(project.git === false
                      ? { tooltip: "Worktrees need Git. This folder is not a Git repository." }
                      : {})}
                    icon="plus"
                    size="xs"
                    iconSize={13}
                    disabled={project.git === false}
                    onClick={() => onCreateWorktree(project)}
                  />
                </div>
                {worktreesOpen ? (
                  projectWorktrees.length === 0 ? null : (
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
                              <WorktreeTrack entry={prEntries.get(worktree.worktreeId)} branch={worktree.branch} />
                              {checkout ? <span className="worktree-kind">checkout</span> : null}
                              <WorktreePrBadge entry={prEntries.get(worktree.worktreeId)} />
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
      <div className="sidebar-bottom">
        <SidebarUsageStrip
          providers={projection?.providers}
          accounts={accounts}
          now={now}
          currentKey={
            activeSession ? usageGroupKey(activeSession.provider, sessionAccountId(activeSession)) : undefined
          }
          onOpen={onOpenUsage}
        />
        <div className="sidebar-footer">
          <span className={`connection-dot${projection ? " is-connected" : ""}`} aria-hidden="true" />
          <span>{projection ? "Local runtime" : "Waiting for runtime"}</span>
          <IconButton
            className="sidebar-usage"
            label="Usage"
            tooltip="Usage and cost"
            icon="gauge"
            onClick={onOpenUsage}
          />
          <IconButton label="Settings" icon="settings" shortcut={settingsShortcut} onClick={onOpenSettings} />
          <IconButton
            className="sidebar-help"
            label="Help"
            tooltip="Help and diagnostics"
            icon="help"
            onClick={onOpenHelp}
          />
        </div>
      </div>
    </aside>
  );
}
