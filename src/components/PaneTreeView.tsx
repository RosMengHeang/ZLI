import { Group, Panel, Separator } from "react-resizable-panels";
import { TerminalPane } from "./TerminalPane";
import { useLayoutStore } from "../stores/layoutStore";
import type { PaneNode } from "../types";
import { minimumWorkspaceSize, workspacePanelMinSize } from "../lib/workspaceLayout";

interface PaneTreeViewProps {
  node: PaneNode;
  allowCompression?: boolean;
}

export function PaneTreeView({ node, allowCompression = false }: PaneTreeViewProps) {
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
  const firstMinSize = workspacePanelMinSize(horizontal ? firstMinimum.width : firstMinimum.height, allowCompression);
  const secondMinSize = workspacePanelMinSize(horizontal ? secondMinimum.width : secondMinimum.height, allowCompression);

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
      <Panel id={firstId} minSize={firstMinSize} defaultSize={String(node.sizes[0])} className="min-h-0 min-w-0">
        <PaneTreeView node={node.first} allowCompression={allowCompression} />
      </Panel>
      <Separator className={`pane-handle ${horizontal ? "pane-handle-h" : "pane-handle-v"}`} />
      <Panel id={secondId} minSize={secondMinSize} defaultSize={String(node.sizes[1])} className="min-h-0 min-w-0">
        <PaneTreeView node={node.second} allowCompression={allowCompression} />
      </Panel>
    </Group>
  );
}
