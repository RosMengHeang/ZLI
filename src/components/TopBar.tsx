import { useEffect, useState } from "react";
import {
  IconGit,
  IconGlobe,
  IconLayoutEven,
  IconLayoutFocus,
  IconLayoutGrid,
  IconPlus,
  IconTerminal,
} from "./AppIcons";
import { toolbarDensityForWidth } from "../lib/chromePresentation";
import { APP_SHORTCUTS } from "../lib/platform";
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

  const actionLabelClass = density === "compact" ? "hidden" : "inline";

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-chrome px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2" aria-label="Current project">
        <span className="truncate text-[13px] font-medium text-paper">
          {project?.name ?? "No project open"}
        </span>
        {project ? (
          <>
            <span className="text-line" aria-hidden="true">/</span>
            <span className="truncate font-mono text-[11px] text-mute">{project.currentBranch}</span>
          </>
        ) : null}
      </div>

      <div
        className="flex shrink-0 items-center rounded-lg border border-line bg-ink p-0.5"
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

      <div className="flex shrink-0 items-center gap-1" data-density={density}>
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
          <span className={actionLabelClass}>Terminal</span>
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setAddAgentOpen(true)}
          disabled={!project}
          title={`Launch an agent (${APP_SHORTCUTS.addAgent})`}
          aria-label="Launch an agent"
          aria-keyshortcuts={APP_SHORTCUTS.addAgent}
        >
          <IconPlus />
          <span className={actionLabelClass}>Agent</span>
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
          <span className={actionLabelClass}>Browser</span>
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
          <span className={actionLabelClass}>Changes</span>
        </button>
      </div>
    </header>
  );
}
