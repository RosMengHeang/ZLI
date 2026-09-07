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
  refresh: (worktreePath: string, options?: { quiet?: boolean; minIntervalMs?: number }) => Promise<GitStatus | null>;
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

const refreshSeq = new Map<string, number>();
const lastRefreshAt = new Map<string, number>();
let diffSeq = 0;

export const useGitStore = create<GitState>((set, get) => ({
  statusByPath: {},
  diffs: {},
  selectedPath: null,
  loading: false,
  diffLoading: false,
  error: null,
  mergeOutcome: null,
  lastCommit: null,

  refresh: async (worktreePath, options) => {
    const quiet = options?.quiet ?? false;
    const minIntervalMs = options?.minIntervalMs ?? 0;
    const cached = get().statusByPath[worktreePath];
    const now = Date.now();
    if (minIntervalMs > 0 && cached && now - (lastRefreshAt.get(worktreePath) ?? 0) < minIntervalMs) {
      return cached;
    }

    const seq = (refreshSeq.get(worktreePath) ?? 0) + 1;
    refreshSeq.set(worktreePath, seq);
    set({
      loading: quiet && cached ? get().loading : true,
      error: quiet ? get().error : null,
    });
    try {
      const status = await gitStatus(worktreePath);
      if (refreshSeq.get(worktreePath) !== seq) return get().statusByPath[worktreePath] ?? status;
      lastRefreshAt.set(worktreePath, Date.now());
      set((state) => ({
        statusByPath: { ...state.statusByPath, [worktreePath]: status },
        loading: false,
      }));
      return status;
    } catch (err) {
      if (refreshSeq.get(worktreePath) !== seq) return get().statusByPath[worktreePath] ?? null;
      set({ loading: false, error: quiet ? get().error : toAppError(err) });
      return null;
    }
  },

  loadDiff: async (worktreePath, filePath) => {
    const seq = ++diffSeq;
    set({ diffLoading: true, error: null, selectedPath: filePath });
    try {
      const files = await gitDiff(worktreePath, filePath);
      if (seq !== diffSeq) return;
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
      if (seq !== diffSeq) return;
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
