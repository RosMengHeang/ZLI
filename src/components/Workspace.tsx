import { Group, Panel, Separator } from "react-resizable-panels";
import { TerminalPane } from "./TerminalPane";
import { useLayoutStore } from "../stores/layoutStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import type { PaneNode } from "../types";

function PaneTreeView({ node }: { node: PaneNode }) {
  if (node.type === "leaf") {
    return <TerminalPane paneId={node.id} terminalId={node.terminalId} />;
  }
  return (
    <Group orientation={node.direction} className="h-full">
      <Panel defaultSize={`${node.sizes[0]}`} minSize="18">
        <PaneTreeView node={node.first} />
      </Panel>
      <Separator className={`pane-handle ${node.direction === "horizontal" ? "pane-handle-h" : "pane-handle-v"}`} />
      <Panel defaultSize={`${node.sizes[1]}`} minSize="18">
        <PaneTreeView node={node.second} />
      </Panel>
    </Group>
  );
}

export function Workspace() {
  const project = useProjectStore((s) => s.project);
  const paneTree = useLayoutStore((s) => s.paneTree);
  const setAddAgentOpen = useUiStore((s) => s.setAddAgentOpen);

  if (!project) {
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

  if (!paneTree) {
    return (
      <div className="flex h-full items-center justify-center bg-[#1e1e1e]">
        <div className="max-w-md px-6 text-center">
          <div className="text-[13px] font-medium text-white">No terminals</div>
          <p className="mt-2 text-[12px] leading-5 text-[#8b8b8b]">
            Add a terminal pane or launch an agent. Output comes from a real PTY — nothing is
            simulated.
          </p>
          <div className="mt-3 flex justify-center gap-2">
            <button
              type="button"
              className="h-7 bg-[#0e639c] px-3 text-[11px] text-white hover:bg-[#1177bb]"
              onClick={() => setAddAgentOpen(true)}
            >
              Add Agent
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 min-w-0 bg-[#1e1e1e]">
      <PaneTreeView node={paneTree} />
    </div>
  );
}
