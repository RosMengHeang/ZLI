import { Group, Panel, Separator } from "react-resizable-panels";
import { TerminalPane } from "./TerminalPane";
import { useLayoutStore } from "../stores/layoutStore";
import type { PaneNode } from "../types";
import { minimumWorkspaceSize } from "../lib/workspaceLayout";

interface PaneTreeViewProps {
  node: PaneNode;
}

export function PaneTreeView({ node }: PaneTreeViewProps) {
  const setSplitSizes = useLayoutStore((s) => s.setSplitSizes);

  if (node.type === "leaf") {
    return (
      <div className="workspace-tile h-full min-h-0 min-w-0">
        <TerminalPane paneId={node.id} terminalId={node.terminalId} />
      </div>
    );
  }

  const firstId = `${node.id}-a`;
  const secondId = `${node.id}-b`;
  const horizontal = node.direction === "horizontal";
  const firstMinimum = minimumWorkspaceSize(node.first);
  const secondMinimum = minimumWorkspaceSize(node.second);

  return (
    <Group
      id={node.id}
      orientation={horizontal ? "horizontal" : "vertical"}
      className="h-full min-h-0 min-w-0"
      defaultLayout={{
        [firstId]: node.sizes[0],
        [secondId]: node.sizes[1],
      }}
      onLayoutChanged={(layout, meta) => {
        if (!meta.isUserInteraction) return;
        const first = layout[firstId];
        const second = layout[secondId];
        if (first == null || second == null) return;
        setSplitSizes(node.id, [first, second]);
      }}
    >
      <Panel id={firstId} minSize={`${horizontal ? firstMinimum.width : firstMinimum.height}px`} defaultSize={String(node.sizes[0])} className="min-h-0 min-w-0">
        <PaneTreeView node={node.first} />
      </Panel>
      <Separator className={`pane-handle ${horizontal ? "pane-handle-h" : "pane-handle-v"}`} />
      <Panel id={secondId} minSize={`${horizontal ? secondMinimum.width : secondMinimum.height}px`} defaultSize={String(node.sizes[1])} className="min-h-0 min-w-0">
        <PaneTreeView node={node.second} />
      </Panel>
    </Group>
  );
}
