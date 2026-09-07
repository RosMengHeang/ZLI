import type { PaneId, PaneNode, SplitDirection, TerminalId } from "../types";
import { newId } from "../lib/ids";

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
