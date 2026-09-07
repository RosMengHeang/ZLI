import {
  IconChevronDown,
  IconLayoutEven,
  IconLayoutFocus,
  IconLayoutGrid,
  IconPlus,
  IconSearch,
  IconTerminal,
} from "./AppIcons";
import { APP_SHORTCUTS } from "../lib/platform";
import { useLayoutStore } from "../stores/layoutStore";
import { useAgentStore } from "../stores/agentStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useUiStore } from "../stores/uiStore";

export function TopBar() {
  const project = useProjectStore((s) => s.project);
  const setAddAgentOpen = useUiStore((s) => s.setAddAgentOpen);
  const applyPreset = useLayoutStore((s) => s.applyPreset);
  const paneTree = useLayoutStore((s) => s.paneTree);
  const addLeaf = useLayoutStore((s) => s.addLeaf);
  const createSession = useTerminalStore((s) => s.createSession);
  const runningCount = useAgentStore(
    (s) => Object.values(s.agents).filter((agent) => agent.status === "running").length,
  );

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

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-chrome px-3">
      <div className="flex min-w-0 flex-1 justify-center">
        <div className="flex h-8 w-full max-w-md items-center gap-2 rounded-lg border border-line bg-ink px-2.5">
          <span className="text-mute">
            <IconSearch />
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-paper">
            {project ? `${project.name} / ${project.currentBranch}` : "Open a Git repository"}
          </span>
          <span className="text-mute">
            <IconChevronDown />
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <div className="mr-1 flex items-center rounded-lg border border-line bg-ink p-0.5" role="group" aria-label="Layout presets">
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
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void onAddTerminal()}
          disabled={!project}
          title={`Add terminal pane (${APP_SHORTCUTS.addTerminal})`}
          aria-keyshortcuts={APP_SHORTCUTS.addTerminal}
        >
          <IconTerminal />
          Terminal
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setAddAgentOpen(true)}
          disabled={!project}
          title={`Launch an agent (${APP_SHORTCUTS.addAgent})`}
          aria-keyshortcuts={APP_SHORTCUTS.addAgent}
        >
          <IconPlus />
          Add Agent
        </button>
        <div className="ml-1 flex items-center gap-1.5 pl-2 text-[11px] text-mute">
          <span className={runningCount > 0 ? "status-dot" : "inline-block h-1.5 w-1.5 rounded-full bg-mute"} />
          {runningCount > 0 ? "Good to build" : "Idle"}
        </div>
      </div>
    </header>
  );
}
