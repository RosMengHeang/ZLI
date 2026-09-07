import { create } from "zustand";
import type { Agent } from "../types";

interface UiState {
  browserOpen: boolean;
  addAgentOpen: boolean;
  pathDialogOpen: boolean;
  commitOpen: boolean;
  discardOpen: boolean;
  mergeOpen: boolean;
  helpOpen: boolean;
  setBrowserOpen: (open: boolean) => void;
  setAddAgentOpen: (open: boolean) => void;
  setPathDialogOpen: (open: boolean) => void;
  setCommitOpen: (open: boolean) => void;
  setDiscardOpen: (open: boolean) => void;
  setMergeOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  browserOpen: false,
  addAgentOpen: false,
  pathDialogOpen: false,
  commitOpen: false,
  discardOpen: false,
  mergeOpen: false,
  helpOpen: false,
  setBrowserOpen: (browserOpen) => set({ browserOpen }),
  setAddAgentOpen: (open) => set({ addAgentOpen: open }),
  setPathDialogOpen: (open) => set({ pathDialogOpen: open }),
  setCommitOpen: (open) => set({ commitOpen: open }),
  setDiscardOpen: (open) => set({ discardOpen: open }),
  setMergeOpen: (open) => set({ mergeOpen: open }),
  setHelpOpen: (open) => set({ helpOpen: open }),
}));

export function selectedAgentWorktree(agent: Agent | undefined, fallback: string): string {
  return agent?.worktreePath || agent?.cwd || fallback;
}
