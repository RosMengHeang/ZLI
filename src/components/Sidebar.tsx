import { useState, type KeyboardEvent } from "react";
import {
  IconAgents,
  IconFolder,
  IconGit,
  IconGlobe,
  IconHelp,
  IconHome,
  IconPlus,
  IconSettings,
  TaxzyMark,
} from "./AppIcons";
import { ProviderIcon } from "./ProviderIcon";
import { StatusBadge } from "./StatusBadge";
import { displayPath } from "../lib/format";
import {
  currentSidebarDestination,
  navigationTargetForDestination,
  sidebarNavigationItems,
  type BaseDestination,
  type PrimaryDestination,
} from "../lib/chromePresentation";
import { APP_SHORTCUTS } from "../lib/platform";
import { useAgentStore } from "../stores/agentStore";
import { useGitStore } from "../stores/gitStore";
import { useLayoutStore } from "../stores/layoutStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useUiStore } from "../stores/uiStore";
import { providerDisplayName } from "../types";

export function Sidebar() {
  const agentMap = useAgentStore((s) => s.agents);
  const agents = Object.values(agentMap);
  const terminalSessions = useTerminalStore((s) => s.sessions);
  const selectedAgentId = useAgentStore((s) => s.selectedAgentId);
  const selectAgent = useAgentStore((s) => s.selectAgent);
  const project = useProjectStore((s) => s.project);
  const loading = useProjectStore((s) => s.loading);
  const openFromDialog = useProjectStore((s) => s.openFromDialog);
  const setAddAgentOpen = useUiStore((s) => s.setAddAgentOpen);
  const setPathDialogOpen = useUiStore((s) => s.setPathDialogOpen);
  const setBrowserOpen = useUiStore((s) => s.setBrowserOpen);
  const setHelpOpen = useUiStore((s) => s.setHelpOpen);
  const setPreferencesOpen = useUiStore((s) => s.setPreferencesOpen);
  const browserOpen = useUiStore((s) => s.browserOpen);
  const gitPanelOpen = useLayoutStore((s) => s.gitPanelOpen);
  const toggleGitPanel = useLayoutStore((s) => s.toggleGitPanel);
  const statusByPath = useGitStore((s) => s.statusByPath);
  const changedCount = project ? (statusByPath[project.path]?.changedFiles.length ?? 0) : 0;
  const [baseDestination, setBaseDestination] = useState<BaseDestination>("workspace");
  const currentPage = currentSidebarDestination(baseDestination, browserOpen, gitPanelOpen);
  const navigationItems = sidebarNavigationItems(currentPage);

  function navigateTo(destination: PrimaryDestination, requestedAgentId?: string) {
    const target = navigationTargetForDestination(
      destination,
      agents.map((agent) => agent.id),
      requestedAgentId ?? selectedAgentId,
      baseDestination,
    );
    setBaseDestination(target.baseDestination);
    setBrowserOpen(target.browserOpen);
    toggleGitPanel(target.gitPanelOpen);
    if (destination === "agents" && target.selectedAgentId) selectAgent(target.selectedAgentId);
  }

  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (agents.length === 0) return;
    event.preventDefault();
    const current = selectedAgentId ? agents.findIndex((agent) => agent.id === selectedAgentId) : -1;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = Math.min(agents.length - 1, Math.max(0, (current < 0 ? 0 : current) + delta));
    navigateTo("agents", agents[next].id);
  }

  async function onOpenProject() {
    const result = await openFromDialog();
    if (result === "failed") setPathDialogOpen(true);
  }

  return (
    <aside className="flex h-full min-w-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-2 px-3 pb-3 pt-3.5">
        <TaxzyMark className="h-7 w-7" />
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-tight text-paper">
          Taxzy
        </span>
      </div>

      <nav className="flex flex-col gap-0.5 px-2" aria-label="Workspace navigation">
        {navigationItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className="nav-item"
            data-active={item.current}
            aria-current={item.current ? "page" : undefined}
            onClick={() => navigateTo(item.id)}
            disabled={item.id === "changes" && !project}
            title={
              item.id === "browser"
                ? `Browser (${APP_SHORTCUTS.toggleBrowser})`
                : item.id === "changes"
                  ? `Git review (${APP_SHORTCUTS.toggleGit})`
                  : undefined
            }
          >
            {item.id === "workspace" ? (
              <IconHome />
            ) : item.id === "agents" ? (
              <IconAgents />
            ) : item.id === "changes" ? (
              <IconGit />
            ) : (
              <IconGlobe />
            )}
            <span className="flex-1">{item.label}</span>
            {item.id === "changes" && changedCount > 0 ? (
              <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {changedCount}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      <section className="mt-4 border-t border-line px-2 pt-3" aria-labelledby="project-region-title">
        <div className="mb-2 flex items-center justify-between px-1">
          <h2 id="project-region-title" className="text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
            Project
          </h2>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => void onOpenProject()}
            disabled={loading}
            title={`Open project (${APP_SHORTCUTS.openProject})`}
            aria-label="Open project"
          >
            <IconFolder />
          </button>
        </div>

        {project ? (
          <div className="rounded-xl border border-line bg-ink px-3 py-2.5">
            <div className="truncate text-[13px] font-medium text-paper">{project.name}</div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-mute" title={project.path}>
              {displayPath(project.path, 36)}
            </div>
            <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[11px]">
              <span className="truncate text-branch">{project.currentBranch}</span>
              <span className="text-line" aria-hidden="true">•</span>
              <span className={`shrink-0 ${project.clean ? "text-ok" : "text-warn"}`}>
                {project.clean ? "Clean" : "Dirty"}
              </span>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-line px-3 py-3 text-[12px] leading-5 text-mute">
            Open a Git folder to start a workspace.
          </div>
        )}
      </section>

      <section className="mt-4 flex min-h-0 flex-1 flex-col border-t border-line pt-3" aria-labelledby="agents-region-title">
        <div className="mb-2 flex items-center justify-between px-3">
          <h2 id="agents-region-title" className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-mute">
            <IconAgents />
            Agents
          </h2>
          <button
            type="button"
            className="btn btn-icon"
            onClick={() => setAddAgentOpen(true)}
            disabled={!project}
            title={`New agent (${APP_SHORTCUTS.addAgent})`}
            aria-label="New agent"
          >
            <IconPlus />
          </button>
        </div>

        <div
          className="min-h-0 flex-1 overflow-auto px-2 pb-2"
          role="listbox"
          aria-label="Agents"
          tabIndex={0}
          onKeyDown={onListKeyDown}
        >
          {agents.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line px-3 py-4 text-[12px] leading-5 text-mute">
              No agents yet. Launch Claude Code, Codex, Cursor, Gemini, or a terminal.
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {agents.map((agent) => {
                const active = agent.id === selectedAgentId;
                const terminal = terminalSessions[agent.terminalId];
                const displayedStatus = terminal?.status ?? agent.status;
                const displayedError = terminal?.error ?? agent.error;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => navigateTo("agents", agent.id)}
                    role="option"
                    aria-selected={active}
                    className={`w-full rounded-xl px-2 py-2 text-left transition-colors ${
                      active ? "bg-raised" : "hover:bg-hover"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <ProviderIcon provider={agent.provider} size="md" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-paper">{agent.name}</div>
                        <div className="mt-0.5 truncate text-[11px] text-mute">
                          {providerDisplayName(agent.provider)}
                          {agent.branch ? ` · ${agent.branch}` : ""}
                        </div>
                      </div>
                      <StatusBadge status={displayedStatus} />
                    </div>
                    {displayedError ? (
                      <div className="mt-1 truncate text-[11px] text-danger" title={displayedError}>
                        {displayedError}
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <div className="flex items-center gap-1 border-t border-line px-2 py-2" aria-label="Utilities">
        <button
          type="button"
          className="btn btn-ghost flex-1 justify-start"
          onClick={() => setPreferencesOpen(true)}
          aria-label="Preferences"
          title="Preferences"
        >
          <IconSettings />
          Preferences
        </button>
        <button
          type="button"
          className="btn btn-icon"
          onClick={() => setHelpOpen(true)}
          aria-label="Help"
          title="Help"
        >
          <IconHelp />
        </button>
      </div>
    </aside>
  );
}
