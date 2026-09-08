import { create } from "zustand";
import { toAppError } from "../lib/errors";
import { isCommandMissing } from "../lib/errors";
import { setLastProjectPath } from "../lib/preferences";
import {
  pickProjectDirectory,
  repositoryToProject,
  validateRepository,
} from "../tauri/project";
import type { AppError, ProjectInfo } from "../types";
import { useWorkspaceStore } from "./workspaceStore";

interface ProjectState {
  project: ProjectInfo | null;
  loading: boolean;
  error: AppError | null;
  openFromDialog: () => Promise<"opened" | "cancelled" | "failed">;
  openFromPath: (path: string) => Promise<boolean>;
  clearError: () => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  project: null,
  loading: false,
  error: null,

  openFromDialog: async () => {
    set({ loading: true, error: null });
    try {
      const selected = await pickProjectDirectory();
      if (!selected) {
        set({ loading: false });
        return "cancelled";
      }
      const info = await validateRepository(selected);
      const project = repositoryToProject(info);
      setLastProjectPath(project.path);
      useWorkspaceStore.getState().rememberProject(project);
      set({ project, loading: false, error: null });
      return "opened";
    } catch (err) {
      const parsed = toAppError(err);
      set({
        loading: false,
        error: isCommandMissing(parsed) || parsed.code === "plugin_unavailable"
          ? {
              code: parsed.code,
              message:
                "Folder picker is unavailable. Enter a repository path instead.",
            }
          : parsed,
      });
      return "failed";
    }
  },

  openFromPath: async (path) => {
    const trimmed = path.trim();
    if (!trimmed) {
      set({ error: { code: "invalidInput", message: "Enter a repository path." } });
      return false;
    }
    set({ loading: true, error: null });
    try {
      const info = await validateRepository(trimmed);
      const project = repositoryToProject(info);
      setLastProjectPath(project.path);
      useWorkspaceStore.getState().rememberProject(project);
      set({ project, loading: false, error: null });
      return true;
    } catch (err) {
      set({ loading: false, error: toAppError(err) });
      return false;
    }
  },

  clearError: () => set({ error: null }),
}));
