import { useLayoutStore } from "../stores/layoutStore";
import { useAgentStore } from "../stores/agentStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useUiStore } from "../stores/uiStore";
import { displayPath } from "../lib/format";

export function TopBar() {
  const project = useProjectStore((s) => s.project);
  const loading = useProjectStore((s) => s.loading);
  const openFromDialog = useProjectStore((s) => s.openFromDialog);
  const setPathDialogOpen = useUiStore((s) => s.setPathDialogOpen);
  const setAddAgentOpen = useUiStore((s) => s.setAddAgentOpen);
  const gitPanelOpen = useLayoutStore((s) => s.gitPanelOpen);
  const toggleGitPanel = useLayoutStore((s) => s.toggleGitPanel);
  const addLeaf = useLayoutStore((s) => s.addLeaf);
  const createSession = useTerminalStore((s) => s.createSession);
  const browserOpen = useUiStore((s) => s.browserOpen);
  const setBrowserOpen = useUiStore((s) => s.setBrowserOpen);
  const agentCount = useAgentStore((s) => Object.keys(s.agents).length);

  async function onOpenProject() {
    const result = await openFromDialog();
    if (result === "failed") setPathDialogOpen(true);
  }

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
    <header className="flex h-8 shrink-0 items-center gap-2 border-b border-[#3e3e42] bg-[#2d2d2d] px-2">
      <div className="text-[12px] font-semibold tracking-tight text-white">Taxzy</div>
      <div className="h-4 w-px bg-[#3e3e42]" />
      {project ? (
        <div className="min-w-0 flex-1 truncate text-[11px] text-[#cccccc]">
          <span className="font-medium text-white">{project.name}</span>
          <span className="mx-1.5 text-[#8b8b8b]">·</span>
          <span className="text-[#9cdcfe]">{project.currentBranch}</span>
          <span className="mx-1.5 text-[#8b8b8b]">·</span>
          <span className="text-[#8b8b8b]" title={project.path}>
            {displayPath(project.path, 64)}
          </span>
        </div>
      ) : (
        <div className="flex-1 text-[11px] text-[#8b8b8b]">No project open</div>
      )}
      <div className="flex items-center border border-[#45474b] bg-[#252526] p-0.5" role="tablist" aria-label="Workspace views">
        <button
          type="button"
          role="tab"
          aria-selected={!browserOpen}
          className={`h-5 px-2 text-[10px] ${!browserOpen ? "bg-[#0e639c] text-white" : "text-[#9b9da1] hover:bg-[#3e3e42] hover:text-white"}`}
          onClick={() => setBrowserOpen(false)}
        >
          Agents{agentCount ? ` · ${agentCount}` : ""}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={browserOpen}
          className={`h-5 px-2 text-[10px] ${browserOpen ? "bg-[#0e639c] text-white" : "text-[#9b9da1] hover:bg-[#3e3e42] hover:text-white"}`}
          onClick={() => setBrowserOpen(true)}
        >
          Browser
        </button>
      </div>
      <button
        type="button"
        className="h-6 px-2 text-[11px] text-[#cccccc] hover:bg-[#3e3e42]"
        onClick={() => void onOpenProject()}
        disabled={loading}
      >
        {loading ? "Opening…" : "Open Project"}
      </button>
      <button
        type="button"
        className="h-6 px-2 text-[11px] text-[#cccccc] hover:bg-[#3e3e42] disabled:opacity-40"
        onClick={() => void onAddTerminal()}
        disabled={!project}
      >
        + Terminal
      </button>
      <button
        type="button"
        className="h-6 px-2 text-[11px] text-[#cccccc] hover:bg-[#3e3e42] disabled:opacity-40"
        onClick={() => setAddAgentOpen(true)}
        disabled={!project}
      >
        + Agent
      </button>
      <button
        type="button"
        className={`h-6 px-2 text-[11px] hover:bg-[#3e3e42] disabled:opacity-40 ${
          gitPanelOpen ? "bg-[#0e639c] text-white" : "text-[#cccccc]"
        }`}
        onClick={() => toggleGitPanel()}
        disabled={!project}
      >
        Git
      </button>
    </header>
  );
}
