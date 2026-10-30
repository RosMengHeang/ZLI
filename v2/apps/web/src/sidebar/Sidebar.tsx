import type { Account, ProjectProjection, RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { huddlesOf, MAX_HUDDLE_MEMBERS, threadOccupiesWorktree } from "@zli-v2/contracts";
import { type MouseEvent, useEffect, useState } from "react";

import { accountLabel, sessionAccountId } from "../accounts/accounts.js";
import { providerDisplayName } from "../agent/providers.js";
import { fitHuddleName, liveHuddles, sessionAgentId } from "../huddle/huddles.js";
import { useHuddleCommands } from "../huddle/useHuddleCommands.js";
import { limitKey } from "../limits/limits.js";
import { projectStats, removalDetail } from "../projects/removal.js";
import { trackDescription, trackText } from "../review/branches.js";
import { ConfirmDialog } from "../review/ConfirmDialog.js";
import { type PullRequestEntry, usePullRequestEntries } from "../review/pullRequestStore.js";
import type { RunGroup, RunState } from "../sessions/bestOf.js";
import { runStateLabel } from "../sessions/bestOf.js";
import {
  type AgentSession,
  relativeTime,
  sessionAgentName,
  sessionParents,
  sessionRenameCommand,
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
import { Menu, MenuButton, type MenuItem, type MenuRequest } from "../ui/Menu.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { ariaShortcut } from "../ui/shortcuts.js";
import { ZliLogo } from "../ui/ZliLogo.js";
import { SidebarPlanLimits } from "./SidebarUsageStrip.js";
import { useSidebarCollapsed } from "./sidebarLayout.js";
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
  return {
    label: `#${pullRequest.number}`,
    tone,
    title: `Pull request ${detail.toLowerCase()}`,
  };
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
  /** Opens the dialog that names or renames a started agent. */
  onRenameSession?: ((session: AgentSession) => void) | undefined;
  onSelectWorktree(worktree: WorktreeProjection): void;
  onNewAgent(project?: ProjectProjection): void;
  onOpenProject(): void;
  onCreateWorktree(project?: ProjectProjection): void;
  /** Removes a project from ZLI, leaving its folder on disk. Resolves to what went wrong, if anything. */
  onRemoveProject(projectId: string): Promise<string | undefined>;
  onRenameProject(projectId: string, name: string): void;
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
  /** Opens the Huddle panel on a huddle. Without it agent rows offer no huddle actions. */
  onOpenHuddle?: ((huddleId: string) => void) | undefined;
  /** Shows why a huddle action from an agent row was refused. */
  onHuddleError?: ((message: string) => void) | undefined;
};

const noGroups: readonly RunGroup[] = [];
const noAncestors: ReadonlySet<string> = new Set();
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
  onRenameSession,
  onSelectWorktree,
  onNewAgent,
  onOpenProject,
  onCreateWorktree,
  onRemoveProject,
  onRenameProject,
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
  onOpenHuddle,
  onHuddleError = () => undefined,
}: Props) {
  const newAgentShortcut = useShortcut("newAgent");
  const sidebarShortcut = useShortcut("toggleSidebar");
  const settingsShortcut = useShortcut("settings");
  const [confirmRemoveId, setConfirmRemoveId] = useState<string>();
  const [contextMenu, setContextMenu] = useState<MenuRequest>();
  const [confirmRemoveProjectId, setConfirmRemoveProjectId] = useState<string>();
  const [removingProjectId, setRemovingProjectId] = useState<string>();
  const [removeProjectProblem, setRemoveProjectProblem] = useState<{
    projectId: string;
    message: string;
  }>();
  const [renamingProjectId, setRenamingProjectId] = useState<string>();
  const [huddleMenu, setHuddleMenu] = useState<MenuRequest>();
  const huddleCommands = useHuddleCommands();
  const layout = useSidebarCollapsed();
  const [now, setNow] = useState(() => Date.now());
  const prEntries = usePullRequestEntries();
  const projects = projection?.projects ?? [];
  // Pinned projects first; the sort is stable, so each group keeps its order.
  const orderedProjects = [...projects].sort(
    (left, right) => Number(layout.pinned(right.projectId)) - Number(layout.pinned(left.projectId)),
  );
  const worktrees = projection?.worktrees ?? [];
  const threads = projection?.threads ?? [];
  const activeSession = sessions.find((session) => session.sessionId === activeSessionId);
  const runIds = new Set(runGroups.flatMap((group) => group.sessionIds));
  const groupsBySource = new Map<string, RunGroup[]>();
  for (const group of runGroups) {
    groupsBySource.set(group.sourceSessionId, [...(groupsBySource.get(group.sourceSessionId) ?? []), group]);
  }
  const parents = sessionParents(sessions);
  const subAgentsOf = new Map<string, AgentSession[]>();
  for (const session of [...sessions].sort((left, right) =>
    (left.createdAt ?? "").localeCompare(right.createdAt ?? ""),
  )) {
    const parent = parents.get(session.sessionId);
    if (!parent || runIds.has(session.sessionId)) continue;
    subAgentsOf.set(parent.sessionId, [...(subAgentsOf.get(parent.sessionId) ?? []), session]);
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

  /** Everything a worktree row or an agent's branch line needs to say about its worktree. */
  const worktreeInfo = (worktree: WorktreeProjection) => {
    const live = threads.some(
      (thread) => thread.worktreeId === worktree.worktreeId && threadOccupiesWorktree(thread.status),
    );
    const changed = projection?.reviews?.find((review) => review.worktreeId === worktree.worktreeId)?.files.length;
    const setup = worktreeSetup(projection, worktree.worktreeId);
    const badge = setupBadge(worktree, setup);
    const setupProblem = badge?.tone === "danger" ? (setup?.errorMessage ?? "Setup failed.") : undefined;
    const needsApproval = badge?.tone === "attention";
    const dotClass =
      badge?.tone === "attention"
        ? "status-waiting"
        : badge?.tone === "danger"
          ? "status-failed"
          : `status-${worktree.status}`;
    const statusClass = badge
      ? badge.tone === "danger"
        ? " is-danger"
        : badge.tone === "attention"
          ? " is-attention"
          : ""
      : worktree.status === "ready"
        ? " is-ready"
        : worktree.status === "failed"
          ? " is-danger"
          : "";
    return {
      live,
      changed,
      checkout: worktree.kind === "checkout",
      setup,
      badge,
      setupProblem,
      needsApproval,
      dotClass,
      statusClass,
      statusText: badge?.label ?? worktreeStatusLabel[worktree.status],
      needsAttention: worktree.status === "failed" || Boolean(setupProblem) || needsApproval,
    };
  };

  /** What the "..." menu on a worktree row offers. Fixes that need the person also show in the row. */
  const worktreeMenuItems = (worktree: WorktreeProjection, info: ReturnType<typeof worktreeInfo>): MenuItem[] => {
    const busy = inProgress.has(worktree.status);
    const items: MenuItem[] = [];
    if (info.needsApproval)
      items.push({
        label: "Review setup",
        icon: "check",
        run: () => onReviewSetup(worktree),
      });
    if (info.setup?.terminalId)
      items.push({
        label: "Setup output",
        icon: "terminal",
        run: () => onShowSetupOutput(worktree),
      });
    if (worktree.status === "failed")
      items.push({
        label: "Retry",
        icon: "reload",
        run: () => onWorktreeAction(worktree, "retry"),
      });
    if (busy)
      items.push({
        label: "Cancel",
        icon: "x",
        run: () => onWorktreeAction(worktree, "cancel"),
      });
    // A checkout never touches disk when removed, so it can go even while it is stuck.
    if (!busy || info.checkout) {
      if (items.length > 0) items.push({ separator: true });
      items.push({
        label: info.checkout ? "Forget checkout" : "Delete worktree",
        icon: "trash",
        tone: "danger",
        disabled: info.live,
        title: info.live
          ? "Stop the agents in this worktree first"
          : info.checkout
            ? "Remove from ZLI. Files stay on disk."
            : "Delete this worktree and its folder",
        run: () => setConfirmRemoveId(worktree.worktreeId),
      });
    }
    return items;
  };

  /** Fixes that need the person, and the delete confirm, shown in the flow under the row. */
  const renderWorktreeFixes = (worktree: WorktreeProjection, info: ReturnType<typeof worktreeInfo>) => {
    const confirming = confirmRemoveId === worktree.worktreeId;
    if (!confirming && !info.needsAttention) return null;
    return (
      <div className="worktree-actions">
        {confirming ? (
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
              {info.checkout ? "Forget checkout" : "Delete worktree"}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setConfirmRemoveId(undefined)}>
              Keep
            </Button>
          </>
        ) : (
          <>
            {info.needsApproval ? (
              <Button variant="ghost" size="xs" icon="check" onClick={() => onReviewSetup(worktree)}>
                Review setup
              </Button>
            ) : null}
            {info.setup?.terminalId ? (
              <Button variant="ghost" size="xs" icon="terminal" onClick={() => onShowSetupOutput(worktree)}>
                Setup output
              </Button>
            ) : null}
            {worktree.status === "failed" ? (
              <Button variant="ghost" size="xs" icon="reload" onClick={() => onWorktreeAction(worktree, "retry")}>
                Retry
              </Button>
            ) : null}
          </>
        )}
      </div>
    );
  };
  /** What went wrong with a worktree, in words, under the row that shows it. */
  const worktreeNote = (worktree: WorktreeProjection, info: ReturnType<typeof worktreeInfo>) =>
    worktree.status === "failed" && worktree.errorMessage ? (
      <p className="sidebar-note is-error" role="status">
        {worktree.errorMessage}
      </p>
    ) : info.setupProblem ? (
      <p className="sidebar-note is-error" role="status">
        {info.setupProblem}
      </p>
    ) : null;

  /** What a project's "..." menu, and a right-click on its row, offers. */
  const projectMenuItems = (project: ProjectProjection): MenuItem[] => [
    { label: "New agent", icon: "agentNew", run: () => onNewAgent(project) },
    {
      label: "New worktree",
      icon: "branch",
      disabled: project.git === false,
      title: project.git === false ? "Worktrees need Git. This folder is not a Git repository." : "New worktree here",
      run: () => onCreateWorktree(project),
    },
    { separator: true },
    {
      label: "Remove project",
      icon: "trash",
      tone: "danger",
      title: "Remove from ZLI. The folder stays on disk.",
      run: () => {
        setRemoveProjectProblem(undefined);
        setConfirmRemoveProjectId(project.projectId);
      },
    },
  ];

  /** A right-click on a project's row adds pinning and renaming to its "..." menu. */
  const projectContextItems = (project: ProjectProjection): MenuItem[] => [
    {
      label: layout.pinned(project.projectId) ? "Unpin" : "Pin",
      icon: "pin",
      run: () => layout.togglePinned(project.projectId),
    },
    {
      label: "Edit",
      icon: "pencil",
      title: "Rename this project",
      run: () => setRenamingProjectId(project.projectId),
    },
    { separator: true },
    ...projectMenuItems(project),
  ];

  const renderProjectRename = (project: ProjectProjection) => (
    <input
      className="project-rename"
      aria-label={`Rename ${project.name}`}
      defaultValue={project.name}
      // biome-ignore lint/a11y/noAutofocus: the field opens because the person chose Edit.
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.currentTarget.value = project.name;
        if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur();
      }}
      onBlur={(event) => {
        setRenamingProjectId(undefined);
        const name = event.currentTarget.value.trim();
        if (name && name !== project.name) onRenameProject(project.projectId, name);
      }}
    />
  );

  const removeProject = async (project: ProjectProjection) => {
    setRemovingProjectId(project.projectId);
    setRemoveProjectProblem(undefined);
    const problem = await onRemoveProject(project.projectId);
    setRemovingProjectId(undefined);
    if (problem) {
      setRemoveProjectProblem({
        projectId: project.projectId,
        message: problem,
      });
      return;
    }
    setConfirmRemoveProjectId(undefined);
  };

  /** Removing takes two clicks on purpose: the menu only asks, and this dialog confirms. */
  const renderProjectConfirm = () => {
    const project = projects.find((entry) => entry.projectId === confirmRemoveProjectId);
    if (!project) return null;
    const problem = removeProjectProblem?.projectId === project.projectId ? removeProjectProblem.message : undefined;
    return (
      <ConfirmDialog
        label="Remove project"
        title={`Remove ${project.name} from ZLI?`}
        detail={
          <>
            {removalDetail(projectStats(projection, project))}
            {problem ? (
              <span className="project-confirm-problem" role="alert">
                {problem}
              </span>
            ) : null}
          </>
        }
        confirmLabel="Remove"
        busy={removingProjectId === project.projectId}
        onConfirm={() => void removeProject(project)}
        onCancel={() => setConfirmRemoveProjectId(undefined)}
      />
    );
  };

  /** A worktree no agent runs in: selectable, and removable from its hover actions. */
  const renderWorktree = (worktree: WorktreeProjection) => {
    const info = worktreeInfo(worktree);
    const active = activeWorktreeId === worktree.worktreeId;
    return (
      <li className="worktree-entry" key={worktree.worktreeId}>
        <button
          className={`worktree-row${active ? " is-active" : ""}`}
          type="button"
          onClick={() => onSelectWorktree(worktree)}
          title={[worktree.path, worktree.status === "failed" ? worktree.errorMessage : undefined, info.setupProblem]
            .filter(Boolean)
            .join("\n")}
          data-live-agent={info.live ? "true" : "false"}
          aria-current={active ? "true" : undefined}
        >
          <span className={`status-dot ${info.dotClass}`} aria-hidden="true" />
          <span className="worktree-name">{worktree.branch}</span>
          <span className="worktree-meta">
            <WorktreeTrack entry={prEntries.get(worktree.worktreeId)} branch={worktree.branch} />
            {info.checkout ? <span className="worktree-kind">checkout</span> : null}
            <WorktreePrBadge entry={prEntries.get(worktree.worktreeId)} />
            <span className={`worktree-status${info.statusClass}`}>{info.statusText}</span>
            {info.changed ? (
              <span className="count" title={`${info.changed} changed files`}>
                {info.changed}
              </span>
            ) : null}
          </span>
        </button>
        <span className="row-more">
          <MenuButton
            label="Worktree actions"
            tooltip="More"
            size="xs"
            items={() => worktreeMenuItems(worktree, info)}
          />
        </span>
        {worktreeNote(worktree, info)}
        {renderWorktreeFixes(worktree, info)}
      </li>
    );
  };

  const runHuddleCommand = async (command: Record<string, unknown>) => {
    const error = await huddleCommands.run(command);
    if (error) onHuddleError(error);
  };
  const createHuddle = async (name: string, members: string[]) => {
    const result = await huddleCommands.create(fitHuddleName(name), members);
    if ("error" in result) onHuddleError(result.error);
    else onOpenHuddle?.(result.huddleId);
  };
  /** A second menu, at the row's "..." button, listing the huddles the agent can join or leave. */
  const openHuddleMenu = (agentId: string, label: string) => {
    if (!projection) return;
    const anchor = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const rect = anchor?.getBoundingClientRect();
    const memberOf = new Set(huddlesOf(projection, agentId).map((huddle) => huddle.huddleId));
    const live = liveHuddles(projection);
    setHuddleMenu({
      x: rect?.right ?? 0,
      y: (rect?.bottom ?? 0) + 4,
      align: "end",
      anchor,
      label: "Add to huddle",
      items: [
        ...live.map(
          (huddle): MenuItem => ({
            label: huddle.name,
            checked: memberOf.has(huddle.huddleId),
            title: memberOf.has(huddle.huddleId) ? `Remove ${label} from ${huddle.name}` : undefined,
            run: () =>
              void runHuddleCommand({
                type: memberOf.has(huddle.huddleId) ? "huddle.leave" : "huddle.join",
                huddleId: huddle.huddleId,
                agentId,
              }),
          }),
        ),
        ...(live.length > 0 ? [{ separator: true } as const] : []),
        {
          label: "New huddle with this agent",
          icon: "plus",
          run: () => void createHuddle(`Huddle with ${label}`, [agentId]),
        },
      ],
    });
  };
  const startSubAgentHuddle = (agentId: string, label: string, subAgents: readonly AgentSession[]) => {
    const members = [agentId, ...subAgents.map(sessionAgentId).filter((id): id is string => id !== undefined)];
    if (members.length > MAX_HUDDLE_MEMBERS) {
      onHuddleError(
        `A huddle holds up to ${MAX_HUDDLE_MEMBERS} agents, and ${label} has ${members.length - 1} sub-agents. Start an empty huddle and add the ones you need.`,
      );
      return;
    }
    void createHuddle(`${label} and sub-agents`, members);
  };

  /** Opens a menu at the pointer. Shift+F10 or the Menu key fire this with no pointer position, so it opens under the row. */
  const openContextMenu = (event: MouseEvent<HTMLElement>, label: string, items: () => MenuItem[]) => {
    event.preventDefault();
    const row = event.currentTarget.getBoundingClientRect();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    setContextMenu({
      x: fromKeyboard ? row.left : event.clientX,
      y: fromKeyboard ? row.bottom : event.clientY,
      label,
      items: items(),
    });
  };

  /** What the "..." menu on an agent row offers. */
  const sessionMenuItems = (
    session: AgentSession,
    stoppable: boolean,
    worktree: WorktreeProjection | undefined,
    subAgents: readonly AgentSession[] = [],
  ): MenuItem[] => {
    const items: MenuItem[] = [];
    if (onRenameSession && sessionRenameCommand(session, null)) {
      const label = sessionAgentName(session) ? "Rename agent" : "Name agent";
      items.push({ label, icon: "pencil", run: () => onRenameSession(session) });
    }
    const agentId = onOpenHuddle ? sessionAgentId(session) : undefined;
    if (agentId) {
      const label = sessionAgentName(session) ?? sessionTitle(session, projection?.messages, projection?.providers);
      items.push({ label: "Add to huddle", icon: "users", run: () => openHuddleMenu(agentId, label) });
      if (subAgents.length > 0) {
        items.push({
          label: "Start a huddle with its sub-agents",
          icon: "users",
          run: () => startSubAgentHuddle(agentId, label, subAgents),
        });
      }
    }
    if (stoppable)
      items.push({
        label: "Stop agent",
        icon: "stop",
        run: () => onStopSession(session),
      });
    if (worktree) {
      const { branch } = worktree;
      items.push({
        label: "Copy branch name",
        icon: "copy",
        run: () => void navigator.clipboard?.writeText(branch),
      });
    }
    if (items.length > 0) items.push({ separator: true });
    items.push({
      label: "Delete agent",
      icon: "trash",
      tone: "danger",
      run: () => onDeleteSession(session),
    });
    return items;
  };
  const renderSession = (
    session: AgentSession,
    projectWorktrees: readonly WorktreeProjection[],
    groups: readonly RunGroup[] | undefined,
    runIndex?: number,
    /** Set on the first agent of a worktree that needs attention, so its fix shows once. */
    showWorktreeAlert = false,
    /** Sessions above this one in the sub-agent tree, so bad data can't nest a row inside itself. */
    ancestors = noAncestors,
  ) => {
    const worktree = projectWorktrees.find((entry) => entry.worktreeId === session.worktreeId);
    const info = worktree ? worktreeInfo(worktree) : undefined;
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
    const agentName = sessionAgentName(session);
    const runName = runIndex === undefined ? title : `Run ${runIndex}`;
    const name = agentName ? `${agentName}, ${runName}` : runName;
    const branchLine = runIndex === undefined && worktree && info;
    const parent = parents.get(session.sessionId);
    const parentName = parent
      ? (sessionAgentName(parent) ?? sessionTitle(parent, projection?.messages, projection?.providers))
      : undefined;
    const subAgents = (subAgentsOf.get(session.sessionId) ?? []).filter(
      (child) => child.sessionId !== session.sessionId && !ancestors.has(child.sessionId),
    );
    const below = subAgents.length > 0 ? new Set([...ancestors, session.sessionId]) : ancestors;
    return (
      <li className={`session-entry${runIndex === undefined ? "" : " is-run"}`} key={session.sessionId}>
        <button
          className={`session-row${active ? " is-active" : ""}${branchLine ? " has-branch" : ""}`}
          type="button"
          aria-label={`${name}, ${providerName}, ${status}${background ? ", in the background" : ""}`}
          aria-current={active ? "true" : undefined}
          onClick={() => onSelectSession(session)}
          onContextMenu={(event) =>
            openContextMenu(event, "Agent actions", () =>
              sessionMenuItems(session, stoppable, runIndex === undefined ? worktree : undefined, subAgents),
            )
          }
          title={`${agentName ? `${agentName}\n` : ""}${worktree ? `${title}\n${worktree.branch} · ${worktree.path}` : title}${account ? `\nAccount: ${account}` : ""}${parentName ? `\nStarted by ${parentName}` : ""}`}
        >
          <ProviderMark provider={session.provider} size={14} />
          <span className="session-copy">
            <span className="session-line">
              {agentName ? <span className="session-name">{agentName}</span> : null}
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
            </span>
            {branchLine ? (
              <span className="session-branch">
                <Icon name="branch" size={10} />
                <span className="worktree-name">{worktree.branch}</span>
                <WorktreeTrack entry={prEntries.get(worktree.worktreeId)} branch={worktree.branch} />
                <WorktreePrBadge entry={prEntries.get(worktree.worktreeId)} />
                {worktree.status === "ready" && !info.badge ? null : (
                  <span className={`worktree-status${info.statusClass}`}>{info.statusText}</span>
                )}
                {info.changed ? (
                  <span className="count" title={`${info.changed} changed files`}>
                    {info.changed}
                  </span>
                ) : null}
              </span>
            ) : null}
          </span>
        </button>
        <span className="row-more">
          <MenuButton
            label="Agent actions"
            tooltip="More"
            size="xs"
            items={() => sessionMenuItems(session, stoppable, runIndex === undefined ? worktree : undefined, subAgents)}
          />
        </span>{" "}
        {showWorktreeAlert && worktree && info?.needsAttention ? (
          <div className="session-worktree-alert">
            {worktreeNote(worktree, info)}
            {renderWorktreeFixes(worktree, info)}
          </div>
        ) : null}
        {groups?.map((group) => (
          <div key={group.groupId}>{renderGroup(group, projectWorktrees)}</div>
        ))}
        {subAgents.length > 0 ? (
          <ul className="session-list sub-agent-list" aria-label={`Sub-agents of ${agentName ?? title}`}>
            {subAgents.map((child) =>
              renderSession(child, projectWorktrees, groupsBySource.get(child.sessionId), undefined, false, below),
            )}
          </ul>
        ) : null}
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
          <Icon name="folderPlus" size={16} />
          <span>Add project</span>
        </button>
        <button
          className="btn btn-secondary sidebar-new-agent"
          type="button"
          onClick={() => onNewAgent()}
          disabled={projects.length === 0}
          aria-keyshortcuts={ariaShortcut(newAgentShortcut)}
        >
          <Icon name="agentNew" size={16} />
          <span>New agent</span>
          <Kbd shortcut={newAgentShortcut} />
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
          <>
            <h2 className="sidebar-heading">Projects</h2>
            {orderedProjects.map((project) => {
              const projectWorktrees = worktrees.filter((worktree) => worktree.projectId === project.projectId);
              const worktreeIds = new Set<string>(projectWorktrees.map((worktree) => worktree.worktreeId));
              const projectSessions = sessions
                .filter((session) => worktreeIds.has(session.worktreeId))
                .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
              const open = layout.projectOpen(project.projectId);
              const pinned = layout.pinned(project.projectId);
              const idleOpen = layout.idleOpen(project.projectId);
              const agentCount = projectSessions.filter((session) => !runIds.has(session.sessionId)).length;
              const busy = projectSessions.some(
                (session) => session.status === "working" || session.status === "starting",
              );
              const waiting = projectSessions.some((session) => session.status === "waiting");
              const idle = projectWorktrees.filter(
                (worktree) => !projectSessions.some((session) => session.worktreeId === worktree.worktreeId),
              );
              // A folded row still shows the worktree the person is in, and any that is busy or needs them.
              const idleShown = idleOpen
                ? idle
                : idle.filter(
                    (worktree) =>
                      worktree.worktreeId === activeWorktreeId ||
                      worktree.worktreeId === confirmRemoveId ||
                      worktree.status !== "ready" ||
                      worktreeInfo(worktree).needsAttention,
                  );
              const alerted = new Set<string>();
              const firstForWorktree = (session: AgentSession) => {
                if (alerted.has(session.worktreeId)) return false;
                alerted.add(session.worktreeId);
                return true;
              };
              return (
                <section
                  className={`sidebar-project${open ? "" : " is-collapsed"}`}
                  key={project.projectId}
                  aria-label={project.name}
                >
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: Shift+F10 or the Menu key on the focused toggle opens this menu too. */}
                  <div
                    className="project-label"
                    title={project.path}
                    onContextMenu={(event) =>
                      openContextMenu(event, `${project.name} actions`, () => projectContextItems(project))
                    }
                  >
                    {renamingProjectId === project.projectId ? (
                      renderProjectRename(project)
                    ) : (
                      <button
                        className="project-toggle"
                        type="button"
                        aria-expanded={open}
                        aria-label={`${project.name}${pinned ? ", pinned" : ""}, ${open ? "collapse" : "expand"}`}
                        onClick={() => layout.toggleProject(project.projectId)}
                      >
                        <Icon name={open ? "folderOpen" : "folder"} size={14} />
                        <span className="project-name">{project.name}</span>
                        {pinned ? <Icon name="pin" size={11} className="project-pin" aria-hidden="true" /> : null}
                        <Icon name="chevronRight" size={11} className="project-chevron" />
                      </button>
                    )}
                    {open || agentCount === 0 ? null : (
                      <span
                        className={`project-summary${waiting ? " is-waiting" : busy ? " is-working" : ""}`}
                        title={`${agentCount === 1 ? "1 agent" : `${agentCount} agents`}, ${projectWorktrees.length === 1 ? "1 worktree" : `${projectWorktrees.length} worktrees`}`}
                      >
                        {waiting || busy ? <span className="dot" aria-hidden="true" /> : null}
                        {agentCount}
                      </span>
                    )}
                    <IconButton
                      className="project-action"
                      label="Create worktree"
                      tooltip={
                        project.git === false
                          ? "Worktrees need Git. This folder is not a Git repository."
                          : "New worktree"
                      }
                      icon="branch"
                      size="xs"
                      iconSize={13}
                      disabled={project.git === false}
                      onClick={() => onCreateWorktree(project)}
                    />
                    <IconButton
                      className="project-action"
                      label={`New agent in ${project.name}`}
                      tooltip="New agent here"
                      icon="agentNew"
                      size="xs"
                      iconSize={13}
                      onClick={() => onNewAgent(project)}
                    />
                    <MenuButton
                      className="project-action"
                      label={`${project.name} actions`}
                      tooltip="More"
                      size="xs"
                      items={() => projectMenuItems(project)}
                    />
                  </div>
                  {!open ? null : (
                    <>
                      {projectSessions.length === 0 ? (
                        <p className="sidebar-note">No agents yet.</p>
                      ) : (
                        <ul className="session-list">
                          {projectSessions.map((session) => {
                            if (runIds.has(session.sessionId)) return null;
                            // A sub-agent lists under the agent that started it, which is in this project too.
                            if (parents.has(session.sessionId)) return null;
                            return renderSession(
                              session,
                              projectWorktrees,
                              groupsBySource.get(session.sessionId),
                              undefined,
                              firstForWorktree(session),
                            );
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
                      )}
                      {idle.length > 0 ? (
                        <div className="worktree-heading">
                          <button
                            className="worktree-toggle"
                            type="button"
                            aria-expanded={idleOpen}
                            onClick={() => layout.toggleIdle(project.projectId)}
                          >
                            <Icon name="chevronRight" size={11} className="worktree-toggle-chevron" />
                            {idle.length === 1
                              ? "1 worktree without agents"
                              : `${idle.length} worktrees without agents`}
                          </button>
                        </div>
                      ) : null}
                      {idleShown.length > 0 ? <ul className="worktree-list">{idleShown.map(renderWorktree)}</ul> : null}
                    </>
                  )}
                </section>
              );
            })}
          </>
        )}
      </div>
      <div className="sidebar-bottom">
        <SidebarPlanLimits
          providers={projection?.providers}
          accounts={accounts}
          now={now}
          currentKey={activeSession ? limitKey(activeSession.provider, sessionAccountId(activeSession)) : undefined}
          onOpen={onOpenUsage}
        />
        <div className="sidebar-footer">
          <span className={`connection-dot${projection ? " is-connected" : ""}`} aria-hidden="true" />
          <span className="sidebar-runtime">{projection ? "Local runtime" : "Waiting for runtime"}</span>
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
      {contextMenu ? <Menu request={contextMenu} onClose={() => setContextMenu(undefined)} /> : null}
      {renderProjectConfirm()}
      {huddleMenu ? <Menu request={huddleMenu} onClose={() => setHuddleMenu(undefined)} /> : null}
    </aside>
  );
}
