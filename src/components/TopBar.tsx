import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { IconGit, IconGlobe, IconLayoutEven, IconLayoutFocus, IconLayoutGrid, IconPlus, IconTerminal } from "./AppIcons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { aggregateRunningStatus, toolbarDensityForWidth } from "../lib/chromePresentation";
import { agentBelongsToProject } from "../lib/workspaceRegistry";
import { APP_SHORTCUTS } from "../lib/platform";
import { statusPresentation } from "../lib/statusPresentation";
import { useAgentStore } from "../stores/agentStore";
import { useLayoutStore } from "../stores/layoutStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useUiStore } from "../stores/uiStore";

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
  const gitPanelOpen = useLayoutStore((s) => s.gitPanelOpen);
  const toggleGitPanel = useLayoutStore((s) => s.toggleGitPanel);
  const applyPreset = useLayoutStore((s) => s.applyPreset);
  const paneTree = useLayoutStore((s) => s.paneTree);
  const addLeaf = useLayoutStore((s) => s.addLeaf);
  const createSession = useTerminalStore((s) => s.createSession);
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

  async function onAddTerminal() {
    if (!project) return;
    const session = await createSession({ cwd: project.path, cols: 80, rows: 24, title: "Terminal" });
    addLeaf(session.id);
  }

  const aggregateStatus = aggregateRunningStatus(runningCount);
  const aggregatePresentation = statusPresentation(aggregateStatus.presentedStatus);

  return (
    <header className="topbar" data-density={density}>
      <div className="topbar-project" aria-label="Project">
        <span className="topbar-project-name">{project?.name ?? "No project open"}</span>
        {project ? <span className="topbar-branch" title={project.currentBranch}>{project.currentBranch}</span> : null}
      </div>
      <div className="topbar-center">
        <div className="topbar-layout-switcher" role="group" aria-label="Layout presets">
          <ToolbarButton label="Even columns" variant="ghost" size="icon-sm" disabled={!paneTree} onClick={() => applyPreset("even")}><IconLayoutEven /></ToolbarButton>
          <ToolbarButton label="Tall left pane" variant="ghost" size="icon-sm" disabled={!paneTree} onClick={() => applyPreset("focus-left")}><IconLayoutFocus /></ToolbarButton>
          <ToolbarButton label="Grid layout" variant="ghost" size="icon-sm" disabled={!paneTree} onClick={() => applyPreset("grid")}><IconLayoutGrid /></ToolbarButton>
        </div>
      </div>
      <div className="topbar-actions">
        <div className="topbar-tools" role="group" aria-label="Tools">
          <ToolbarButton label={`Add terminal (${APP_SHORTCUTS.addTerminal})`} variant="ghost" size="sm" disabled={!project} onClick={() => void onAddTerminal()} aria-keyshortcuts={APP_SHORTCUTS.addTerminal}><IconTerminal /><span className="topbar-action-label">Terminal</span></ToolbarButton>
          <ToolbarButton label={`Toggle browser (${APP_SHORTCUTS.toggleBrowser})`} variant="ghost" size="sm" onClick={() => setBrowserOpen(!browserOpen)} aria-keyshortcuts={APP_SHORTCUTS.toggleBrowser} aria-pressed={browserOpen}><IconGlobe /><span className="topbar-action-label">Browser</span></ToolbarButton>
          <ToolbarButton label="Toggle TaxChat" variant="ghost" size="sm" disabled={!project || runningCount === 0} onClick={() => setTaxChatOpen(!taxChatOpen)} aria-pressed={taxChatOpen}><span className="topbar-taxchat-mark" aria-hidden="true">TC</span><span className="topbar-action-label">TaxChat</span></ToolbarButton>
          <ToolbarButton label={`Toggle changes (${APP_SHORTCUTS.toggleGit})`} variant="ghost" size="sm" disabled={!project} onClick={() => toggleGitPanel()} aria-keyshortcuts={APP_SHORTCUTS.toggleGit} aria-pressed={gitPanelOpen}><IconGit /><span className="topbar-action-label">Changes</span></ToolbarButton>
        </div>
        <Button size="sm" className="topbar-agent-button" onClick={() => setAddAgentOpen(true)} disabled={!project} aria-label="Add agent" aria-keyshortcuts={APP_SHORTCUTS.addAgent}><IconPlus /><span className="topbar-action-label">Add agent</span></Button>
        <div className="topbar-status" role="status" aria-live="polite" aria-label={`Agent status: ${aggregateStatus.label}`}>
          <span className="status-dot" data-tone={aggregatePresentation.tone} data-animated={aggregatePresentation.animated} aria-hidden="true" />
          <span className="topbar-status-label">{aggregateStatus.label}</span>
        </div>
      </div>
    </header>
  );
}
