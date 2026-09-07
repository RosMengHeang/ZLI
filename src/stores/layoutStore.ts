import { create } from "zustand";
import { newId } from "../lib/ids";
import type { PaneId, PaneNode, SplitDirection, TerminalId } from "../types";
import {
  collectLeaves,
  firstLeafId,
  leafIdForTerminal,
  removePane,
  splitLeaf,
} from "./paneTree";

interface LayoutState {
  paneTree: PaneNode | null;
  activePaneId: PaneId | null;
  gitPanelOpen: boolean;
  addLeaf: (terminalId: TerminalId) => PaneId;
  splitActive: (terminalId: TerminalId, direction: SplitDirection) => PaneId;
  closePane: (paneId: PaneId) => TerminalId | null;
  setActivePane: (paneId: PaneId) => void;
  focusTerminal: (terminalId: TerminalId) => void;
  toggleGitPanel: (open?: boolean) => void;
  leaves: () => { id: PaneId; terminalId: TerminalId }[];
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  paneTree: null,
  activePaneId: null,
  gitPanelOpen: false,

  addLeaf: (terminalId) => {
    const leafId = newId();
    const leaf: PaneNode = { type: "leaf", id: leafId, terminalId };
    const { paneTree, activePaneId } = get();
    if (!paneTree) {
      set({ paneTree: leaf, activePaneId: leafId });
      return leafId;
    }
    const splitFrom = activePaneId ?? firstLeafId(paneTree);
    if (!splitFrom) {
      set({ paneTree: leaf, activePaneId: leafId });
      return leafId;
    }
    const next = splitLeaf(paneTree, splitFrom, terminalId, "horizontal");
    const created = collectLeaves(next).find((item) => item.terminalId === terminalId);
    set({ paneTree: next, activePaneId: created?.id ?? leafId });
    return created?.id ?? leafId;
  },

  splitActive: (terminalId, direction) => {
    const { paneTree, activePaneId } = get();
    if (!paneTree || !activePaneId) return get().addLeaf(terminalId);
    const next = splitLeaf(paneTree, activePaneId, terminalId, direction);
    const created = collectLeaves(next).find((item) => item.terminalId === terminalId);
    set({ paneTree: next, activePaneId: created?.id ?? activePaneId });
    return created?.id ?? activePaneId;
  },

  closePane: (paneId) => {
    const { paneTree, activePaneId } = get();
    if (!paneTree) return null;
    const leaves = collectLeaves(paneTree);
    const closing = leaves.find((leaf) => leaf.id === paneId);
    const next = removePane(paneTree, paneId);
    const nextActive =
      activePaneId === paneId ? firstLeafId(next) : activePaneId && next ? activePaneId : firstLeafId(next);
    set({ paneTree: next, activePaneId: nextActive });
    return closing?.terminalId ?? null;
  },

  setActivePane: (paneId) => set({ activePaneId: paneId }),

  focusTerminal: (terminalId) => {
    const paneId = leafIdForTerminal(get().paneTree, terminalId);
    if (paneId) set({ activePaneId: paneId });
  },

  toggleGitPanel: (open) =>
    set((state) => ({ gitPanelOpen: open ?? !state.gitPanelOpen })),

  leaves: () => collectLeaves(get().paneTree),
}));
