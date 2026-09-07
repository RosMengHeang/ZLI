import { useMemo } from "react";
import { BrowserPanel } from "./BrowserPanel";
import { TerminalPane } from "./TerminalPane";
import { useLayoutStore } from "../stores/layoutStore";
import { collectLeaves } from "../stores/paneTree";
import { useAgentStore } from "../stores/agentStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";

export function Workspace() {
  const project = useProjectStore((s) => s.project);
  const paneTree = useLayoutStore((s) => s.paneTree);
  const setAddAgentOpen = useUiStore((s) => s.setAddAgentOpen);
  const workspaceView = useUiStore((s) => s.workspaceView);
  const setWorkspaceView = useUiStore((s) => s.setWorkspaceView);
  const agents = useAgentStore((s) => s.agents);
  const leaves = useMemo(() => collectLeaves(paneTree), [paneTree]);
  const agentCount = Object.keys(agents).length;
  const runningCount = Object.values(agents).filter((agent) => agent.status === "running").length;

  if (!project && workspaceView === "agents") {
    return (
      <div className="flex h-full items-center justify-center bg-[#1e1e1e]">
        <div className="max-w-md px-6 text-center">
          <div className="text-[13px] font-medium text-white">Open a repository</div>
          <p className="mt-2 text-[12px] leading-5 text-[#8b8b8b]">
            Choose a Git project to launch terminals and coding agents. Worktrees, diffs, and
            review actions stay scoped to that repo.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[#1b1c1e]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[#34363a] bg-[#242629] px-3">
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-semibold text-white">{workspaceView === "agents" ? "Agent workspace" : "Browser"}</span>
          {workspaceView === "agents" ? (
            <span className="text-[10px] text-[#7f858b]">{runningCount}/{agentCount} running · {leaves.length} panes</span>
          ) : (
            <span className="text-[10px] text-[#7f858b]">Research without leaving your workspace</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`h-6 px-2 text-[10px] ${workspaceView === "agents" ? "bg-[#0e639c] text-white" : "text-[#9b9da1] hover:bg-[#3b3e42] hover:text-white"}`}
            onClick={() => setWorkspaceView("agents")}
          >
            Grid
          </button>
          <button
            type="button"
            className={`h-6 px-2 text-[10px] ${workspaceView === "browser" ? "bg-[#0e639c] text-white" : "text-[#9b9da1] hover:bg-[#3b3e42] hover:text-white"}`}
            onClick={() => setWorkspaceView("browser")}
          >
            Browser
          </button>
        </div>
      </div>

      <div className={`min-h-0 flex-1 ${workspaceView === "browser" ? "block" : "hidden"}`}>
        <BrowserPanel />
      </div>

      <div className={`min-h-0 flex-1 ${workspaceView === "agents" ? "block" : "hidden"}`}>
        {!paneTree ? (
          <div className="flex h-full items-center justify-center bg-[#1e1e1e]">
            <div className="max-w-md px-6 text-center">
              <div className="text-[13px] font-medium text-white">Your workspace is ready</div>
              <p className="mt-2 text-[12px] leading-5 text-[#8b8b8b]">
                Add a terminal or launch an agent. Each pane will appear here in a focused grid so you can watch the whole team at once.
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <button
                  type="button"
                  className="h-7 bg-[#0e639c] px-3 text-[11px] text-white hover:bg-[#1177bb]"
                  onClick={() => setAddAgentOpen(true)}
                >
                  Add agent
                </button>
                <button
                  type="button"
                  className="h-7 border border-[#45484d] px-3 text-[11px] text-[#c5c8cb] hover:border-[#4ec9b0] hover:text-white"
                  onClick={() => setWorkspaceView("browser")}
                >
                  Open browser
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div
            className="grid h-full min-h-0 auto-rows-[minmax(240px,1fr)] gap-2 overflow-auto bg-[#151719] p-2"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))" }}
          >
            {leaves.map((leaf) => (
              <div key={leaf.id} className="min-h-[240px] min-w-0 overflow-hidden border border-[#34383d] bg-[#1e1e1e] shadow-[0_8px_24px_rgba(0,0,0,0.16)]">
                <TerminalPane paneId={leaf.id} terminalId={leaf.terminalId} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
