import type { Account, ProjectProjection, RuntimeProjection, WorktreeProjection } from "@zli-v2/contracts";
import { lazy, type MouseEvent, type ReactNode, Suspense, useEffect, useRef, useState } from "react";

import { accountLabel, sessionAccountId } from "../accounts/accounts.js";
import { providerDisplayName } from "../agent/providers.js";
import { huddleMarkText, sessionHuddles } from "../huddle/huddles.js";
import { trackDescription } from "../review/branches.js";
import { type PullRequestEntry, recordPullRequest, refreshPullRequest } from "../review/pullRequestStore.js";
import { useRuntime } from "../runtime/RuntimeProvider.js";
import type { RunGroup } from "../sessions/bestOf.js";
import {
  type AgentSession,
  relativeTime,
  sessionAgentName,
  sessionStatusLabel,
  sessionTitle,
} from "../sessions/sessions.js";
import { Button } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { Menu, MenuButton, type MenuItem, type MenuRequest } from "../ui/Menu.js";
import { ProviderMark } from "../ui/ProviderMark.js";
import {
  type BranchStage,
  branchStage,
  branchStages,
  changedFileCount,
  diffTotals,
  foldedStages,
  pullRequestMark,
  pullRequestProblems,
  railBadge,
  reviewDetail,
  sessionNeedsPerson,
  shortBranchName,
  waitingQuestion,
} from "./sidebarStages.js";

const MergePullRequestDialog = lazy(() =>
  import("../review/MergePullRequestDialog.js").then((module) => ({ default: module.MergePullRequestDialog })),
);

/** The status a branch row names when several agents share it: the one that most needs the person. */
const statusOrder: readonly AgentSession["status"][] = ["waiting", "failed", "working", "starting", "preparing"];

type Tone = "waiting" | "working" | "failed" | "ready" | "warning" | "quiet";

type BranchRow = {
  worktree: WorktreeProjection;
  project: ProjectProjection;
  stage: BranchStage;
  /** Every agent in the worktree except best-of runs, which list under the chat they came from. */
  agents: AgentSession[];
  /** The agents the row expands to: sub-agents nest under the agent that started them. */
  topAgents: AgentSession[];
  /** The agent whose question or failure the row shows. Clicking the row goes to it. */
  urgent: AgentSession | undefined;
  /** What the column before the name shows: a spinner while something runs, otherwise a colored dot. */
  status: Tone;
  detail: { text: string; tone: Tone } | undefined;
  problem: string | undefined;
  entry: PullRequestEntry | undefined;
  totals: { additions: number; deletions: number } | undefined;
  needsAttention: boolean;
  /** What the worktree itself is doing or what stopped it, such as Setting up or Setup failed. */
  statusText: string;
  newest: string;
};

export type BranchesViewProps = {
  projection: RuntimeProjection | undefined;
  /** In the order they list: pinned first. */
  projects: readonly ProjectProjection[];
  sessions: readonly AgentSession[];
  /** Running sessions without a tile on the board. */
  backgroundSessionIds: ReadonlySet<string>;
  accounts: readonly Account[] | undefined;
  activeSessionId: string | undefined;
  activeWorktreeId: string | undefined;
  selectedProjectId: string | undefined;
  /** The project the list is narrowed to. Undefined means all of them. */
  filterProject: ProjectProjection | undefined;
  chooseProject(projectId: string | undefined): void;
  renamingProjectId: string | undefined;
  renderProjectRename(project: ProjectProjection): ReactNode;
  runIds: ReadonlySet<string>;
  runGroups: readonly RunGroup[];
  parents: ReadonlyMap<string, AgentSession>;
  groupsBySource: ReadonlyMap<string, readonly RunGroup[]>;
  prEntries: ReadonlyMap<string, PullRequestEntry>;
  /** Worktree facts the tree style already works out. */
  worktreeState(worktree: WorktreeProjection): {
    statusText: string;
    needsAttention: boolean;
    needsApproval: boolean;
    problem: string | undefined;
  };
  renderSession(
    session: AgentSession,
    projectWorktrees: readonly WorktreeProjection[],
    groups: readonly RunGroup[] | undefined,
  ): ReactNode;
  renderGroup(group: RunGroup, projectWorktrees: readonly WorktreeProjection[]): ReactNode;
  /** What went wrong with the worktree, its fixes, and the delete confirm. */
  renderWorktreeAlert(worktree: WorktreeProjection): ReactNode;
  branchMenuItems(worktree: WorktreeProjection, soleAgent: AgentSession | undefined): MenuItem[];
  projectMenuItems(project: ProjectProjection): MenuItem[];
  openContextMenu(event: MouseEvent<HTMLElement>, label: string, items: () => MenuItem[]): void;
  onSelectSession(session: AgentSession): void;
  onSelectWorktree(worktree: WorktreeProjection): void;
  onNewAgent(project?: ProjectProjection): void;
  onCreateWorktree(project?: ProjectProjection): void;
  onOpenProject(): void;
  /** Opens the Huddle panel on a huddle. Without it rows show no huddle marks. */
  onOpenHuddle: ((huddleId: string) => void) | undefined;
  /** The sidebar's clock, so row ages move on together. */
  now: number;
};

