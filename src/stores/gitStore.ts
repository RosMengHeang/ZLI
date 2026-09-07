import { create } from "zustand";
import { isCommandMissing, toAppError } from "../lib/errors";
import {
  gitAbortMerge,
  gitCommit,
  gitDeleteBranch,
  gitDiff,
  gitMerge,
  gitRemoveWorktree,
  gitStatus,
} from "../tauri/git";
import type {
  AppError,
  CommitRequest,
  CommitResult,
  FileDiff,
  GitStatus,
  MergeOutcome,
  MergeRequest,
  RemovedWorktreeResult,
} from "../types";

interface GitState {
  statusByPath: Record<string, GitStatus>;
  diffs: Record<string, FileDiff>;
  selectedPath: string | null;
  loading: boolean;
  diffLoading: boolean;
  error: AppError | null;
  mergeOutcome: MergeOutcome | null;
  lastCommit: CommitResult | null;
  refresh: (worktreePath: string) => Promise<GitStatus | null>;
  loadDiff: (worktreePath: string, filePath: string) => Promise<void>;
  selectFile: (path: string | null) => void;
  commit: (request: CommitRequest) => Promise<CommitResult>;
  merge: (request: MergeRequest) => Promise<MergeOutcome>;
  abortMerge: (repositoryRoot: string) => Promise<void>;
  discardWorktree: (args: {
    repositoryRoot: string;
    worktreePath: string;
    branch?: string;
  }) => Promise<RemovedWorktreeResult>;
  clearError: () => void;
}

function diffKey(worktreePath: string, filePath: string): string {
  return `${worktreePath}::${filePath}`;
}

export const useGitStore = create<GitState>((set, get) => ({
  statusByPath: {},
  diffs: {},
  selectedPath: null,
  loading: false,
  diffLoading: false,
  error: null,
  mergeOutcome: null,
  lastCommit: null,

  refresh: async (worktreePath) => {
    set({ loading: true, error: null });
    try {
      const status = await gitStatus(worktreePath);
      set((state) => ({
        statusByPath: { ...state.statusByPath, [worktreePath]: status },
        loading: false,
      }));
      return status;
    } catch (err) {
      set({ loading: false, error: toAppError(err) });
      return null;
    }
  },

  loadDiff: async (worktreePath, filePath) => {
    set({ diffLoading: true, error: null, selectedPath: filePath });
    try {
      const files = await gitDiff(worktreePath, filePath);
      const match = files.find((file) => file.path === filePath) ?? files[0];
      if (match) {
        set((state) => ({
          diffs: { ...state.diffs, [diffKey(worktreePath, match.path)]: match },
          diffLoading: false,
        }));
      } else {
        set({ diffLoading: false });
      }
    } catch (err) {
      set({ diffLoading: false, error: toAppError(err) });
    }
  },

  selectFile: (path) => set({ selectedPath: path }),

  commit: async (request) => {
    set({ error: null });
    try {
      const result = await gitCommit(request);
      set({ lastCommit: result });
      await get().refresh(request.worktreePath);
      return result;
    } catch (err) {
      const parsed = toAppError(err);
      set({ error: parsed });
      throw parsed;
    }
  },

  merge: async (request) => {
    set({ error: null, mergeOutcome: null });
    try {
      const outcome = await gitMerge(request);
      set({ mergeOutcome: outcome });
      if (outcome.outcome === "conflict") {
        set({
          error: {
            code: "mergeConflict",
            message: `Merge conflict: ${outcome.sourceBranch} → ${outcome.targetBranch} (${outcome.conflictedFiles.length} files).`,
            details: outcome.conflictedFiles.join("\n"),
          },
        });
      }
      return outcome;
    } catch (err) {
      const parsed = toAppError(err);
      set({ error: parsed });
      throw parsed;
    }
  },

  abortMerge: async (repositoryRoot) => {
    try {
      await gitAbortMerge(repositoryRoot);
      set({ mergeOutcome: null, error: null });
    } catch (err) {
      const parsed = toAppError(err);
      set({ error: parsed });
      throw parsed;
    }
  },

  discardWorktree: async ({ repositoryRoot, worktreePath, branch }) => {
    set({ error: null });
    try {
      const result = await gitRemoveWorktree({
        repositoryRoot,
        worktreePath,
        force: true,
      });
      if (branch) {
        try {
          await gitDeleteBranch({ repositoryRoot, branch, force: true });
        } catch (err) {
          const parsed = toAppError(err);
          if (!isCommandMissing(parsed) && parsed.code !== "invalidInput") {
            set({ error: parsed });
          }
        }
      }
      set((state) => {
        const next = { ...state.statusByPath };
        delete next[worktreePath];
        return { statusByPath: next, selectedPath: null, mergeOutcome: null };
      });
      return result;
    } catch (err) {
      const parsed = toAppError(err);
      set({ error: parsed });
      throw parsed;
    }
  },

  clearError: () => set({ error: null, mergeOutcome: null }),
}));
