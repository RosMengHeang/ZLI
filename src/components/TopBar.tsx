import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { IconGit, IconGlobe, IconGrid, IconPlus } from "./AppIcons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toolbarDensityForWidth } from "../lib/chromePresentation";
import { agentBelongsToProject } from "../lib/workspaceRegistry";
import { APP_SHORTCUTS } from "../lib/platform";
import { useAgentStore } from "../stores/agentStore";
import { useLayoutStore } from "../stores/layoutStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useUiStore } from "../stores/uiStore";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { NotificationCenter } from "./NotificationCenter";

function ToolbarButton({ label, children, ...props }: ComponentProps<typeof Button> & { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><Button aria-label={label} {...props}>{children}</Button></TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function TopBar() {
  const project = useProjectStore((s) => s.project);
  const setAddAgentOpen = useUiStore((s) => s.setAddAgentOpen);
  const browserOpen = useUiStore((s) => s.browserOpen);
  const setBrowserOpen = useUiStore((s) => s.setBrowserOpen);
  const taxChatOpen = useUiStore((s) => s.taxChatOpen);
  const setTaxChatOpen = useUiStore((s) => s.setTaxChatOpen);
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const gitPanelOpen = useLayoutStore((s) => s.gitPanelOpen);
  const toggleGitPanel = useLayoutStore((s) => s.toggleGitPanel);
  const applyPreset = useLayoutStore((s) => s.applyPreset);
  const paneTree = useLayoutStore((s) => s.paneTree);
  const agentMap = useAgentStore((s) => s.agents);
  const agents = Object.values(agentMap).filter((agent) => !project || agentBelongsToProject(agent, project));
  const sessions = useTerminalStore((s) => s.sessions);
  const runningCount = agents.filter((agent) => (sessions[agent.terminalId]?.status ?? agent.status) === "running").length;
  const [density, setDensity] = useState(() => toolbarDensityForWidth(window.innerWidth));

  useEffect(() => {
    const updateDensity = () => setDensity(toolbarDensityForWidth(window.innerWidth));
    window.addEventListener("resize", updateDensity);
    return () => window.removeEventListener("resize", updateDensity);
  }, []);

  return (
    <header className="topbar" data-density={density}>
      <div className="topbar-project" aria-label="Project">
        <span className="topbar-project-name">{project?.name ?? "No project open"}</span>
        {project ? <span className="topbar-branch" title={project.currentBranch}>{project.currentBranch}</span> : null}
      </div>
      <div className="topbar-center">
        <Button type="button" variant="ghost" size="sm" className="topbar-command" onClick={() => setCommandPaletteOpen(true)}>
          <span>Search or run a command</span>
          <kbd>{APP_SHORTCUTS.commandPalette}</kbd>
        </Button>
      </div>
      <div className="topbar-actions">
        <div className="topbar-tools" role="group" aria-label="Tools">
          <ToolbarButton label={`Toggle browser (${APP_SHORTCUTS.toggleBrowser})`} variant="ghost" size="sm" onClick={() => setBrowserOpen(!browserOpen)} aria-keyshortcuts={APP_SHORTCUTS.toggleBrowser} aria-pressed={browserOpen}><IconGlobe /><span className="topbar-action-label">Browser</span></ToolbarButton>
          <ToolbarButton label="Toggle TaxChat" variant="ghost" size="sm" disabled={!project || runningCount === 0} onClick={() => setTaxChatOpen(!taxChatOpen)} aria-pressed={taxChatOpen}><span className="topbar-taxchat-mark" aria-hidden="true">TC</span><span className="topbar-action-label">TaxChat</span></ToolbarButton>
          <ToolbarButton label={`Toggle changes (${APP_SHORTCUTS.toggleGit})`} variant="ghost" size="sm" disabled={!project} onClick={() => toggleGitPanel()} aria-keyshortcuts={APP_SHORTCUTS.toggleGit} aria-pressed={gitPanelOpen}><IconGit /><span className="topbar-action-label">Changes</span></ToolbarButton>
        </div>
        <NotificationCenter projectId={project?.path ?? null} projectName={project?.name ?? null} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-sm" disabled={!paneTree} aria-label="Arrange panes"><IconGrid /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onSelect={() => applyPreset("even")}>Even columns</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => applyPreset("focus-left")}>Tall left pane</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => applyPreset("grid")}>Grid layout</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" className="topbar-agent-button" onClick={() => setAddAgentOpen(true)} disabled={!project} aria-label="Add agent" aria-keyshortcuts={APP_SHORTCUTS.addAgent}><IconPlus /><span className="topbar-action-label">Add agent</span></Button>
      </div>
    </header>
  );
}