/** Each row is a branch, sorted by how close it is to shipping. */
export function BranchesView({
  projection,
  projects,
  sessions,
  backgroundSessionIds,
  accounts,
  activeSessionId,
  activeWorktreeId,
  selectedProjectId,
  filterProject,
  chooseProject,
  renamingProjectId,
  renderProjectRename,
  runIds,
  runGroups,
  parents,
  groupsBySource,
  prEntries,
  worktreeState,
  renderSession,
  renderGroup,
  renderWorktreeAlert,
  branchMenuItems,
  projectMenuItems,
  openContextMenu,
  onSelectSession,
  onSelectWorktree,
  onNewAgent,
  onCreateWorktree,
  onOpenProject,
  onOpenHuddle,
  now,
}: BranchesViewProps) {
  const { dispatch } = useRuntime();
  const [doneOpen, setDoneOpen] = useState(false);
  const doneRef = useRef<HTMLElement>(null);
  // Done rests at the foot of a long list, so opening it brings its rows into view.
  useEffect(() => {
    if (doneOpen) doneRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [doneOpen]);
  const [projectMenu, setProjectMenu] = useState<MenuRequest>();
  /** Rows the person opened or closed. The rest open when selected or holding best-of runs. */
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [merging, setMerging] = useState<string>();

  // A project just added has no branches yet, so the list goes to it and offers to start an agent.
  useEffect(() => {
    if (selectedProjectId) chooseProject(selectedProjectId);
  }, [selectedProjectId, chooseProject]);

  const allWorktrees = projection?.worktrees ?? [];
  const shownProjects = filterProject ? [filterProject] : projects;
  const projectById = new Map(shownProjects.map((project) => [project.projectId as string, project]));

  const rows: BranchRow[] = [];
  for (const worktree of allWorktrees) {
    const project = projectById.get(worktree.projectId);
    if (!project) continue;
    const inWorktree = sessions.filter((session) => session.worktreeId === worktree.worktreeId);
    const agents = inWorktree.filter((session) => !runIds.has(session.sessionId));
    // A best-of run's worktree lists under the chat the run came from.
    if (inWorktree.length > 0 && agents.length === 0) continue;
    // A project's own checkout with nobody in it holds no work to list. Starting an agent there stays in the project menu.
    if (worktree.kind === "checkout" && inWorktree.length === 0 && worktree.status === "ready") continue;
    const topAgents = agents.filter((session) => {
      const parent = parents.get(session.sessionId);
      return !parent || parent.worktreeId !== worktree.worktreeId;
    });
    const review = projection?.reviews?.find((entry) => entry.worktreeId === worktree.worktreeId);
    const entry = prEntries.get(worktree.worktreeId);
    const state = worktreeState(worktree);
    const pullRequest = entry?.status?.pullRequest;
    const stage = branchStage({
      git: project.git !== false,
      sessions: agents,
      worktreeBusy: worktree.status !== "ready" || state.needsAttention,
      worktreeNeedsPerson: state.needsAttention,
      changedFiles: changedFileCount(review, entry),
      pullRequest,
    });
    const liveStatus = statusOrder.find((status) => agents.some((session) => session.status === status));
    const held = stage === "review" && pullRequest ? reviewDetail(pullRequest) : undefined;
    const heldTone: Tone = held?.tone === "danger" ? "failed" : held?.tone === "warning" ? "warning" : "quiet";
    const worktreeTone: Tone =
      worktree.status === "failed"
        ? "failed"
        : state.needsApproval
          ? "waiting"
          : state.needsAttention
            ? "failed"
            : worktree.status === "cancelled"
              ? "quiet"
              : "working";
    const worktreeBusy = worktree.status !== "ready" || state.needsAttention;
    // A spinner means something is running right now, so an idle branch with changes keeps a plain dot.
    const liveTone: Tone | undefined =
      liveStatus === "waiting" ? "waiting" : liveStatus === "failed" ? "failed" : liveStatus ? "working" : undefined;
    const status: Tone = worktreeBusy
      ? worktreeTone
      : (liveTone ?? (stage === "ready" ? "ready" : stage === "review" ? heldTone : "quiet"));
    const waiting = agents.filter((session) => session.status === "waiting");
    // The agent whose words the row shows is the one a click on the row opens.
    const urgent =
      waiting.find((session) => waitingQuestion(session, projection?.requests)) ??
      waiting[0] ??
      agents.find(sessionNeedsPerson);
    const asking = urgent ? waitingQuestion(urgent, projection?.requests) : undefined;
    // The status column already says Working, so only what the person should read gets words.
    // The note under the row already says what went wrong, so the row does not say Failed above it.
    const detail: BranchRow["detail"] = worktreeBusy
      ? state.problem
        ? undefined
        : { text: state.statusText, tone: worktreeTone }
      : liveStatus === "waiting"
        ? { text: asking ?? sessionStatusLabel.waiting, tone: "waiting" }
        : liveStatus === "failed"
          ? { text: sessionStatusLabel.failed, tone: "failed" }
          : liveStatus
            ? undefined
            : held
              ? { text: held.text, tone: heldTone }
              : pullRequest?.state === "MERGED"
                ? { text: "Merged", tone: "quiet" }
                : undefined;
    rows.push({
      worktree,
      project,
      stage,
      agents,
      topAgents,
      urgent,
      status,
      detail,
      problem: state.problem,
      entry,
      totals: diffTotals(review),
      needsAttention: state.needsAttention,
      statusText: state.statusText,
      newest: agents.reduce((latest, agent) => {
        const created = agent.createdAt ?? "";
        return created > latest ? created : latest;
      }, ""),
    });
  }
  rows.sort((left, right) => right.newest.localeCompare(left.newest));

  // A best-of group whose source chat is gone has no row to sit under.
  const orphanGroups = runGroups.filter(
    (group) =>
      !sessions.some((session) => session.sessionId === group.sourceSessionId) &&
      sessions.some((session) => {
        if (!group.sessionIds.includes(session.sessionId)) return false;
        const worktree = allWorktrees.find((entry) => entry.worktreeId === session.worktreeId);
        return worktree ? projectById.has(worktree.projectId) : false;
      }),
  );

  const rowEntries = rows.map((row) => row.entry);
  const problems = pullRequestProblems(rowEntries);
  const checking = rowEntries.some((entry) => entry?.checking && !entry.status);

  const openRow = (row: BranchRow) => {
    const open =
      row.urgent ??
      row.agents.find((session) => session.sessionId === activeSessionId) ??
      [...row.agents].sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))[0];
    if (open) onSelectSession(open);
    else onSelectWorktree(row.worktree);
  };

  // Short names read like the concept, but two rows must never look like the same branch.
  const shortNameCounts = new Map<string, number>();
  for (const { worktree } of rows) {
    const short = shortBranchName(worktree.branch);
    shortNameCounts.set(short, (shortNameCounts.get(short) ?? 0) + 1);
  }

  /** What an agent is for: its first message, else the name the person gave it. Undefined for a terminal agent with neither. */
  const taskTitle = (session: AgentSession) => {
    const title = sessionTitle(session, projection?.messages, projection?.providers);
    // An untitled chat is "New chat" and an untitled terminal agent its harness's name; neither says the task.
    const untitled =
      session.mode === "chat" ? "New chat" : providerDisplayName(session.provider, projection?.providers);
    if (title !== untitled) return title;
    return sessionAgentName(session);
  };

  const renderRow = (row: BranchRow, showProject: boolean) => {
    const { worktree, agents, topAgents, entry, totals, detail, status, stage } = row;
    const active = worktree.worktreeId === activeWorktreeId;
    const sole = topAgents.length === 1 && agents.length === 1 ? topAgents[0] : undefined;
    // A sub-agent on another branch has a row of its own, so only best-of runs still nest under a lone agent.
    const soleAgent = sole && (groupsBySource.get(sole.sessionId)?.length ?? 0) === 0 ? sole : undefined;
    const expandable = agents.length > 0 && !soleAgent;
    const holdsRuns = topAgents.some((session) => (groupsBySource.get(session.sessionId)?.length ?? 0) > 0);
    const expanded = expandable && (toggled.get(worktree.worktreeId) ?? (active || holdsRuns));
    const pullRequest = entry?.status?.pullRequest;
    const noGit = row.project.git === false;
    const name = noGit ? row.project.name : worktree.branch;
    const short = shortBranchName(worktree.branch);
    const shownName = noGit || (shortNameCounts.get(short) ?? 0) > 1 ? name : short;
    const mayMerge = stage === "ready" && pullRequest?.state === "OPEN";
    const menu = () => branchMenuItems(worktree, soleAgent);
    const prMark = pullRequest && pullRequest.state !== "CLOSED" ? pullRequestMark(pullRequest) : undefined;
    const agentCount = agents.length === 1 ? "1 agent" : `${agents.length} agents`;
    const agentWords = (session: AgentSession) =>
      sessionAgentName(session) ?? sessionTitle(session, projection?.messages, projection?.providers);
    const lead = topAgents.length === 1 ? topAgents[0] : undefined;
    const nested = agents.length - topAgents.length;
    const agentLabel = lead
      ? nested > 0
        ? `${agentWords(lead)}, ${nested === 1 ? "1 sub-agent" : `${nested} sub-agents`}`
        : agentWords(lead)
      : agents.length > 0
        ? agentCount
        : undefined;
    // The row is titled by what it is for. The agent that opened the branch speaks for it, so the title stays put.
    const opener =
      lead ?? [...topAgents].sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""))[0];
    const task = opener ? taskTitle(opener) : undefined;
    const title = task ?? shownName;
    // While several projects are listed, the second line opens with where the row is, unless the title already says it.
    const projectLabel = showProject && !(noGit && !task) ? row.project.name : undefined;
    // A lead in this worktree already nests its sub-agents, so only one started from another branch says who.
    const starter = lead ? parents.get(lead.sessionId) : undefined;
    const startedBy = starter ? `Started by ${agentWords(starter)}` : undefined;
    const background = soleAgent && backgroundSessionIds.has(soleAgent.sessionId) ? "Background" : undefined;
    const readyText = mayMerge && pullRequest ? "Ready to merge" : undefined;
    // The second line says what needs reading first. Otherwise it says where the work is: the branch, unless the
    // title already is the branch, in which case it says who works there.
    const where = task && !noGit ? shownName : undefined;
    // What went wrong is spelled out under the row, so this line only names it.
    // A branch ready to merge says so with its pull request's check and the Merge button, so it needs no words.
    const lineText =
      detail?.text ??
      (row.problem ? row.statusText : undefined) ??
      (mayMerge ? undefined : (where ?? (task ? undefined : (agentLabel ?? "No agents"))));
    const lineTone = detail ? detail.tone : row.problem ? "failed" : undefined;
    const account = soleAgent ? accountLabel(accounts, sessionAccountId(soleAgent)) : undefined;
    const upstream = entry?.status?.branch === worktree.branch ? entry.status.upstream : undefined;
    const latest = agents.reduce((newest, agent) => {
      const at = agent.updatedAt ?? agent.createdAt ?? "";
      return at > newest ? at : newest;
    }, "");
    const age = relativeTime(latest || undefined, now);
    const huddles = onOpenHuddle
      ? [
          ...new Map(
            agents
              .flatMap((session) => (projection ? sessionHuddles(projection, session) : []))
              .map((huddle) => [huddle.huddleId, huddle]),
          ).values(),
        ]
      : [];
    const firstHuddle = huddles[0];
    const marks =
      agents.length > 0 ? (
        <span className="ship-marks">
          {agents.slice(0, 2).map((session) => (
            <ProviderMark provider={session.provider} size={12} key={session.sessionId} />
          ))}
          {agents.length > 2 ? <span className="ship-more-agents">+{agents.length - 2}</span> : null}
        </span>
      ) : null;
    const toggleLabel = `${expanded ? "Hide" : "Show"} ${agentCount}`;
    const showPr = prMark && pullRequest;
    return (
      <li
        className={`ship-entry${active && !expanded ? " is-active" : ""}`}
        key={worktree.worktreeId}
        data-worktree-id={worktree.worktreeId}
        data-stage={stage}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Shift+F10 or the Menu key on the focused row opens this menu too. */}
        <div className="ship-head" onContextMenu={(event) => openContextMenu(event, `${name} actions`, menu)}>
          {/* The whole row opens the branch. It lies under the content so Merge and the agent marks can be real buttons of their own. */}
          <button
            className="ship-row"
            type="button"
            aria-label={[
              title,
              title === name ? undefined : name,
              status === "working" ? sessionStatusLabel.working : undefined,
              detail?.text ?? readyText ?? row.problem,
              row.project.name === name ? undefined : row.project.name,
              prMark && pullRequest ? `pull request ${pullRequest.number}, ${prMark.label}` : undefined,
              startedBy,
              background ? "in the background" : undefined,
            ]
              .filter(Boolean)
              .join(", ")}
            aria-current={active ? "true" : undefined}
            title={[
              title === name ? undefined : title,
              name,
              detail?.text ?? row.problem,
              row.project.name === name ? undefined : row.project.name,
              worktree.path,
              totals ? `+${totals.additions} -${totals.deletions} lines` : undefined,
              startedBy,
              background ? "Running in the background" : undefined,
              account ? `Account: ${account}` : undefined,
              upstream ? trackDescription(upstream) : undefined,
            ]
              .filter(Boolean)
              .join("\n")}
            onClick={() => openRow(row)}
          />
          <div className="ship-line">
            <span className="ship-status" aria-hidden="true">
              {status === "working" ? <span className="spinner" /> : <span className={`ship-dot is-${status}`} />}
            </span>
            <span className={`ship-name${task ? "" : " is-branch"}${noGit && !task ? " is-folder" : ""}`}>{title}</span>
            {age ? <span className="ship-time">{age}</span> : null}
          </div>
          <div className="ship-sub">
            {projectLabel ? <span className="ship-project">{projectLabel}</span> : null}
            {showPr ? (
              <span className={`ship-pr is-${prMark.tone}`}>
                <Icon name={prMark.icon} size={12} />#{pullRequest.number}
              </span>
            ) : null}
            <span className={`ship-text${lineTone ? ` is-${lineTone}` : ""}`}>
              {lineText === where && where ? <Icon name="branch" size={12} /> : null}
              {lineText ? <span className="ship-text-words">{lineText}</span> : null}
            </span>
            {mayMerge ? (
              <Button
                size="sm"
                className="ship-merge"
                aria-label={`Merge ${worktree.branch}`}
                onClick={() => setMerging(worktree.worktreeId)}
              >
                Merge
              </Button>
            ) : null}
            {firstHuddle && onOpenHuddle ? (
              <button
                className={`ship-huddle${huddles.some((huddle) => huddle.paused) ? " is-paused" : ""}`}
                type="button"
                aria-label={`${huddleMarkText(huddles)}. Open ${firstHuddle.name}`}
                data-tooltip={huddleMarkText(huddles)}
                onClick={() => onOpenHuddle(firstHuddle.huddleId)}
              >
                <Icon name="users" size={13} />
              </button>
            ) : null}
            {expandable ? (
              <button
                className="ship-marks-toggle"
                type="button"
                aria-expanded={expanded}
                aria-label={toggleLabel}
                data-tooltip={toggleLabel}
                onClick={() => setToggled((current) => new Map(current).set(worktree.worktreeId, !expanded))}
              >
                {marks}
                <Icon name="chevronRight" size={11} />
              </button>
            ) : mayMerge ? null : (
              marks
            )}
          </div>
          <span className="row-more">
            <MenuButton label="Branch actions" tooltip="More" size="xs" items={menu} />
          </span>
        </div>
        {renderWorktreeAlert(worktree)}
        {expanded ? (
          <ul className="session-list ship-agents">
            {topAgents.map((session) => renderSession(session, allWorktrees, groupsBySource.get(session.sessionId)))}
          </ul>
        ) : null}
        {merging === worktree.worktreeId && pullRequest?.state === "OPEN" ? (
          <Suspense fallback={null}>
            <MergePullRequestDialog
              worktree={worktree}
              pullRequest={pullRequest}
              onClose={() => setMerging(undefined)}
              onMerged={(result) => {
                setMerging(undefined);
                recordPullRequest(worktree.worktreeId, result.pullRequest);
              }}
              onAutoMerge={(result) => {
                setMerging(undefined);
                recordPullRequest(worktree.worktreeId, result.pullRequest);
                void refreshPullRequest(dispatch, worktree.worktreeId, true);
              }}
            />
          </Suspense>
        ) : null}
      </li>
    );
  };

  /** Each project carries a dot while an agent there is waiting or working, so the list says where the work is. */
  const projectItems = (): MenuItem[] => [
    { label: "All projects", checked: !filterProject, run: () => chooseProject(undefined) },
    ...(projects.length > 0 ? [{ separator: true } as const] : []),
    ...projects.map((project): MenuItem => {
      const ids = new Set<string>(
        allWorktrees.filter((entry) => entry.projectId === project.projectId).map((entry) => entry.worktreeId),
      );
      const badge = railBadge(sessions.filter((session) => ids.has(session.worktreeId)));
      return {
        id: project.projectId,
        label: project.name,
        media: badge ? <span className={`ship-menu-dot is-${badge.tone}`} /> : undefined,
        title: badge ? `${badge.count} ${badge.tone}` : undefined,
        checked: filterProject?.projectId === project.projectId,
        run: () => chooseProject(project.projectId),
      };
    }),
    { separator: true },
    { label: "Add project", icon: "folderPlus", run: onOpenProject },
  ];

  // Most urgent first, then the newest. Merged and untouched branches have nothing left to do, so they wait in Done.
  const liveRows = branchStages
    .filter((stage) => !foldedStages.has(stage))
    .flatMap((stage) => rows.filter((row) => row.stage === stage));
  const doneRows = rows.filter((row) => foldedStages.has(row.stage));
  // Done still lists the branch the person is in.
  const shownDone = doneOpen ? doneRows : doneRows.filter((row) => row.worktree.worktreeId === activeWorktreeId);
  const showProjects = !filterProject && projects.length > 1;

  const filterName = filterProject?.name ?? "All projects";
  // A folder without Git has no branches to sort, so picking one lists its agents with nothing wrapped around them.
  const folderView = filterProject?.git === false;
  const folderAgents = folderView ? rows.flatMap((row) => row.topAgents) : [];

  return (
    <>
      <div className="ship-filter">
        {filterProject && renamingProjectId === filterProject.projectId ? (
          renderProjectRename(filterProject)
        ) : (
          <button
            className="btn btn-secondary ship-project-trigger"
            type="button"
            aria-label={`Project filter: ${filterName}`}
            aria-haspopup="menu"
            aria-expanded={projectMenu !== undefined}
            onClick={(event) => {
              if (projectMenu) {
                setProjectMenu(undefined);
                return;
              }
              const anchor = event.currentTarget;
              const rect = anchor.getBoundingClientRect();
              setProjectMenu({
                x: rect.left,
                y: rect.bottom + 6,
                align: "start",
                anchor,
                label: "Projects",
                items: projectItems(),
              });
            }}
          >
            <span className="ship-project-name">{filterName}</span>
            <Icon name="chevronDown" size={12} />
          </button>
        )}
        {/* A folder without Git can never have a worktree, so it gets no button to explain away. */}
        {folderView ? null : (
          <Button
            className="btn-icon"
            icon="branch"
            aria-label="Create worktree"
            tooltip={projects.length === 0 ? "Add a project first" : "New worktree"}
            disabled={projects.length === 0}
            onClick={() => onCreateWorktree(filterProject)}
          />
        )}
        {filterProject ? (
          <MenuButton
            label={`${filterProject.name} actions`}
            tooltip="More"
            variant="secondary"
            items={() => projectMenuItems(filterProject)}
          />
        ) : null}
        {projectMenu ? <Menu request={projectMenu} onClose={() => setProjectMenu(undefined)} /> : null}
      </div>
      <div className="sidebar-scroll ship-scroll">
        {projects.length === 0 ? (
          <div className="sidebar-empty">
            <p>
              Add a Git repository to start. Each agent gets its own terminal, and its own worktree if you want one.
            </p>
            <button className="sidebar-note-action" type="button" onClick={onOpenProject}>
              Add a project
            </button>
          </div>
        ) : folderAgents.length === 0 && (folderView || (liveRows.length === 0 && orphanGroups.length === 0)) ? (
          <p className="sidebar-note ship-empty">
            {folderView ? "No agents yet." : "No branches yet."}{" "}
            <button
              className="sidebar-note-action"
              type="button"
              aria-label={filterProject ? `Start an agent in ${filterProject.name}` : "Start an agent"}
              onClick={() => onNewAgent(filterProject)}
            >
              Start one
            </button>
          </p>
        ) : null}
        {folderView && folderAgents.length > 0 ? (
          <section className="ship-stage" aria-label="Agents">
            <h2 className="ship-stage-heading">
              Agents <span className="ship-stage-count">{folderAgents.length}</span>
            </h2>
            {rows.map((row) => (
              <div key={row.worktree.worktreeId}>{renderWorktreeAlert(row.worktree)}</div>
            ))}
            <ul className="session-list ship-folder-agents">
              {folderAgents.map((session) =>
                renderSession(session, allWorktrees, groupsBySource.get(session.sessionId)),
              )}
            </ul>
          </section>
        ) : null}
        {folderView ? null : (
          <section className="ship-stage" aria-label="Branches">
            {liveRows.length > 0 || orphanGroups.length > 0 ? (
              <ul className="ship-list">
                {liveRows.map((row) => renderRow(row, showProjects))}
                {orphanGroups.map((group) => (
                  <li className="session-entry is-orphan-group" key={group.groupId}>
                    {renderGroup(group, allWorktrees)}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        )}
        {checking ? <p className="sidebar-note ship-note">Checking pull requests</p> : null}
        {problems.map((problem) => (
          <p className="sidebar-note ship-note" role="status" key={problem}>
            Merge needs GitHub: {problem}
          </p>
        ))}
        {/* Finished work rests at the foot of the list, out of the way, and opens in place. */}
        {!folderView && doneRows.length > 0 ? (
          <section className="ship-stage ship-done" aria-label="Done" ref={doneRef}>
            <button
              className="ship-fold"
              type="button"
              aria-expanded={doneOpen}
              onClick={() => setDoneOpen((current) => !current)}
            >
              Done <span className="ship-stage-count">{doneRows.length}</span>
              <Icon name="chevronRight" size={12} />
            </button>
            {shownDone.length > 0 ? (
              <ul className="ship-list">{shownDone.map((row) => renderRow(row, showProjects))}</ul>
            ) : null}
          </section>
        ) : null}
      </div>
    </>
  );
}
