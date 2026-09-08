import { useEffect, useState } from "react";
import {
  IconGit,
  IconGlobe,
  IconLayoutEven,
  IconLayoutFocus,
  IconLayoutGrid,
  IconPlus,
  IconTerminal,
  TaxzyMark,
} from "./AppIcons";
import { aggregateRunningStatus, toolbarDensityForWidth } from "../lib/chromePresentation";
import { APP_SHORTCUTS } from "../lib/platform";
import { statusPresentation } from "../lib/statusPresentation";
import { useAgentStore } from "../stores/agentStore";
import { useLayoutStore } from "../stores/layoutStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useUiStore } from "../stores/uiStore";

export function TopBar() {
  const project = useProjectStore((s) => s.project);
  const setAddAgentOpen = useUiStore((s) => s.setAddAgentOpen);
  const browserOpen = useUiStore((s) => s.browserOpen);
  const setBrowserOpen = useUiStore((s) => s.setBrowserOpen);
  const gitPanelOpen = useLayoutStore((s) => s.gitPanelOpen);
  const toggleGitPanel = useLayoutStore((s) => s.toggleGitPanel);
  const applyPreset = useLayoutStore((s) => s.applyPreset);
  const paneTree = useLayoutStore((s) => s.paneTree);
  const addLeaf = useLayoutStore((s) => s.addLeaf);
  const createSession = useTerminalStore((s) => s.createSession);
  const agentMap = useAgentStore((s) => s.agents);
  const agents = Object.values(agentMap);
  const sessions = useTerminalStore((s) => s.sessions);
  const runningCount = agents.filter((agent) =>
    (sessions[agent.terminalId]?.status ?? agent.status) === "running",
  ).length;
  const [density, setDensity] = useState(() => toolbarDensityForWidth(window.innerWidth));

  useEffect(() => {
    function updateDensity() {
      setDensity(toolbarDensityForWidth(window.innerWidth));
    }

    window.addEventListener("resize", updateDensity);
    return () => window.removeEventListener("resize", updateDensity);
  }, []);

  async function onAddTerminal() {
    if (!project) return;
    const session = await createSession({
      cwd: project.path,
      cols: 80,
      rows: 24,
      title: "Terminal",
    });
    addLeaf(session.id);
  }

  const aggregateStatus = aggregateRunningStatus(runningCount);
  const aggregatePresentation = statusPresentation(aggregateStatus.presentedStatus);

  return (
    <header className="topbar" data-density={density}>
      <div className="topbar-project" aria-label="Current project">
        <div className="topbar-project-mark" aria-hidden="true">
          <TaxzyMark className="h-5 w-5" />
        </div>
        <div className="topbar-project-copy">
          <span className="topbar-overline">Workspace</span>
          <span className="topbar-project-name">
            {project?.name ?? "No project open"}
          </span>
        </div>
        {project ? (
          <span className="topbar-branch" title={project.currentBranch}>
            {project.currentBranch}
          </span>
        ) : (
          <span className="topbar-project-hint">Choose a folder</span>
        )}
      </div>

      <div className="topbar-center">
        <span className="topbar-context">Workspace layout</span>
        <div
          className="topbar-layout-switcher"
          role="group"
          aria-label="Layout presets"
        >
          <button
            type="button"
            className="btn btn-icon"
            title="Even columns"
            aria-label="Even columns"
            disabled={!paneTree}
            onClick={() => applyPreset("even")}
          >
            <IconLayoutEven />
          </button>
          <button
            type="button"
            className="btn btn-icon"
            title="Tall left pane"
            aria-label="Tall left pane"
            disabled={!paneTree}
            onClick={() => applyPreset("focus-left")}
          >
            <IconLayoutFocus />
          </button>
          <button
            type="button"
            className="btn btn-icon"
            title="Grid layout"
            aria-label="Grid layout"
            disabled={!paneTree}
            onClick={() => applyPreset("grid")}
          >
            <IconLayoutGrid />
          </button>
        </div>
      </div>

      <div className="topbar-actions">
        <div className="topbar-tools" role="group" aria-label="Workspace tools">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void onAddTerminal()}
            disabled={!project}
            title={`Add terminal pane (${APP_SHORTCUTS.addTerminal})`}
            aria-label="Add terminal pane"
            aria-keyshortcuts={APP_SHORTCUTS.addTerminal}
          >
            <IconTerminal />
            <span className="topbar-action-label">Terminal</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setBrowserOpen(!browserOpen)}
            title={`Toggle browser (${APP_SHORTCUTS.toggleBrowser})`}
            aria-label="Toggle browser"
            aria-keyshortcuts={APP_SHORTCUTS.toggleBrowser}
            aria-pressed={browserOpen}
          >
            <IconGlobe />
            <span className="topbar-action-label">Browser</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => toggleGitPanel()}
            disabled={!project}
            title={`Toggle changes (${APP_SHORTCUTS.toggleGit})`}
            aria-label="Toggle changes"
            aria-keyshortcuts={APP_SHORTCUTS.toggleGit}
            aria-pressed={gitPanelOpen}
          >
            <IconGit />
            <span className="topbar-action-label">Changes</span>
          </button>
        </div>

        <button
          type="button"
          className="btn btn-primary topbar-agent-button"
          onClick={() => setAddAgentOpen(true)}
          disabled={!project}
          title={`Launch an agent (${APP_SHORTCUTS.addAgent})`}
          aria-label="Launch an agent"
          aria-keyshortcuts={APP_SHORTCUTS.addAgent}
        >
          <IconPlus />
          <span className="topbar-action-label">Add agent</span>
        </button>
        <div
          className="topbar-status"
          role="status"
          aria-live="polite"
          aria-label={`Agent status: ${aggregateStatus.label}`}
        >
          <span
            className="status-dot"
            data-tone={aggregatePresentation.tone}
            data-animated={aggregatePresentation.animated}
            aria-hidden="true"
          />
          <span className="topbar-status-label">{aggregateStatus.label}</span>
        </div>
      </div>
    </header>
  );
}
