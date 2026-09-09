import { create } from "zustand";
import { getThemePreference, setThemePreference } from "../lib/preferences";
import type { ThemeMode } from "../lib/theme";
import type { Agent } from "../types";

interface UiState {
  browserOpen: boolean;
  browserUrl: string;
  taxChatOpen: boolean;
  commandPaletteOpen: boolean;
  setBrowserUrl: (url: string) => void;
  addAgentOpen: boolean;
  pathDialogOpen: boolean;
  commitOpen: boolean;
  discardOpen: boolean;
  worktreeOpen: boolean;
  worktreeProjectRoot: string | null;
  mergeOpen: boolean;
  helpOpen: boolean;
  preferencesOpen: boolean;
  themeMode: ThemeMode;
  setBrowserOpen: (open: boolean) => void;
  setTaxChatOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setAddAgentOpen: (open: boolean) => void;
  setPathDialogOpen: (open: boolean) => void;
  setCommitOpen: (open: boolean) => void;
  setDiscardOpen: (open: boolean) => void;
  setWorktreeOpen: (open: boolean) => void;
  setWorktreeProjectRoot: (root: string | null) => void;
  setMergeOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  setPreferencesOpen: (open: boolean) => void;
  setThemeMode: (mode: ThemeMode) => void;
}

export const useUiStore = create<UiState>((set) => ({
  browserOpen: false,
  browserUrl: "",
  taxChatOpen: false,
  commandPaletteOpen: false,
  setBrowserUrl: (browserUrl) => set({ browserUrl }),
  addAgentOpen: false,
  pathDialogOpen: false,
  commitOpen: false,
  discardOpen: false,
  worktreeOpen: false,
  worktreeProjectRoot: null,
  mergeOpen: false,
  helpOpen: false,
  preferencesOpen: false,
  themeMode: getThemePreference(),
  setBrowserOpen: (browserOpen) => set({ browserOpen }),
  setTaxChatOpen: (taxChatOpen) => set({ taxChatOpen }),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  setAddAgentOpen: (open) => set({ addAgentOpen: open }),
  setPathDialogOpen: (open) => set({ pathDialogOpen: open }),
  setCommitOpen: (open) => set({ commitOpen: open }),
  setDiscardOpen: (open) => set({ discardOpen: open }),
  setWorktreeOpen: (open) => set({ worktreeOpen: open }),
  setWorktreeProjectRoot: (worktreeProjectRoot) => set({ worktreeProjectRoot }),
  setMergeOpen: (open) => set({ mergeOpen: open }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  setPreferencesOpen: (open) => set({ preferencesOpen: open }),
  setThemeMode: (themeMode) => {
    setThemePreference(themeMode);
    set({ themeMode });
  },
}));

export function selectedAgentWorktree(agent: Agent | undefined, fallback: string): string {
  return agent?.worktreePath || agent?.cwd || fallback;
}
