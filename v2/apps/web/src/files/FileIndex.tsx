import type { FileListEntry, RuntimeProjection } from "@zli-v2/contracts";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { listFiles } from "./fileClient.js";
import {
  type FileLocation,
  type FileReference,
  findFileReferences,
  indexBasenames,
  parseFileReference,
} from "./filePaths.js";
import { emptyFilesSession, type FilesSession } from "./filesSession.js";

export type FileIndex = {
  worktreeId: string;
  root: string;
  entries: readonly FileListEntry[];
  paths: ReadonlySet<string>;
  basenames: ReadonlyMap<string, readonly string[]>;
  truncated: boolean;
  loadedAt: number;
};

export type OpenFileRequest = FileLocation & { worktreeId: string };

type FileIndexContextValue = {
  indexes: ReadonlyMap<string, FileIndex>;
  /**
   * Reloads the list unless the cached one is younger than `maxAgeMs`. With `maxAgeMs` 0 the result
   * always reflects disk as of the call, even when an earlier load is still running.
   */
  refresh(worktreeId: string, maxAgeMs?: number): Promise<FileIndex | undefined>;
  openFile(request: OpenFileRequest): void;
  /** Open tabs and unsaved text for a worktree; the same object every call. */
  session(worktreeId: string): FilesSession;
  /** Changes when worktree folders become known, so lists requested too early load again. */
  rootsKey: string;
};

const FileIndexContext = createContext<FileIndexContextValue | undefined>(undefined);

const selectWorktrees = (projection: RuntimeProjection | undefined) => projection?.worktrees;

/** Shares one file list per worktree between the Files panel, quick open, and path links. */
export function FileIndexProvider({
  children,
  onOpenFile,
}: PropsWithChildren<{ onOpenFile(request: OpenFileRequest): void }>) {
  const { dispatch } = useRuntime();
  const worktrees = useRuntimeSelector(selectWorktrees);
  const [indexes, setIndexes] = useState<ReadonlyMap<string, FileIndex>>(new Map());
  const indexesRef = useRef(indexes);
  indexesRef.current = indexes;
  const inFlight = useRef(new Map<string, Promise<FileIndex | undefined>>());
  const queued = useRef(new Map<string, Promise<FileIndex | undefined>>());
  const rootsRef = useRef(new Map<string, string>());
  rootsRef.current = new Map((worktrees ?? []).map((worktree) => [worktree.worktreeId, worktree.path]));
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;

  const refresh = useCallback(
    (worktreeId: string, maxAgeMs = 0): Promise<FileIndex | undefined> => {
      const cached = indexesRef.current.get(worktreeId);
      if (cached && Date.now() - cached.loadedAt < maxAgeMs) return Promise.resolve(cached);
      const pending = inFlight.current.get(worktreeId);
      if (pending && maxAgeMs > 0) return pending;
      if (pending) {
        // The running load may have listed the folder before a save, so a forced refresh waits for
        // it and loads again. Callers that arrive meanwhile share that one follow-up load.
        const existing = queued.current.get(worktreeId);
        if (existing) return existing;
        const followUp = pending
          .catch(() => undefined)
          .then(() => {
            queued.current.delete(worktreeId);
            return refresh(worktreeId, 0);
          });
        queued.current.set(worktreeId, followUp);
        return followUp;
      }
      const root = rootsRef.current.get(worktreeId);
      if (root === undefined) return Promise.resolve(undefined);
      const request = listFiles(dispatch, worktreeId)
        .then((result) => {
          const paths = new Set(result.files.map((entry) => entry.path));
          const index: FileIndex = {
            worktreeId,
            root,
            entries: result.files,
            paths,
            basenames: indexBasenames(paths),
            truncated: result.truncated,
            loadedAt: Date.now(),
          };
          setIndexes((current) => {
            const previous = current.get(worktreeId);
            // Keep the same object when nothing changed so consumers skip re-rendering.
            if (previous && sameEntries(previous.entries, index.entries) && previous.root === root) {
              previous.loadedAt = index.loadedAt;
              return current;
            }
            const next = new Map(current);
            next.set(worktreeId, index);
            return next;
          });
          return index;
        })
        .finally(() => inFlight.current.delete(worktreeId));
      inFlight.current.set(worktreeId, request);
      return request;
    },
    [dispatch],
  );

  const openFile = useCallback((request: OpenFileRequest) => onOpenFileRef.current(request), []);
  const sessions = useRef(new Map<string, FilesSession>());
  const session = useCallback((worktreeId: string) => {
    let existing = sessions.current.get(worktreeId);
    if (!existing) {
      existing = emptyFilesSession();
      sessions.current.set(worktreeId, existing);
    }
    return existing;
  }, []);
  const rootsKey = [...rootsRef.current.entries()].map(([id, path]) => `${id}=${path}`).join("\n");
  const value = useMemo(
    () => ({ indexes, refresh, openFile, session, rootsKey }),
    [indexes, refresh, openFile, session, rootsKey],
  );
  return <FileIndexContext.Provider value={value}>{children}</FileIndexContext.Provider>;
}

function sameEntries(left: readonly FileListEntry[], right: readonly FileListEntry[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a?.path !== b?.path || a?.status !== b?.status) return false;
  }
  return true;
}

export function useFileIndexContext(): FileIndexContextValue | undefined {
  return useContext(FileIndexContext);
}

/** The cached file list for a worktree, loaded on first use and reloaded when older than `maxAgeMs` or `refreshKey` changes. */
export function useFileIndex(
  worktreeId: string | undefined,
  options: { maxAgeMs?: number; refreshKey?: unknown } = {},
): FileIndex | undefined {
  const context = useContext(FileIndexContext);
  const maxAgeMs = options.maxAgeMs ?? 15_000;
  const refreshKey = options.refreshKey;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey only signals that a reload may be due.
  useEffect(() => {
    if (!context || !worktreeId) return;
    void context.refresh(worktreeId, maxAgeMs).catch(() => undefined);
  }, [context?.refresh, context?.rootsKey, worktreeId, maxAgeMs, refreshKey]);
  return worktreeId ? context?.indexes.get(worktreeId) : undefined;
}

export type FileLinks = {
  /** Every file reference in a line of text. */
  find(text: string): FileReference[];
  /** The file a whole token such as `src/app.ts:12` points to. */
  resolve(text: string): FileLocation | undefined;
  open(location: FileLocation): void;
  /** Reloads the file list in the background when it may be out of date. */
  touch(): void;
};

/** Path detection and opening for chat replies and terminal output in one worktree. */
export function useFileLinks(worktreeId: string | undefined, refreshKey?: unknown): FileLinks | undefined {
  const context = useContext(FileIndexContext);
  const index = useFileIndex(worktreeId, { refreshKey });
  return useMemo(() => {
    if (!context || !worktreeId || !index) return undefined;
    return {
      find: (text) => findFileReferences(text, index.root, index.paths, index.basenames),
      resolve: (text) => parseFileReference(text, index.root, index.paths, index.basenames),
      open: (location) => context.openFile({ worktreeId, ...location }),
      touch: () => void context.refresh(worktreeId, 15_000).catch(() => undefined),
    };
  }, [context, worktreeId, index]);
}
