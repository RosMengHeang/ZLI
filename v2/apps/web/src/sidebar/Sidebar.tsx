import type { Account, ProjectProjection, RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { huddlesOf, MAX_HUDDLE_MEMBERS, threadOccupiesWorktree } from "@zli-v2/contracts";
import { type CSSProperties, type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";

import { accountLabel, sessionAccountId } from "../accounts/accounts.js";
import { providerDisplayName } from "../agent/providers.js";
import { CHAT_DRAG_TYPE, chatTranscript } from "../chat/chatDrag.js";
import { fitHuddleName, liveHuddles, sessionAgentId } from "../huddle/huddles.js";
import { useHuddleCommands } from "../huddle/useHuddleCommands.js";
import { limitKey } from "../limits/limits.js";
import { projectStats, removalDetail } from "../projects/removal.js";
import { trackDescription, trackText } from "../review/branches.js";
import { ConfirmDialog } from "../review/ConfirmDialog.js";
import { type PullRequestEntry, usePullRequestEntries } from "../review/pullRequestStore.js";
import type { RunGroup, RunState } from "../sessions/bestOf.js";
import { runStateLabel } from "../sessions/bestOf.js";
import { setChatArchived, useArchivedChats } from "../sessions/chatArchive.js";
import { useChatTitlesVersion } from "../sessions/chatTitles.js";
import {
  type AgentSession,
  conversationThreads,
  relativeTime,
  sessionAgentName,
  sessionParents,
  sessionRenameCommand,
  sessionStatusLabel,
  sessionStopCommands,
  sessionTitle,
} from "../sessions/sessions.js";
import { groupFinished } from "../sessions/useRunStates.js";
import type { SettingsSection } from "../settings/SettingsDialog.js";
import { setupBadge, worktreeSetup } from "../setup/setup.js";
import { useShortcut } from "../shell/keybindings.js";
import { assignChatAnimals } from "../teammates/chatAnimals.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { Kbd } from "../ui/Kbd.js";
import { Menu, type MenuAction, MenuButton, type MenuItem, type MenuRequest } from "../ui/Menu.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import { ariaShortcut } from "../ui/shortcuts.js";
import { ZliLogo } from "../ui/ZliLogo.js";
import { SessionAvatar } from "./SessionAvatar.js";
import { SidebarPlanLimits } from "./SidebarUsageStrip.js";
import { AskLine, LiveStep, ReplyPreview } from "./sessionLines.js";
import { useSidebarCollapsed } from "./sidebarLayout.js";
import { useUnread } from "./unread.js";
import "./sidebar.css";

export type WorktreeAction = "retry" | "cancel" | "remove";

/** Board actions for one project's agents. An action is missing when it would change nothing. */
export type ProjectAgentActions = {
  focus?: (() => void) | undefined;
  open?: (() => void) | undefined;
  close?: (() => void) | undefined;
};

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
  /** The project the person is working in. Its New agent button stays in view. */
  currentProjectId?: string | undefined;
  /** A project the person just added. The sidebar opens its folder and scrolls it into view. */
  selectedProjectId?: string | undefined;
  onSelectSession(session: AgentSession): void;
  onStopSession(session: AgentSession): void;
  onDeleteSession(session: AgentSession): void;
  /** Opens the dialog that names or renames a started agent. */
  onRenameSession?: ((session: AgentSession) => void) | undefined;
  onSelectWorktree(worktree: WorktreeProjection): void;
  onNewAgent(project?: ProjectProjection): void;
  /** The New agent dialog with every option, for this project: agent, view, worktree and name. */
  onNewAgentOptions?: ((project: ProjectProjection) => void) | undefined;
  onOpenProject(): void;
  onCreateWorktree(project?: ProjectProjection): void;
  /** Removes a project from ZLI, leaving its folder on disk. Resolves to what went wrong, if anything. */
  onRemoveProject(projectId: string): Promise<string | undefined>;
  onRenameProject(projectId: string, name: string): void;
  onWorktreeAction(worktree: WorktreeProjection, action: WorktreeAction): void;
  onReviewSetup(worktree: WorktreeProjection): void;
  onShowSetupOutput(worktree: WorktreeProjection): void;
  onOpenHelp(): void;
  /** Opens Settings, at `section` when given. */
  onOpenSettings(section?: SettingsSection): void;
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
  /** Shows, opens, or closes all of a project's tiles at once. Without it project rows offer none of these. */
  projectAgentActions?: ((projectId: string) => ProjectAgentActions) | undefined;
};

const noGroups: readonly RunGroup[] = [];
const noAncestors: ReadonlySet<string> = new Set();
const noStates: ReadonlyMap<string, RunState> = new Map();

/** How many projects without agents it takes before they fold into one row. */
const FOLD_QUIET_PROJECTS = 3;

/** A project lists this many chats; quiet ones past it fold into one row, so old chats never bury new ones. */
const RECENT_CHATS = 5;
const noOlder: ReadonlySet<string> = new Set();

export function Sidebar({
  projection,
  sessions: allSessions,
  activeSessionId,
  backgroundSessionIds,
  activeWorktreeId,
  currentProjectId,
  selectedProjectId,
  onSelectSession,
  onStopSession,
  onDeleteSession,
  onRenameSession,
  onSelectWorktree,
  onNewAgent,
  onNewAgentOptions,
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
  projectAgentActions,
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
  // Archived chats leave their project's list for the Archived section at the bottom.
  const archivedIds = useArchivedChats();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const sessions = useMemo(
    () => allSessions.filter((session) => !archivedIds.has(session.sessionId)),
    [allSessions, archivedIds],
  );
  const archivedChats = useMemo(
    () => allSessions.filter((session) => archivedIds.has(session.sessionId)),
    [allSessions, archivedIds],
  );
  // An agent brought into a chat answers inside that chat, so its replies are read there, not flagged here.
  const ownChats = useMemo(() => sessions.filter((session) => !session.thread?.joins), [sessions]);
  // Every chat gets an animal the first time it is listed, picked so the chats around it look different.
  const chatOrder = [...sessions]
    .sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""))
    .map((session) => session.sessionId)
    .join(" ");
  useEffect(() => {
    if (chatOrder) assignChatAnimals(chatOrder.split(" "));
  }, [chatOrder]);
  const { unread, clear: clearUnread } = useUnread(ownChats, activeSessionId, projection !== undefined);
  /** Projects whose older chats the person unfolded. */
  const [olderOpen, setOlderOpen] = useState<ReadonlySet<string>>(noOlder);
  useChatTitlesVersion();
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

  // Once several projects sit empty beside ones in use, as after setup adds every folder found, the empty
  // ones fold into one row. Pinned and selected projects stay listed; a short list is left as it is.
  const [moreOpen, setMoreOpen] = useState(false);
  const worked = new Set(
    worktrees
      .filter(
        (worktree) =>
          worktree.kind === "worktree" ||
          worktree.status !== "ready" ||
          sessions.some((session) => session.worktreeId === worktree.worktreeId),
      )
      .map((worktree) => worktree.projectId),
  );
  const listed = (project: ProjectProjection) =>
    worked.has(project.projectId) ||
    layout.pinned(project.projectId) ||
    [
      selectedProjectId,
      currentProjectId,
      renamingProjectId,
      removingProjectId,
      removeProjectProblem?.projectId,
    ].includes(project.projectId);
  const quiet = orderedProjects.filter((project) => !listed(project));
  const fold = quiet.length >= FOLD_QUIET_PROJECTS && quiet.length < orderedProjects.length;
  const listedProjects = fold ? orderedProjects.filter(listed) : orderedProjects;
  const quietProjects = fold ? quiet : [];

  const asideRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const { expandProject } = layout;
  useEffect(() => {
    if (!selectedProjectId) return;
    expandProject(selectedProjectId);
    [...(asideRef.current?.querySelectorAll<HTMLElement>(".sidebar-project") ?? [])]
      .find((section) => section.dataset.projectId === selectedProjectId)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedProjectId, expandProject]);

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

  /** Board actions for the project's agents. Each is off when it would change nothing. */
  const projectAgentItems = (project: ProjectProjection): MenuItem[] => {
    if (!projectAgentActions) return [];
    const actions = projectAgentActions(project.projectId);
    const hasAgents = sessions.some((session) =>
      worktrees.some(
        (worktree) => worktree.worktreeId === session.worktreeId && worktree.projectId === project.projectId,
      ),
    );
    const item = (
      label: string,
      icon: MenuAction["icon"],
      run: (() => void) | undefined,
      title: string,
      unchanged: string,
    ): MenuItem => ({
      label,
      icon,
      disabled: !run,
      title: !hasAgents ? "This project has no agents yet." : run ? title : unchanged,
      run: run ?? (() => undefined),
    });
    return [
      { separator: true },
      item(
        "Show only this project",
        "eye",
        actions.focus,
        "Hide other projects' agents and bring back this project's tiles.",
        "Only this project's agents are on the board.",
      ),
      item("Open all agents", "grid", actions.open, "Open a tile for every agent here.", "All agents here are open."),
      item(
        "Close all agents",
        "minimize",
        actions.close,
        "Hide their tiles. The agents keep running.",
        "No agents here are open.",
      ),
    ];
  };

  /** What a project's "..." menu, and a right-click on its row, offers. */
  const projectMenuItems = (project: ProjectProjection): MenuItem[] => [
    { label: "New chat", icon: "squarePen", run: () => onNewAgent(project) },
    ...(onNewAgentOptions
      ? [{ label: "New agent with options…", icon: "agentNew" as const, run: () => onNewAgentOptions(project) }]
      : []),
    {
      label: "New worktree",
      icon: "branch",
      disabled: project.git === false,
      title: project.git === false ? "Worktrees need Git. This folder is not a Git repository." : "New worktree here",
      run: () => onCreateWorktree(project),
    },
    ...projectAgentItems(project),
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
    const pinned = layout.chatPinned(session.sessionId);
    items.push({
      label: pinned ? "Unpin chat" : "Pin chat",
      icon: "pin",
      title: pinned ? undefined : "Keep this chat at the top of the sidebar",
      run: () => layout.toggleChatPinned(session.sessionId),
    });
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
    if (session.mode === "chat") {
      const archived = archivedIds.has(session.sessionId);
      items.push({
        label: archived ? "Unarchive chat" : "Archive chat",
        icon: "bookmark",
        title: archived ? undefined : "Move this chat to Archived at the bottom of the sidebar",
        run: () => setChatArchived(session.sessionId, !archived),
      });
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
    /** The row sits under its worktree's branch row, which already says where it works. */
    grouped = false,
    /** Listed outside its project, as in search results, so the row names the project. */
    withProject = false,
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
    // A chat that is starting reads as ready: it already takes messages, so its start-up is not news.
    const quiet =
      runStatus === undefined &&
      (session.status === "ready" ||
        session.status === "ended" ||
        (session.mode === "chat" && (session.status === "starting" || session.status === "preparing")));
    const agentName = sessionAgentName(session);
    const runName = runIndex === undefined ? title : `Run ${runIndex}`;
    const name = agentName ? `${agentName}, ${runName}` : runName;
    // The project's own folder needs no branch line; a worktree of its own names it once, on its first chat.
    const branchLine =
      runIndex === undefined && !grouped && showWorktreeAlert && worktree && worktree.kind !== "checkout" && info;
    // A live agent says what it is doing, or what it asked, on a line of its own.
    const live =
      runIndex === undefined && session.thread && (session.status === "working" || session.status === "waiting")
        ? session.thread
        : undefined;
    const isUnread = unread.has(session.sessionId);
    const failure =
      session.status === "failed" ? (session.thread?.errorMessage ?? session.pending?.errorMessage) : undefined;
    const parent = parents.get(session.sessionId);
    const parentName = parent
      ? (sessionAgentName(parent) ?? sessionTitle(parent, projection?.messages, projection?.providers))
      : undefined;
    const subAgents = (subAgentsOf.get(session.sessionId) ?? []).filter(
      (child) => child.sessionId !== session.sessionId && !ancestors.has(child.sessionId),
    );
    const below = subAgents.length > 0 ? new Set([...ancestors, session.sessionId]) : ancestors;
    // Agents brought into the chat talk inside it, so they show as faces on its card rather than rows of their own.
    const guests = subAgents.filter((child) => child.thread?.joins !== undefined);
    const helpers = subAgents.filter((child) => child.thread?.joins === undefined);
    // The card's second line says what matters now: what the chat is doing, what it asks, why it failed, or
    // the last thing it said.
    const lastWord =
      !live && !failure && runIndex === undefined && isUnread && session.thread ? session.thread : undefined;
    return (
      <li className={`session-entry${runIndex === undefined ? "" : " is-run"}`} key={session.sessionId}>
        <button
          className={`session-row${active ? " is-active" : ""}${branchLine ? " has-branch" : ""}${live || failure || lastWord ? " has-state" : ""}${isUnread ? " is-unread" : ""}`}
          type="button"
          aria-label={`${name}, ${providerName}, ${status}${background ? ", in the background" : ""}${isUnread ? ", unread" : ""}`}
          aria-current={active ? "true" : undefined}
          onClick={() => onSelectSession(session)}
          // A chat dragged onto a message box goes along with the next message as context.
          draggable={session.mode === "chat" && session.thread ? true : undefined}
          onDragStart={
            session.mode === "chat" && session.thread
              ? (event) => {
                  const chain = new Set(
                    conversationThreads(session.thread as NonNullable<typeof session.thread>, session.threads).map(
                      (entry) => entry.threadId,
                    ),
                  );
                  const said = (projection?.messages ?? []).filter((message) => chain.has(message.threadId));
                  event.dataTransfer.setData(
                    CHAT_DRAG_TYPE,
                    JSON.stringify({ title, transcript: chatTranscript(title, said) }),
                  );
                  event.dataTransfer.setData("text/plain", title);
                  event.dataTransfer.effectAllowed = "copy";
                }
              : undefined
          }
          onContextMenu={(event) =>
            openContextMenu(event, "Agent actions", () =>
              sessionMenuItems(session, stoppable, runIndex === undefined ? worktree : undefined, subAgents),
            )
          }
          title={`${agentName ? `${agentName}\n` : ""}${worktree ? `${title}\n${worktree.branch} · ${worktree.path}` : title}${account ? `\nAccount: ${account}` : ""}${parentName ? `\nStarted by ${parentName}` : ""}${failure ? `\n${failure}` : ""}`}
        >
          <span className="session-face">
            <SessionAvatar
              session={session}
              size={runIndex === undefined ? 22 : 18}
              quietStart={session.mode === "chat"}
            />
            {guests.length > 0 ? (
              <span
                className="session-team"
                title={guests.map((guest) => sessionAgentName(guest) ?? "Agent").join(", ")}
              >
                {guests.slice(0, 3).map((guest) => (
                  <SessionAvatar key={guest.sessionId} session={guest} size={13} />
                ))}
              </span>
            ) : null}
          </span>
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
              {withProject && runIndex === undefined ? (
                <span className="session-project">{projectOf(session)?.name}</span>
              ) : null}
              <span className="session-side">
                {quiet ? (
                  background ? (
                    <span className="session-background">Background</span>
                  ) : (
                    <>
                      {isUnread ? <span className="session-unread" aria-hidden="true" /> : null}
                      <span className="session-time">{relativeTime(session.updatedAt, now)}</span>
                    </>
                  )
                ) : live && session.status === "working" ? null : (
                  <span
                    // A failure the person has already opened stays labelled, without the red that calls for a look.
                    className={`session-status is-${runStatus === "running" ? "working" : (runStatus ?? session.status)}${runStatus === undefined && session.status === "failed" && !isUnread ? " is-seen" : ""}`}
                  >
                    <span className="dot" aria-hidden="true" />
                    <span className="session-status-label">{status}</span>
                  </span>
                )}
              </span>
            </span>
            {live ? (
              <span className={`session-state is-${session.status}`}>
                {session.status === "waiting" ? (
                  <AskLine threadId={live.threadId} provider={session.provider} />
                ) : (
                  <span className="shimmer-text">
                    <LiveStep threadId={live.threadId} turnId={live.activeTurnId} />
                  </span>
                )}
              </span>
            ) : failure ? (
              <span className="session-state is-failed">{failure}</span>
            ) : lastWord ? (
              <span className="session-state is-said">
                <ReplyPreview threadId={lastWord.threadId} />
              </span>
            ) : null}
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
          {runIndex === undefined && session.mode !== "chat" ? (
            <span className="session-agent" aria-hidden="true">
              <ProviderMark provider={session.provider} size={12} />
            </span>
          ) : null}
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
        {helpers.length > 0 ? (
          <ul className="session-list sub-agent-list" aria-label={`Sub-agents of ${agentName ?? title}`}>
            {helpers.map((child) =>
              renderSession(child, projectWorktrees, groupsBySource.get(child.sessionId), undefined, false, below),
            )}
          </ul>
        ) : null}
      </li>
    );
  };

  const projectOf = (session: AgentSession) => {
    const worktree = worktrees.find((entry) => entry.worktreeId === session.worktreeId);
    return projects.find((entry) => entry.projectId === worktree?.projectId);
  };
  const pinnedChats = sessions.filter((session) => layout.chatPinned(session.sessionId));

  // Typing in the search box lists every chat it matches, from all projects, newest first.
  const needle = query.trim().toLowerCase();
  const searching = needle.length > 0;
  const matches = searching
    ? sessions
        .filter((session) => !runIds.has(session.sessionId))
        .filter((session) => {
          const worktree = worktrees.find((entry) => entry.worktreeId === session.worktreeId);
          return [
            sessionTitle(session, projection?.messages, projection?.providers),
            sessionAgentName(session),
            providerDisplayName(session.provider, projection?.providers),
            projectOf(session)?.name,
            worktree?.branch,
          ].some((field) => field?.toLowerCase().includes(needle));
        })
        .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
    : [];
  const renderSearch = () => (
    <section className="sidebar-results" aria-label="Chats found">
      <h2 className="sidebar-heading">
        {matches.length === 0 ? "No chats found" : matches.length === 1 ? "1 chat" : `${matches.length} chats`}
      </h2>
      {matches.length === 0 ? (
        <p className="sidebar-results-empty">
          Nothing matches “{query.trim()}” in a chat title, agent, project, or branch.
        </p>
      ) : (
        <ul className="session-list">
          {matches.map((session) => {
            const projectId = projectOf(session)?.projectId;
            return renderSession(
              session,
              worktrees.filter((worktree) => worktree.projectId === projectId),
              undefined,
              undefined,
              false,
              noAncestors,
              false,
              true,
            );
          })}
        </ul>
      )}
    </section>
  );

  /** Up and Down move between the chats in the list, so the keyboard can walk it without Tab. */
  const moveBetweenChats = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const target = event.target as HTMLElement;
    if (!target.matches(".session-row, .shelf-row")) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".session-row, .shelf-row")];
    const index = rows.indexOf(target as HTMLButtonElement);
    const next = rows[event.key === "ArrowDown" ? index + 1 : index - 1];
    event.preventDefault();
    if (next) next.focus();
    else if (event.key === "ArrowUp") searchRef.current?.focus();
  };

  // Agents that asked for something, and chats that finished or failed out of view, from every project.
  const shelf = sessions
    .filter((session) => session.status === "waiting" || unread.has(session.sessionId))
    .sort(
      (left, right) =>
        Number(right.status === "waiting") - Number(left.status === "waiting") ||
        (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
    );
  const renderShelf = () => (
    <section className="sidebar-shelf" aria-label="Waiting on you">
      <div className="shelf-head">
        <h2 className="shelf-heading">Waiting on you</h2>
        <span className="shelf-count">{shelf.length}</span>
        {unread.size > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            className="shelf-clear"
            tooltip="Mark finished chats as seen"
            onClick={clearUnread}
          >
            Clear
          </Button>
        ) : null}
      </div>
      <ul className="shelf-list">
        {shelf.map((session) => {
          const worktree = worktrees.find((entry) => entry.worktreeId === session.worktreeId);
          const project = projects.find((entry) => entry.projectId === worktree?.projectId);
          const title = sessionAgentName(session) ?? sessionTitle(session, projection?.messages, projection?.providers);
          const tone = session.status === "waiting" ? "waiting" : session.status === "failed" ? "failed" : "done";
          const said = { waiting: "needs your answer", failed: "failed", done: "finished" }[tone];
          const threadId = session.thread?.threadId;
          return (
            <li key={session.sessionId}>
              <button
                className={`shelf-row is-${tone}${session.sessionId === activeSessionId ? " is-active" : ""}`}
                type="button"
                aria-label={`${title}, ${said}${project ? `, in ${project.name}` : ""}`}
                onClick={() => onSelectSession(session)}
              >
                <SessionAvatar session={session} size={24} />
                <span className="shelf-copy">
                  <span className="shelf-line">
                    <span className="shelf-title">{title}</span>
                    {project ? <span className="shelf-project">{project.name}</span> : null}
                  </span>
                  <span className="shelf-reason">
                    {tone === "waiting" && threadId ? (
                      <AskLine threadId={threadId} provider={session.provider} />
                    ) : tone === "failed" ? (
                      (session.thread?.errorMessage ?? session.pending?.errorMessage ?? "Failed")
                    ) : threadId ? (
                      <ReplyPreview threadId={threadId} />
                    ) : (
                      "Finished"
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );

  return (
    <aside className="sidebar" aria-label="Projects and agents" ref={asideRef}>
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
        <div className="sidebar-primary-row">
          <button
            className="btn btn-secondary sidebar-new-agent"
            type="button"
            onClick={() => onNewAgent()}
            aria-keyshortcuts={ariaShortcut(newAgentShortcut)}
          >
            <Icon name="squarePen" size={15} />
            <span>New chat</span>
            <Kbd shortcut={newAgentShortcut} />
          </button>
          <IconButton
            className="sidebar-add-project"
            label="Add project"
            tooltip="Add project"
            icon="folderPlus"
            onClick={onOpenProject}
          />
        </div>
        {projects.length > 0 ? (
          <label className="sidebar-search">
            <Icon name="search" size={13} />
            <input
              ref={searchRef}
              type="search"
              placeholder="Find a chat"
              aria-label="Find a chat"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  return;
                }
                if (event.key === "ArrowDown" || event.key === "Enter") {
                  const first = asideRef.current?.querySelector<HTMLButtonElement>(
                    ".sidebar-scroll .session-row, .sidebar-scroll .shelf-row",
                  );
                  if (!first) return;
                  event.preventDefault();
                  if (event.key === "Enter") first.click();
                  else first.focus();
                }
              }}
            />
          </label>
        ) : null}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the chat buttons inside. */}
      <div className="sidebar-scroll" onKeyDown={moveBetweenChats}>
        {projects.length === 0 ? (
          <div className="sidebar-empty">
            <p>No projects yet. Start a chat and pick its folder when you send, or add a project here.</p>
          </div>
        ) : searching ? (
          renderSearch()
        ) : (
          <>
            {/* With one project every chat is already in view, so the shelf would only repeat it. */}
            {shelf.length > 0 && listedProjects.length > 1 ? renderShelf() : null}
            {pinnedChats.length > 0 ? (
              <section className="sidebar-pinned" aria-label="Pinned chats">
                <h2 className="sidebar-heading">Pinned</h2>
                <ul className="session-list">
                  {pinnedChats.map((session) => {
                    const projectWorktrees = worktrees.filter((worktree) =>
                      worktrees.some(
                        (entry) => entry.worktreeId === session.worktreeId && entry.projectId === worktree.projectId,
                      ),
                    );
                    return renderSession(
                      session,
                      projectWorktrees,
                      undefined,
                      undefined,
                      false,
                      noAncestors,
                      false,
                      true,
                    );
                  })}
                </ul>
              </section>
            ) : null}
            {listedProjects.map((project) => {
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
              const empty = projectSessions.length === 0;
              // Sub-agents and best-of runs list under the chat they came from, in this project too.
              // Pinned chats list once, at the top of the sidebar.
              const top = projectSessions.filter(
                (session) =>
                  !runIds.has(session.sessionId) &&
                  !parents.has(session.sessionId) &&
                  !layout.chatPinned(session.sessionId),
              );
              // Past the newest few, a chat folds away once nothing about it asks to be seen.
              const older = top.filter(
                (session, index) =>
                  index >= RECENT_CHATS &&
                  (session.status === "ready" || session.status === "ended" || session.status === "failed") &&
                  session.sessionId !== activeSessionId &&
                  !unread.has(session.sessionId) &&
                  !subAgentsOf.has(session.sessionId) &&
                  !groupsBySource.has(session.sessionId),
              );
              const olderShown = olderOpen.has(project.projectId);
              const folded = new Set(older.length >= 2 && !olderShown ? older.map((session) => session.sessionId) : []);
              const shown = top.filter((session) => !folded.has(session.sessionId));
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
                  data-project-id={project.projectId}
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
                        <ProjectLantern name={project.name} state={waiting ? "waiting" : busy ? "working" : "idle"} />
                        <span className="project-name">{project.name}</span>
                        {pinned ? <Icon name="pin" size={11} className="project-pin" aria-hidden="true" /> : null}
                        <Icon name="chevronRight" size={11} className="project-chevron" />
                      </button>
                    )}
                    {open || agentCount === 0 ? null : (
                      // Folded, the project shows who is inside: the faces of its newest chats.
                      <span
                        className="project-faces"
                        title={`${agentCount === 1 ? "1 chat" : `${agentCount} chats`}, ${projectWorktrees.length === 1 ? "1 worktree" : `${projectWorktrees.length} worktrees`}`}
                      >
                        {top.slice(0, 3).map((session) => (
                          <SessionAvatar key={session.sessionId} session={session} size={15} quietStart />
                        ))}
                        {agentCount > 3 ? <span className="project-faces-more">+{agentCount - 3}</span> : null}
                        <span className="sr-only">{agentCount}</span>
                      </span>
                    )}
                    <IconButton
                      className={`project-action${empty || project.projectId === currentProjectId ? " is-shown" : ""}`}
                      label={`New chat in ${project.name}`}
                      tooltip="New chat here"
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
                      {empty ? (
                        <p className="sidebar-note">
                          No chats yet.{" "}
                          <button
                            className="sidebar-note-action"
                            type="button"
                            aria-label={`Start a chat in ${project.name}`}
                            onClick={() => onNewAgent(project)}
                          >
                            Start one
                          </button>
                        </p>
                      ) : (
                        <ul className="session-list">
                          {shown.map((session) => {
                            // Every chat is one card. A chat in a worktree of its own names its branch on the card.
                            return renderSession(
                              session,
                              projectWorktrees,
                              groupsBySource.get(session.sessionId),
                              undefined,
                              firstForWorktree(session),
                              noAncestors,
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
                      {older.length >= 2 ? (
                        <div className="worktree-heading">
                          <button
                            className="older-toggle"
                            type="button"
                            aria-expanded={olderShown}
                            onClick={() =>
                              setOlderOpen((current) => {
                                const next = new Set(current);
                                if (!next.delete(project.projectId)) next.add(project.projectId);
                                return next;
                              })
                            }
                          >
                            <Icon name="chevronRight" size={11} className="worktree-toggle-chevron" />
                            {olderShown ? "Hide older chats" : `${older.length} older chats`}
                          </button>
                        </div>
                      ) : null}
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
            {quietProjects.length > 0 ? (
              <section className="sidebar-more" aria-label="Projects without agents">
                <button
                  className="sidebar-more-toggle"
                  type="button"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreOpen((value) => !value)}
                >
                  <Icon name="chevronRight" size={11} className="sidebar-more-chevron" />
                  {quietProjects.length} more projects
                </button>
                {moreOpen ? (
                  <ul className="sidebar-more-list">
                    {quietProjects.map((project) => (
                      <li key={project.projectId}>
                        <button
                          className="sidebar-more-project"
                          type="button"
                          title={project.path}
                          aria-label={`Start a chat in ${project.name}`}
                          onClick={() => onNewAgent(project)}
                          onContextMenu={(event) =>
                            openContextMenu(event, `${project.name} actions`, () => projectContextItems(project))
                          }
                        >
                          <Icon name="folder" size={14} />
                          <span className="project-name">{project.name}</span>
                          <Icon name="agentNew" size={13} className="sidebar-more-start" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}
            {archivedChats.length > 0 ? (
              <section className="sidebar-more sidebar-archive" aria-label="Archived chats">
                <button
                  className="sidebar-more-toggle"
                  type="button"
                  aria-expanded={archiveOpen}
                  onClick={() => setArchiveOpen((value) => !value)}
                >
                  <Icon name="chevronRight" size={11} className="sidebar-more-chevron" />
                  Archived · {archivedChats.length}
                </button>
                {archiveOpen ? (
                  <ul className="session-list">
                    {archivedChats.map((session) =>
                      renderSession(
                        session,
                        worktrees.filter((worktree) =>
                          worktrees.some(
                            (entry) =>
                              entry.worktreeId === session.worktreeId && entry.projectId === worktree.projectId,
                          ),
                        ),
                        undefined,
                        undefined,
                        false,
                        noAncestors,
                        false,
                        true,
                      ),
                    )}
                  </ul>
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </div>
      <SidebarPlanLimits
        providers={projection?.providers}
        accounts={accounts}
        now={now}
        currentKey={activeSession ? limitKey(activeSession.provider, sessionAccountId(activeSession)) : undefined}
        onOpenSettings={() => onOpenSettings("usage")}
      >
        {({ line, panel }) => (
          <div className="sidebar-bottom">
            {panel}
            <div className="sidebar-footer">
              <span className="sr-only" role="status">
                {projection ? "Runtime connected" : ""}
              </span>
              {!projection ? (
                <span className="sidebar-waiting">
                  <span className="connection-dot" aria-hidden="true" />
                  Waiting for runtime
                </span>
              ) : (
                (line ?? (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon="settings"
                    className="sidebar-settings"
                    tooltip="Settings"
                    shortcut={settingsShortcut}
                    onClick={() => onOpenSettings()}
                  >
                    Settings
                  </Button>
                ))
              )}
              <IconButton
                className="sidebar-usage"
                label="Usage"
                tooltip="Usage and cost"
                icon="gauge"
                onClick={onOpenUsage}
              />
              {projection && !line ? null : (
                <IconButton
                  label="Settings"
                  icon="settings"
                  shortcut={settingsShortcut}
                  onClick={() => onOpenSettings()}
                />
              )}
              <IconButton
                className="sidebar-help"
                label="Help"
                tooltip="Help and diagnostics"
                icon="help"
                onClick={onOpenHelp}
              />
            </div>
          </div>
        )}
      </SidebarPlanLimits>
      {contextMenu ? <Menu request={contextMenu} onClose={() => setContextMenu(undefined)} /> : null}
      {renderProjectConfirm()}
      {huddleMenu ? <Menu request={huddleMenu} onClose={() => setHuddleMenu(undefined)} /> : null}
    </aside>
  );
}

/**
 * A project's lantern: a small ring in the project's own colour that says how the project is doing. Hollow
 * while nothing runs, lit and softly glowing while an agent in it works, amber when something in it needs
 * the person.
 */
function ProjectLantern({ name, state }: { name: string; state: "idle" | "working" | "waiting" }) {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  return (
    <span
      className={`project-lantern is-${state}`}
      style={{ "--lantern-hue": hash % 360 } as CSSProperties}
      aria-hidden="true"
    />
  );
}
