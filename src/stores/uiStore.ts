import { create } from "zustand";
import type { Agent } from "../types";

interface UiState {
  workspaceView: "agents" | "browser";
  addAgentOpen: boolean;
  pathDialogOpen: boolean;
  commitOpen: boolean;
  discardOpen: boolean;
  mergeOpen: boolean;
  setWorkspaceView: (view: "agents" | "browser") => void;
  setAddAgentOpen: (open: boolean) => void;
  setPathDialogOpen: (open: boolean) => void;
  setCommitOpen: (open: boolean) => void;
  setDiscardOpen: (open: boolean) => void;
  setMergeOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  workspaceView: "agents",
  addAgentOpen: false,
  pathDialogOpen: false,
  commitOpen: false,
  discardOpen: false,
  mergeOpen: false,
  setWorkspaceView: (workspaceView) => set({ workspaceView }),
  setAddAgentOpen: (open) => set({ addAgentOpen: open }),
  setPathDialogOpen: (open) => set({ pathDialogOpen: open }),
  setCommitOpen: (open) => set({ commitOpen: open }),
  setDiscardOpen: (open) => set({ discardOpen: open }),
  setMergeOpen: (open) => set({ mergeOpen: open }),
}));

export function selectedAgentWorktree(agent: Agent | undefined, fallback: string): string {
  return agent?.worktreePath || agent?.cwd || fallback;
}
