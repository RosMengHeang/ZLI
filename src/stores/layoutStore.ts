import { create } from "zustand";
import { newId } from "../lib/ids";
import {
  collectSplitSizeList,
  layoutSignature,
  restoreSplitSizes,
  type LayoutPreset,
} from "../lib/workspaceLayout";
import { getPaneLayout, setPaneLayout } from "../lib/preferences";
import type { PaneId, PaneNode, SplitDirection, TerminalId } from "../types";
import {
  arrangeLeaves,
  collectLeaves,
  firstLeafId,
  leafIdForTerminal,
  preferredSplitDirection,
  removePane,
  splitLeaf,
  updateSplitSizes,
} from "./paneTree";

interface LayoutState {
  paneTree: PaneNode | null;
  activePaneId: PaneId | null;
  gitPanelOpen: boolean;
  autoArrange: boolean;
  addLeaf: (terminalId: TerminalId) => PaneId;
  splitActive: (terminalId: TerminalId, direction: SplitDirection) => PaneId;
  closePane: (paneId: PaneId) => TerminalId | null;
  setActivePane: (paneId: PaneId) => void;
  focusTerminal: (terminalId: TerminalId) => void;
  toggleGitPanel: (open?: boolean) => void;
  setSplitSizes: (splitId: PaneId, sizes: [number, number]) => void;
  applyPreset: (preset: LayoutPreset) => void;
  persistTreeSizes: () => void;
  leaves: () => { id: PaneId; terminalId: TerminalId }[];
}

function withRestoredSizes(tree: PaneNode): PaneNode {
  const signature = layoutSignature(tree);
  const saved = getPaneLayout(signature);
  if (!saved) return tree;
  return restoreSplitSizes(tree, signature, saved);
}

function persist(tree: PaneNode | null): void {
  if (!tree || tree.type === "leaf") return;
  setPaneLayout(layoutSignature(tree), collectSplitSizeList(tree));
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  paneTree: null,
  activePaneId: null,
  gitPanelOpen: false,
  autoArrange: true,

  addLeaf: (terminalId) => {
    const leafId = newId();
    const leaf: PaneNode = { type: "leaf", id: leafId, terminalId };
    const { paneTree, activePaneId, autoArrange } = get();
    if (!paneTree) {
      set({ paneTree: leaf, activePaneId: leafId });
      return leafId;
    }
    const splitFrom = activePaneId ?? firstLeafId(paneTree);
    if (!splitFrom) {
      set({ paneTree: leaf, activePaneId: leafId });
      return leafId;
    }
    const next = autoArrange
      ? arrangeLeaves([...collectLeaves(paneTree), { id: leafId, terminalId }], "grid")!
      : splitLeaf(paneTree, splitFrom, terminalId, preferredSplitDirection(paneTree, splitFrom));
    const created = collectLeaves(next).find((item) => item.terminalId === terminalId);
    persist(next);
    set({ paneTree: next, activePaneId: created?.id ?? leafId });
    return created?.id ?? leafId;
  },

  splitActive: (terminalId, direction) => {
    const { paneTree, activePaneId } = get();
    if (!paneTree || !activePaneId) return get().addLeaf(terminalId);
    const next = withRestoredSizes(splitLeaf(paneTree, activePaneId, terminalId, direction));
    const created = collectLeaves(next).find((item) => item.terminalId === terminalId);
    persist(next);
    set({ paneTree: next, activePaneId: created?.id ?? activePaneId, autoArrange: false });
    return created?.id ?? activePaneId;
  },

  closePane: (paneId) => {
    const { paneTree, activePaneId } = get();
    if (!paneTree) return null;
    const leaves = collectLeaves(paneTree);
    const closing = leaves.find((leaf) => leaf.id === paneId);
    const next = removePane(paneTree, paneId);
    const restored = next;
    persist(restored);
    const nextActive =
      activePaneId === paneId ? firstLeafId(restored) : activePaneId && restored ? activePaneId : firstLeafId(restored);
    set({ paneTree: restored, activePaneId: nextActive });
    return closing?.terminalId ?? null;
  },

  setActivePane: (paneId) => set({ activePaneId: paneId }),

  focusTerminal: (terminalId) => {
    const paneId = leafIdForTerminal(get().paneTree, terminalId);
    if (paneId) set({ activePaneId: paneId });
  },

  toggleGitPanel: (open) =>
    set((state) => ({ gitPanelOpen: open ?? !state.gitPanelOpen })),

  setSplitSizes: (splitId, sizes) => {
    const { paneTree } = get();
    if (!paneTree) return;
    const next = updateSplitSizes(paneTree, splitId, sizes);
    persist(next);
    set({ paneTree: next, autoArrange: false });
  },

  applyPreset: (preset) => {
    const { paneTree, activePaneId } = get();
    if (!paneTree) return;
    const leaves = collectLeaves(paneTree);
    const next = arrangeLeaves(leaves, preset);
    if (!next) return;
    const restored = next;
    persist(restored);
    const stillActive = leaves.some((leaf) => leaf.id === activePaneId);
    set({
      paneTree: restored,
      activePaneId: stillActive ? activePaneId : firstLeafId(restored),
      autoArrange: false,
    });
  },

  persistTreeSizes: () => persist(get().paneTree),

  leaves: () => collectLeaves(get().paneTree),
}));
