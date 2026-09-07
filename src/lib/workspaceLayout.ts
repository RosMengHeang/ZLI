import type { PaneNode } from "../types";

export type LayoutPreset = "even" | "focus-left" | "grid";

export function layoutSignature(node: PaneNode | null): string {
  if (!node) return "";
  if (node.type === "leaf") return "L";
  return `${node.direction === "horizontal" ? "h" : "v"}(${layoutSignature(node.first)},${layoutSignature(node.second)})`;
}

export function collectSplitSizeList(node: PaneNode | null): number[] {
  if (!node || node.type === "leaf") return [];
  return [...node.sizes, ...collectSplitSizeList(node.first), ...collectSplitSizeList(node.second)];
}

export function applySplitSizeList(node: PaneNode, sizes: number[]): PaneNode {
  let index = 0;
  const walk = (current: PaneNode): PaneNode => {
    if (current.type === "leaf") return current;
    const firstSize = sizes[index] ?? current.sizes[0];
    const secondSize = sizes[index + 1] ?? current.sizes[1];
    index += 2;
    return {
      ...current,
      sizes: [firstSize, secondSize],
      first: walk(current.first),
      second: walk(current.second),
    };
  };
  return walk(node);
}

export function restoreSplitSizes(node: PaneNode, signature: string, sizes: number[]): PaneNode {
  if (layoutSignature(node) !== signature) return node;
  if (sizes.length < 2) return node;
  return applySplitSizeList(node, sizes);
}
