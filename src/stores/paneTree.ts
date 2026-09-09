import type { LeafPane, PaneId, PaneNode, SplitDirection, SplitPaneNode, TerminalId } from "../types";
import { newId } from "../lib/ids.ts";
import type { LayoutPreset } from "../lib/workspaceLayout";

export function collectLeaves(node: PaneNode | null): { id: PaneId; terminalId: TerminalId }[] {
  if (!node) return [];
  if (node.type === "leaf") return [{ id: node.id, terminalId: node.terminalId }];
  return [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

export function findLeaf(node: PaneNode | null, paneId: PaneId): PaneNode | null {
  if (!node) return null;
  if (node.type === "leaf") return node.id === paneId ? node : null;
  return findLeaf(node.first, paneId) ?? findLeaf(node.second, paneId);
}

export function visiblePaneTree(node: PaneNode | null, focusedPaneId: PaneId | null): PaneNode | null {
  if (!node || !focusedPaneId) return node;
  return findLeaf(node, focusedPaneId) ?? node;
}

export function replaceNode(node: PaneNode, targetId: PaneId, next: PaneNode): PaneNode {
  if (node.id === targetId) return next;
  if (node.type === "leaf") return node;
  return {
    ...node,
    first: replaceNode(node.first, targetId, next),
    second: replaceNode(node.second, targetId, next),
  };
}

export function removePane(node: PaneNode, targetId: PaneId): PaneNode | null {
  if (node.id === targetId) return null;
  if (node.type === "leaf") return node;
  if (node.first.id === targetId) return node.second;
  if (node.second.id === targetId) return node.first;
  const first = removePane(node.first, targetId);
  const second = removePane(node.second, targetId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function splitLeaf(
  node: PaneNode,
  leafId: PaneId,
  newTerminalId: TerminalId,
  direction: SplitDirection,
): PaneNode {
  const target = findLeaf(node, leafId);
  if (!target || target.type !== "leaf") {
    return {
      type: "split",
      id: newId(),
      direction,
      sizes: [50, 50],
      first: node,
      second: { type: "leaf", id: newId(), terminalId: newTerminalId },
    };
  }
  const newLeaf: PaneNode = { type: "leaf", id: newId(), terminalId: newTerminalId };
  const split: PaneNode = {
    type: "split",
    id: newId(),
    direction,
    sizes: [50, 50],
    first: target,
    second: newLeaf,
  };
  return replaceNode(node, leafId, split);
}

export function firstLeafId(node: PaneNode | null): PaneId | null {
  if (!node) return null;
  if (node.type === "leaf") return node.id;
  return firstLeafId(node.first);
}

export function leafIdForTerminal(node: PaneNode | null, terminalId: TerminalId): PaneId | null {
  if (!node) return null;
  if (node.type === "leaf") return node.terminalId === terminalId ? node.id : null;
  return leafIdForTerminal(node.first, terminalId) ?? leafIdForTerminal(node.second, terminalId);
}

export function findParent(node: PaneNode | null, childId: PaneId): SplitPaneNode | null {
  if (!node || node.type === "leaf") return null;
  if (node.first.id === childId || node.second.id === childId) return node;
  return findParent(node.first, childId) ?? findParent(node.second, childId);
}

export function preferredSplitDirection(root: PaneNode, leafId: PaneId): SplitDirection {
  const parent = findParent(root, leafId);
  if (!parent) return "horizontal";
  return parent.direction === "horizontal" ? "vertical" : "horizontal";
}

export function updateSplitSizes(node: PaneNode, splitId: PaneId, sizes: [number, number]): PaneNode {
  if (node.type === "leaf") return node;
  if (node.id === splitId) return { ...node, sizes };
  return {
    ...node,
    first: updateSplitSizes(node.first, splitId, sizes),
    second: updateSplitSizes(node.second, splitId, sizes),
  };
}

function asLeaf(item: { id: PaneId; terminalId: TerminalId }): LeafPane {
  return { type: "leaf", id: item.id, terminalId: item.terminalId };
}

function splitOf(
  direction: SplitDirection,
  first: PaneNode,
  second: PaneNode,
  sizes: [number, number] = [50, 50],
): SplitPaneNode {
  return { type: "split", id: newId(), direction, sizes, first, second };
}

function stack(direction: SplitDirection, nodes: PaneNode[]): PaneNode {
  return nodes.reduce((acc, node) => splitOf(direction, acc, node));
}

function threeColumnGrid(first: PaneNode, second: PaneNode, third: PaneNode): PaneNode {
  return splitOf(
    "horizontal",
    splitOf("horizontal", first, second),
    third,
    [66.67, 33.33],
  );
}

function nestEven(nodes: PaneNode[], direction: SplitDirection): PaneNode {
  if (nodes.length === 1) return nodes[0];
  if (nodes.length === 2) return splitOf(direction, nodes[0], nodes[1]);
  const mid = Math.ceil(nodes.length / 2);
  const cross: SplitDirection = direction === "horizontal" ? "vertical" : "horizontal";
  return splitOf(direction, nestEven(nodes.slice(0, mid), cross), nestEven(nodes.slice(mid), cross));
}

export function arrangeLeaves(
  leaves: { id: PaneId; terminalId: TerminalId }[],
  preset: LayoutPreset,
): PaneNode | null {
  if (leaves.length === 0) return null;
  const nodes = leaves.map(asLeaf);
  if (nodes.length === 1) return nodes[0];

  if (preset === "focus-left" || (preset === "even" && nodes.length === 3)) {
    if (nodes.length === 2) return splitOf("horizontal", nodes[0], nodes[1]);
    const [first, ...rest] = nodes;
    return splitOf("horizontal", first, stack("vertical", rest), [62, 38]);
  }

  if (preset === "grid") {
    if (nodes.length < 3) return nestEven(nodes, "horizontal");
    if (nodes.length === 3) {
      return splitOf("horizontal", nodes[0], stack("vertical", nodes.slice(1)), [58, 42]);
    }
    if (nodes.length === 5) {
      return threeColumnGrid(
        stack("vertical", [nodes[0], nodes[2]]),
        stack("vertical", [nodes[1], nodes[3]]),
        nodes[4],
      );
    }
    if (nodes.length === 6) {
      return threeColumnGrid(
        stack("vertical", [nodes[0], nodes[3]]),
        stack("vertical", [nodes[1], nodes[4]]),
        stack("vertical", [nodes[2], nodes[5]]),
      );
    }
    const left: PaneNode[] = [];
    const right: PaneNode[] = [];
    nodes.forEach((node, index) => (index % 2 === 0 ? left : right).push(node));
    return splitOf("horizontal", stack("vertical", left), stack("vertical", right));
  }

  return nestEven(nodes, "horizontal");
}
