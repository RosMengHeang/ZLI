import { useState, type CSSProperties } from "react";
import {
  IconFolder,
  IconFolderOpen,
  IconGit,
  IconHelp,
  IconMore,
  IconPlus,
  IconSettings,
  IconTerminal,
  TaxzyMark,
} from "./AppIcons";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ProviderIcon } from "./ProviderIcon";
import { StatusBadge } from "./StatusBadge";
import {
  agentBelongsToProject,
  workspaceRootKey,
  type WorkspaceAgentResume,
  type WorkspaceRecord,
} from "../lib/workspaceRegistry";
import { APP_SHORTCUTS } from "../lib/platform";
import { projectExpansionAfterSelection, projectHoverDetails } from "../lib/sidebarPresentation";
import { useAgentStore } from "../stores/agentStore";
import { useLayoutStore } from "../stores/layoutStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useUiStore } from "../stores/uiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useAttentionStore } from "../stores/attentionStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTeamStore } from "../stores/teamStore";
import type { Agent } from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function savedAgentMatches(agent: Agent, recipe: WorkspaceAgentResume): boolean {
  return agent.resumeId === recipe.resumeId || (agent.name === recipe.name && agent.provider === recipe.provider);
}

export function Sidebar() {
  const agentMap = useAgentStore((state) => state.agents);
  const agents = Object.values(agentMap);
  const terminalSessions = useTerminalStore((state) => state.sessions);
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const selectAgent = useAgentStore((state) => state.selectAgent);
  const removeAndStopAgent = useAgentStore((state) => state.removeAndStop);
  const project = useProjectStore((state) => state.project);
  const loading = useProjectStore((state) => state.loading);
  const openFromDialog = useProjectStore((state) => state.openFromDialog);
  const openFromPath = useProjectStore((state) => state.openFromPath);
  const setAddAgentOpen = useUiStore((state) => state.setAddAgentOpen);
  const setBrowserOpen = useUiStore((state) => state.setBrowserOpen);
  const setHelpOpen = useUiStore((state) => state.setHelpOpen);
  const setPreferencesOpen = useUiStore((state) => state.setPreferencesOpen);
  const setWorktreeOpen = useUiStore((state) => state.setWorktreeOpen);
  const setWorktreeProjectRoot = useUiStore((state) => state.setWorktreeProjectRoot);
  const toggleGitPanel = useLayoutStore((state) => state.toggleGitPanel);
  const addLeaf = useLayoutStore((state) => state.addLeaf);
  const createSession = useTerminalStore((state) => state.createSession);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeProjectRoot = useWorkspaceStore((state) => state.activeProjectRoot);
  const expandedProjectRoots = useWorkspaceStore((state) => state.expandedProjectRoots);
  const setActiveProject = useWorkspaceStore((state) => state.setActiveProject);
  const toggleExpanded = useWorkspaceStore((state) => state.toggleExpanded);
  const forgetAgent = useWorkspaceStore((state) => state.forgetAgent);
  const forgetAgents = useWorkspaceStore((state) => state.forgetAgents);
  const [projectSearch, setProjectSearch] = useState("");
  const attentionRecords = useAttentionStore((state) => state.records);
  const restoredAgents = useSessionStore((state) => state.agents);
  const teamAgents = useTeamStore((state) => state.agents);
  const resumeAgent = useSessionStore((state) => state.resumeAgent);

  const filteredWorkspaces = projectSearch.trim()
    ? workspaces.filter((workspace) =>
        `${workspace.project.name} ${workspace.project.path}`.toLocaleLowerCase().includes(projectSearch.trim().toLocaleLowerCase()),
      )
    : workspaces;

  function isActive(workspace: WorkspaceRecord): boolean {
    return workspaceRootKey(workspace.root) === workspaceRootKey(activeProjectRoot ?? "");
  }

  function isExpanded(workspace: WorkspaceRecord): boolean {
    return expandedProjectRoots.some((root) => workspaceRootKey(root) === workspaceRootKey(workspace.root));
  }

  async function openWorkspace(workspace: WorkspaceRecord): Promise<boolean> {
    if (!isActive(workspace)) {
      const opened = await openFromPath(workspace.project.path);
      if (!opened) return false;
    }
    setActiveProject(workspace.root);
    if (!isExpanded(workspace)) toggleExpanded(workspace.root);
    setBrowserOpen(false);
    toggleGitPanel(false);
    return true;
  }

  async function onProjectClick(workspace: WorkspaceRecord): Promise<void> {
    const active = isActive(workspace);
    const expanded = isExpanded(workspace);
    const nextExpanded = projectExpansionAfterSelection({ active, expanded });
    if (active) {
      if (nextExpanded !== expanded) toggleExpanded(workspace.root);
      return;
    }
    await openWorkspace(workspace);
  }

  async function onOpenProject(): Promise<void> {
    await openFromDialog();
  }

  async function onAgentClick(workspace: WorkspaceRecord, agent: Agent | null): Promise<void> {
    const opened = await openWorkspace(workspace);
    if (opened && agent) selectAgent(agent.id);
  }

  async function copyText(value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
  }

  async function openProjectTerminal(workspace: WorkspaceRecord): Promise<void> {
    if (!await openWorkspace(workspace)) return;
    const session = await createSession({ cwd: workspace.project.path, cols: 80, rows: 24, title: "Terminal" });
    addLeaf(session.id);
  }

  function focusAgent(agent: Agent): void {
    selectAgent(agent.id);
    const layout = useLayoutStore.getState();
    const pane = layout.leaves().find((leaf) => leaf.terminalId === agent.terminalId);
    if (pane && layout.focusedPaneId !== pane.id) layout.toggleFocusPane(pane.id);
  }

  function renderAgentRow(workspace: WorkspaceRecord, recipe: WorkspaceAgentResume, agent: Agent | null, depth = 0) {
    const active = Boolean(agent && agent.id === selectedAgentId && isActive(workspace));
    const terminal = agent ? terminalSessions[agent.terminalId] : undefined;
    const displayedStatus = terminal?.status ?? agent?.status;
    const attention = agent
      ? attentionRecords[`${workspace.project.path}\u0000${agent.id}`]
      : undefined;
    const saved = !agent;
    const hasIsolatedWorktree = Boolean(
      agent?.worktreePath &&
        agent.worktreePath !== workspace.project.repositoryRoot &&
        agent.worktreePath !== workspace.project.path,
    );
    const restored = agent ? restoredAgents[agent.id] : undefined;
    const teamAgent = agent ? teamAgents[agent.id] : undefined;
    const restoreLabel = restored?.action === "resume"
      ? "Resume"
      : restored?.action === "reconnect"
        ? "Reconnect"
        : restored?.action === "new_session"
          ? "Start new"
          : "Unavailable";
    return (
      <div
        key={recipe.resumeId}
        className="workspace-agent-row-shell"
        data-active={active}
        data-team-depth={depth || undefined}
        style={depth ? ({ "--team-depth": Math.min(depth, 6) } as CSSProperties) : undefined}
      >
        <Button
          type="button"
          variant="ghost"
          className="workspace-agent-row"
          data-active={active}
          data-saved={saved}
          onClick={() => void onAgentClick(workspace, agent)}
          title={saved ? `${recipe.name} will relaunch when this project opens` : `${recipe.name}${agent?.branch ? ` · ${agent.branch}` : ""}`}
        >
          <ProviderIcon provider={recipe.provider} size="sm" bare className="workspace-agent-logo" />
          <span className="workspace-agent-name">{recipe.name}</span>
          {displayedStatus ? (
            <StatusBadge
              status={displayedStatus}
              attentionStatus={attention?.attentionStatus}
              unread={attention?.unread}
            />
          ) : <span className="status-dot" data-tone="neutral" aria-hidden="true" />}
        </Button>
        {restored && !restored.connected ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-6 shrink-0 px-1.5 text-[10px] text-mute"
            disabled={restored.pending || restored.action === "unavailable"}
            title={restored.error ?? restored.restoreMessage}
            onClick={() => {
              if (restored.action === "resume" || restored.action === "reconnect") void resumeAgent(restored.id);
              else setAddAgentOpen(true);
            }}
          >
            {restored.pending ? "Connecting…" : restoreLabel}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-xs" className="workspace-agent-menu" aria-label={`${recipe.name} actions`}><IconMore /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            {agent ? (
              <>
              <DropdownMenuItem onSelect={() => focusAgent(agent)}>Focus</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void revealItemInDir(agent.worktreePath || agent.cwd)}><IconFolder />Open worktree</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void copyText(agent.branch)}>Copy branch name</DropdownMenuItem>
              {teamAgent && teamAgent.status === "running" ? (
                <DropdownMenuItem onSelect={() => void useTeamStore.getState().pauseAgent(workspace.project.path, agent.id)}>Pause</DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void (teamAgent
                ? useTeamStore.getState().stopAgent(workspace.project.path, agent.id)
                : useAgentStore.getState().stop(agent.id))}>Stop</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => void removeAndStopAgent(agent.id)}>Remove agent</DropdownMenuItem>
              {hasIsolatedWorktree ? (
                <DropdownMenuItem variant="destructive" onSelect={() => { selectAgent(agent.id); useUiStore.getState().setDiscardOpen(true); }}>Discard worktree…</DropdownMenuItem>
              ) : null}
              </>
            ) : (
              <DropdownMenuItem variant="destructive" onSelect={() => forgetAgent(workspace.root, recipe.resumeId)}>
                Remove from sidebar
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  function renderWorkspace(workspace: WorkspaceRecord) {
    const active = isActive(workspace);
    const expanded = isExpanded(workspace);
    const projectAgents = agents.filter((agent) => agentBelongsToProject(agent, workspace.project));
    const listedAgents = workspace.agents.map((recipe) => ({
      recipe,
      agent: projectAgents.find((candidate) => savedAgentMatches(candidate, recipe)) ?? null,
    }));
    const offlineResumeIds = listedAgents
      .filter(({ agent }) => !agent)
      .map(({ recipe }) => recipe.resumeId);
    const listedIds = new Set(listedAgents.flatMap(({ agent }) => (agent ? [agent.id] : [])));
    const unlistedAgents = projectAgents.filter((agent) => !listedIds.has(agent.id));
    const agentRows = [
      ...listedAgents,
      ...unlistedAgents.map((agent) => ({
        recipe: {
          resumeId: agent.resumeId ?? agent.id,
          name: agent.name,
          provider: agent.provider,
          createWorktree: Boolean(agent.createWorktree),
        },
        agent,
      })),
    ];
    const rowIds = new Set(agentRows.flatMap(({ agent }) => agent ? [agent.id] : []));
    const orderedRows: Array<(typeof agentRows)[number] & { depth: number }> = [];
    const visited = new Set<string>();
    const appendAgentTree = (row: (typeof agentRows)[number], depth: number) => {
      const rowKey = row.agent?.id ?? row.recipe.resumeId;
      if (visited.has(rowKey)) return;
      visited.add(rowKey);
      orderedRows.push({ ...row, depth });
      if (!row.agent) return;
      agentRows
        .filter(({ agent }) => agent && teamAgents[agent.id]?.parentAgentId === row.agent?.id)
        .forEach((child) => appendAgentTree(child, depth + 1));
    };
    agentRows
      .filter(({ agent }) => !agent || !teamAgents[agent.id]?.parentAgentId || !rowIds.has(teamAgents[agent.id].parentAgentId ?? ""))
      .forEach((row) => appendAgentTree(row, 0));
    agentRows.forEach((row) => appendAgentTree(row, 0));
    const details = projectHoverDetails({
      name: workspace.project.name,
      agentCount: listedAgents.length + unlistedAgents.length,
      branch: workspace.project.currentBranch || workspace.project.baseBranch,
      path: workspace.project.path,
    });
    const projectUnreadCount = Object.values(attentionRecords)
      .filter((record) => record.projectId === workspace.project.path)
      .reduce((count, record) => count + record.unreadCount, 0);

    return (
      <section key={workspace.root} className="workspace-tree-group" data-active={active}>
        <div className="workspace-project-row">
          <HoverCard>
            <HoverCardTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="workspace-project-button"
                data-active={active}
                aria-expanded={expanded}
                onClick={() => void onProjectClick(workspace)}
              >
                {expanded ? <IconFolderOpen className="workspace-project-folder" /> : <IconFolder className="workspace-project-folder" />}
                <span className="workspace-project-name">{workspace.project.name}</span>
                {projectUnreadCount ? (
                  <span className="workspace-project-attention-count" aria-label={`${projectUnreadCount} unread agent updates`}>
                    {projectUnreadCount}
                  </span>
                ) : null}
              </Button>
            </HoverCardTrigger>
            <HoverCardContent side="right" align="start" className="workspace-project-hover-card">
              <div className="workspace-project-hover-heading">
                {expanded ? <IconFolderOpen /> : <IconFolder />}
                <span>{details.name}</span>
              </div>
              <div className="workspace-project-hover-count">{details.agentLabel}</div>
              <div className="workspace-project-hover-meta">
                <IconGit />
                <span>{details.branch}</span>
              </div>
              <div className="workspace-project-hover-meta">
                <IconFolder />
                <span title={details.path}>{details.path}</span>
              </div>
              <div className="workspace-project-hover-actions">
                <Button type="button" variant="ghost" onClick={() => void revealItemInDir(details.path)}>
                  <IconFolder />
                  Open folder
                </Button>
                <Button type="button" variant="ghost" onClick={() => void copyText(details.path)}>
                  Copy path
                </Button>
                <Button type="button" variant="ghost" onClick={() => void openProjectTerminal(workspace)}>
                  <IconTerminal />
                  Open terminal
                </Button>
              </div>
            </HoverCardContent>
          </HoverCard>
          {active ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="workspace-project-add"
              onClick={() => setAddAgentOpen(true)}
              disabled={!project}
              aria-label={`Add agent to ${workspace.project.name}`}
              title={`Add agent (${APP_SHORTCUTS.addAgent})`}
            >
              <IconPlus />
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-xs" className="workspace-project-menu" aria-label={`${workspace.project.name} actions`}><IconMore /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
              <DropdownMenuItem onSelect={() => void revealItemInDir(workspace.project.path)}><IconFolder />Open folder</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void copyText(workspace.project.path)}>Copy path</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void openProjectTerminal(workspace)}>Open terminal</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => { setWorktreeProjectRoot(workspace.project.repositoryRoot); setWorktreeOpen(true); }}>Workspace cleanup</DropdownMenuItem>
              {offlineResumeIds.length ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => forgetAgents(workspace.root, offlineResumeIds)}>
                    Remove all offline agents
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {expanded ? (
          <div className="workspace-agent-list" role="list" aria-label={`${workspace.project.name} agents`}>
            {orderedRows.map(({ recipe, agent, depth }) => renderAgentRow(workspace, recipe, agent, depth))}
            {!listedAgents.length && !unlistedAgents.length ? (
              <Button type="button" variant="ghost" className="workspace-agent-empty" onClick={() => active && setAddAgentOpen(true)} disabled={!active}>
                No agents yet
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <aside className="sidebar-shell" aria-label="Taxzy navigation">
      <div className="sidebar-brand">
        <TaxzyMark className="h-6 w-6" />
        <div className="sidebar-brand-copy">
          <span className="sidebar-brand-name">Taxzy</span>
        </div>
      </div>

      <div className="sidebar-workspaces-header">
        <div>
          <span className="sidebar-section-title">Projects</span>
          <span className="sidebar-section-count">{workspaces.length}</span>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" className="sidebar-add-button" onClick={() => void onOpenProject()} disabled={loading} aria-label="Open project" title={`Open project (${APP_SHORTCUTS.openProject})`}>
          <IconFolder />
          <IconPlus className="sidebar-add-plus" />
        </Button>
      </div>

      {workspaces.length > 5 ? (
        <label className="sidebar-search">
          <span className="sr-only">Filter projects</span>
          <Input value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="Filter projects" />
        </label>
      ) : null}

      <ScrollArea className="sidebar-workspace-list">
        {filteredWorkspaces.length ? filteredWorkspaces.map(renderWorkspace) : (
          <Button type="button" variant="ghost" className="sidebar-empty-workspaces" onClick={() => void onOpenProject()} disabled={loading}>
            <IconFolder />
            <span>{project ? "Saving this workspace…" : "Open a project to begin"}</span>
          </Button>
        )}
      </ScrollArea>

      <div className="sidebar-footer">
        <Button type="button" variant="ghost" className="sidebar-footer-button sidebar-footer-button-wide" onClick={() => setPreferencesOpen(true)} aria-label="Preferences" title="Preferences">
          <IconSettings />
          <span>Preferences</span>
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" className="sidebar-footer-button" onClick={() => setHelpOpen(true)} aria-label="Help" title="Help"><IconHelp /></Button>
      </div>
    </aside>
  );
}
