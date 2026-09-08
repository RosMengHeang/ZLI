import { useState } from "react";
import {
  IconChevronDown,
  IconFolder,
  IconHelp,
  IconPlus,
  IconSettings,
  TaxzyMark,
} from "./AppIcons";
import { ProviderIcon } from "./ProviderIcon";
import { StatusBadge } from "./StatusBadge";
import {
  agentBelongsToProject,
  workspaceRootKey,
  type WorkspaceAgentResume,
  type WorkspaceRecord,
} from "../lib/workspaceRegistry";
import { displayPath } from "../lib/format";
import { APP_SHORTCUTS } from "../lib/platform";
import { useAgentStore } from "../stores/agentStore";
import { useLayoutStore } from "../stores/layoutStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useUiStore } from "../stores/uiStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { Agent } from "../types";

export const COLLAPSED_SIDEBAR_SIZE = "58px";

function savedAgentMatches(agent: Agent, recipe: WorkspaceAgentResume): boolean {
  return agent.resumeId === recipe.resumeId || (agent.name === recipe.name && agent.provider === recipe.provider);
}

export function Sidebar() {
  const agentMap = useAgentStore((state) => state.agents);
  const agents = Object.values(agentMap);
  const terminalSessions = useTerminalStore((state) => state.sessions);
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const selectAgent = useAgentStore((state) => state.selectAgent);
  const project = useProjectStore((state) => state.project);
  const loading = useProjectStore((state) => state.loading);
  const openFromDialog = useProjectStore((state) => state.openFromDialog);
  const openFromPath = useProjectStore((state) => state.openFromPath);
  const setAddAgentOpen = useUiStore((state) => state.setAddAgentOpen);
  const setBrowserOpen = useUiStore((state) => state.setBrowserOpen);
  const setHelpOpen = useUiStore((state) => state.setHelpOpen);
  const setPreferencesOpen = useUiStore((state) => state.setPreferencesOpen);
  const toggleGitPanel = useLayoutStore((state) => state.toggleGitPanel);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeProjectRoot = useWorkspaceStore((state) => state.activeProjectRoot);
  const collapsed = useWorkspaceStore((state) => state.collapsed);
  const expandedProjectRoots = useWorkspaceStore((state) => state.expandedProjectRoots);
  const setCollapsed = useWorkspaceStore((state) => state.setCollapsed);
  const setActiveProject = useWorkspaceStore((state) => state.setActiveProject);
  const toggleExpanded = useWorkspaceStore((state) => state.toggleExpanded);
  const [projectSearch, setProjectSearch] = useState("");

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

  async function onOpenProject(): Promise<void> {
    await openFromDialog();
  }

  async function onAgentClick(workspace: WorkspaceRecord, agent: Agent | null): Promise<void> {
    const opened = await openWorkspace(workspace);
    if (opened && agent) selectAgent(agent.id);
  }

  function renderAgentRow(workspace: WorkspaceRecord, recipe: WorkspaceAgentResume, agent: Agent | null) {
    const active = Boolean(agent && agent.id === selectedAgentId && isActive(workspace));
    const terminal = agent ? terminalSessions[agent.terminalId] : undefined;
    const displayedStatus = terminal?.status ?? agent?.status;
    const saved = !agent;
    return (
      <button
        key={recipe.resumeId}
        type="button"
        className="workspace-agent-row"
        data-active={active}
        data-saved={saved}
        onClick={() => void onAgentClick(workspace, agent)}
        title={saved ? `${recipe.name} will relaunch when this project opens` : `Open ${recipe.name}`}
      >
        <ProviderIcon provider={recipe.provider} size="sm" />
        <span className="workspace-agent-copy">
          <span className="workspace-agent-name">{recipe.name}</span>
          <span className="workspace-agent-meta">{recipe.provider}{agent?.branch ? ` · ${agent.branch}` : ""}</span>
        </span>
        {displayedStatus ? <StatusBadge status={displayedStatus} /> : <span className="workspace-agent-saved">Saved</span>}
      </button>
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
    const listedIds = new Set(listedAgents.flatMap(({ agent }) => (agent ? [agent.id] : [])));
    const unlistedAgents = projectAgents.filter((agent) => !listedIds.has(agent.id));

    return (
      <section key={workspace.root} className="workspace-tree-group" data-active={active}>
        <div className="workspace-project-row">
          <button
            type="button"
            className="workspace-project-button"
            data-active={active}
            aria-expanded={expanded}
            onClick={() => void openWorkspace(workspace)}
            title={workspace.project.path}
          >
            <IconChevronDown className={`workspace-project-chevron ${expanded ? "is-expanded" : ""}`} />
            <span className="workspace-project-mark" aria-hidden="true">{workspace.project.name.slice(0, 1).toUpperCase()}</span>
            <span className="workspace-project-copy">
              <span className="workspace-project-name">{workspace.project.name}</span>
              <span className="workspace-project-path">{displayPath(workspace.project.path, 28)}</span>
            </span>
            <span className="workspace-project-count">{workspace.agents.length || projectAgents.length || ""}</span>
          </button>
          {active ? (
            <button
              type="button"
              className="workspace-project-add"
              onClick={() => setAddAgentOpen(true)}
              disabled={!project}
              aria-label={`Add agent to ${workspace.project.name}`}
              title={`Add agent (${APP_SHORTCUTS.addAgent})`}
            >
              <IconPlus />
            </button>
          ) : null}
        </div>
        {expanded ? (
          <div className="workspace-agent-list" role="list" aria-label={`${workspace.project.name} agents`}>
            {listedAgents.map(({ recipe, agent }) => renderAgentRow(workspace, recipe, agent))}
            {unlistedAgents.map((agent) => renderAgentRow(workspace, {
              resumeId: agent.resumeId ?? agent.id,
              name: agent.name,
              provider: agent.provider,
              createWorktree: Boolean(agent.createWorktree),
            }, agent))}
            {!listedAgents.length && !unlistedAgents.length ? (
              <button type="button" className="workspace-agent-empty" onClick={() => active && setAddAgentOpen(true)} disabled={!active}>
                No agents yet
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  }

  if (collapsed) {
    return (
      <aside className="sidebar-shell is-collapsed" aria-label="TaxChat navigation">
        <div className="sidebar-brand sidebar-brand-collapsed">
          <TaxzyMark className="h-7 w-7" />
          <button type="button" className="sidebar-collapse-button" onClick={() => setCollapsed(false)} aria-label="Expand sidebar" title="Expand sidebar">›</button>
        </div>
        <div className="sidebar-collapsed-actions">
          <button type="button" className="sidebar-collapsed-button" onClick={() => void onOpenProject()} disabled={loading} aria-label="Open project" title="Open project"><IconPlus /></button>
          {workspaces.map((workspace) => (
            <button
              key={workspace.root}
              type="button"
              className="sidebar-collapsed-project"
              data-active={isActive(workspace)}
              onClick={() => void openWorkspace(workspace)}
              title={workspace.project.name}
            >
              {workspace.project.name.slice(0, 1).toUpperCase()}
            </button>
          ))}
        </div>
        <div className="sidebar-footer sidebar-footer-collapsed">
          <button type="button" className="sidebar-footer-button" onClick={() => setPreferencesOpen(true)} aria-label="Preferences" title="Preferences"><IconSettings /></button>
          <button type="button" className="sidebar-footer-button" onClick={() => setHelpOpen(true)} aria-label="Help" title="Help"><IconHelp /></button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="sidebar-shell" aria-label="TaxChat navigation">
      <div className="sidebar-brand">
        <TaxzyMark className="h-7 w-7" />
        <div className="sidebar-brand-copy">
          <span className="sidebar-brand-name">TaxChat</span>
          <span className="sidebar-brand-caption">Local agent workspace</span>
        </div>
        <button type="button" className="sidebar-collapse-button" onClick={() => setCollapsed(true)} aria-label="Collapse sidebar" title="Collapse sidebar">‹</button>
      </div>

      <div className="sidebar-workspaces-header">
        <div>
          <span className="sidebar-section-title">Workspaces</span>
          <span className="sidebar-section-count">{workspaces.length}</span>
        </div>
        <button type="button" className="sidebar-add-button" onClick={() => void onOpenProject()} disabled={loading} aria-label="Open project" title={`Open project (${APP_SHORTCUTS.openProject})`}>
          <IconFolder />
          <IconPlus className="sidebar-add-plus" />
        </button>
      </div>

      <label className="sidebar-search">
        <span className="sr-only">Filter workspaces</span>
        <input value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} placeholder="Filter workspaces" />
      </label>

      <div className="sidebar-workspace-list">
        {filteredWorkspaces.length ? filteredWorkspaces.map(renderWorkspace) : (
          <button type="button" className="sidebar-empty-workspaces" onClick={() => void onOpenProject()} disabled={loading}>
            <IconFolder />
            <span>{project ? "Saving this workspace…" : "Open a project to begin"}</span>
          </button>
        )}
      </div>

      <div className="sidebar-current-project">
        <span className="sidebar-current-dot" />
        <span className="sidebar-current-copy">
          <span>Current project</span>
          <strong>{project?.name ?? "None selected"}</strong>
        </span>
      </div>

      <div className="sidebar-footer">
        <button type="button" className="sidebar-footer-button sidebar-footer-button-wide" onClick={() => setPreferencesOpen(true)} aria-label="Preferences" title="Preferences">
          <IconSettings />
          <span>Preferences</span>
        </button>
        <button type="button" className="sidebar-footer-button" onClick={() => setHelpOpen(true)} aria-label="Help" title="Help"><IconHelp /></button>
      </div>
    </aside>
  );
}
