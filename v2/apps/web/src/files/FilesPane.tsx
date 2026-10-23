import type {
  FileChangeStatus,
  FileListEntry,
  FileReadResult,
  RuntimeProjection,
  WorktreeProjection,
} from "@zli-v2/contracts";
import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { useAppSettings } from "../settings/appSettings.js";
import { useShortcut } from "../shell/keybindings.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { EmptyState, LoadingState, PaneHeader } from "../ui/Pane.js";
import { type CodeEditorHandle, createCodeEditor, languageLabel } from "./codeEditor.js";
import { type DiffSource, FileDiffPanel, latestTurnFor } from "./FileDiffPanel.js";
import { useFileIndex, useFileIndexContext } from "./FileIndex.js";
import { FileSearchView, type SearchSettings } from "./FileSearchView.js";
import { FilesDivider } from "./FilesDivider.js";
import { FileStatusMark, FileTreeView, LineCounts } from "./FileTreeView.js";
import { readFile, writeFile } from "./fileClient.js";
import { baseName, dirName, type FileLocation } from "./filePaths.js";
import { clampTreeWidth, maxTreeWidth, TREE_DEFAULT_WIDTH, TREE_MIN_WIDTH, useFilesLayout } from "./filesLayout.js";
import { ancestorDirectories } from "./fileTree.js";
import { FILE_VIEW_MODES, type FileViewMode, previewKind, useFileViewModes } from "./fileViewModes.js";
import type { PreviewHandle } from "./MarkdownPreview.js";

const MarkdownPreview = lazy(() =>
  import("./MarkdownPreview.js").then((module) => ({ default: module.MarkdownPreview })),
);

export type FilesFocus =
  | { kind: "open"; path: string; line?: number | undefined; column?: number | undefined; nonce: number }
  | { kind: "search"; nonce: number };

const selectCheckpoints = (projection: RuntimeProjection | undefined) => projection?.checkpoints;

/** How often the open file and the change markers are checked against the disk. */
const POLL_MS = 4_000;
/** Below this width the tree and the editor take turns instead of sitting side by side. */
const SPLIT_MIN_WIDTH = 560;
const DRAFT_DELAY_MS = 150;

type LoadedFile = {
  status: "ready";
  file: FileReadResult;
  saving?: boolean;
  saveError?: string | undefined;
  /** A save was refused because the file changed on disk after it was read. */
  conflict?: boolean;
  /** A newer version on disk that arrived while this file had unsaved edits. */
  diskChange?: FileReadResult | undefined;
  dismissedVersion?: string | undefined;
  /** The file disappeared from disk while open. */
  deleted?: boolean;
};
type TabData = { status: "loading" } | { status: "error"; message: string } | LoadedFile;

function sameText(left: string, right: string): boolean {
  return left === right || left.replace(/\r\n?/gu, "\n") === right.replace(/\r\n?/gu, "\n");
}

function isMissing(message: string): boolean {
  return message.startsWith("File not found");
}

export function FilesPane({
  worktree,
  focus,
  onOpenDiff,
  onQuickOpen,
}: {
  worktree: WorktreeProjection | undefined;
  focus?: FilesFocus | undefined;
  onOpenDiff(path: string): void;
  onQuickOpen(): void;
}) {
  if (worktree?.status !== "ready") {
    return (
      <div className="tool-pane files-pane">
        <PaneHeader icon="folderTree" title="Files" detail={worktree?.branch} />
        <EmptyState
          icon="folderTree"
          title={worktree ? "The worktree is not ready yet" : "Select a worktree"}
          detail={
            worktree
              ? "Files appear once Git finishes preparing the folder."
              : "Files are shown for the worktree of the focused agent."
          }
        />
      </div>
    );
  }
  return (
    <FilesWorkspace
      key={worktree.worktreeId}
      worktree={worktree}
      focus={focus}
      onOpenDiff={onOpenDiff}
      onQuickOpen={onQuickOpen}
    />
  );
}

function FilesWorkspace({
  worktree,
  focus,
  onOpenDiff,
  onQuickOpen,
}: {
  worktree: WorktreeProjection;
  focus: FilesFocus | undefined;
  onOpenDiff(path: string): void;
  onQuickOpen(): void;
}) {
  const { dispatch } = useRuntime();
  const quickOpenShortcut = useShortcut("quickOpen");
  const context = useFileIndexContext();
  if (!context) throw new Error("FilesPane must be used inside FileIndexProvider.");
  const worktreeId = worktree.worktreeId;
  const session = context.session(worktreeId);
  const index = useFileIndex(worktreeId, { maxAgeMs: 2_000 });
  const [tabs, setTabs] = useState(session.tabs);
  const [activePath, setActivePath] = useState(session.activePath);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(session.expanded);
  const [mode, setMode] = useState(session.mode);
  const [changedOnly, setChangedOnly] = useState(session.changedOnly);
  const [changedOpen, setChangedOpen] = useState(session.changedOpen);
  const [diffSource, setDiffSource] = useState<DiffSource>(session.diffSource);
  /** The open file whose diff is showing in place of its contents. */
  const [diffPath, setDiffPath] = useState<string>();
  const checkpoints = useRuntimeSelector(selectCheckpoints);
  const [search, setSearch] = useState<SearchSettings>(session.search);
  const [tabData, setTabData] = useState<ReadonlyMap<string, TabData>>(new Map());
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set(session.drafts.keys()));
  const [revealKey, setRevealKey] = useState(0);
  const [searchFocusKey, setSearchFocusKey] = useState(0);
  const [closeRequest, setCloseRequest] = useState<string>();
  const [paneWidth, setPaneWidth] = useState<number>();
  const wide = paneWidth === undefined || paneWidth >= SPLIT_MIN_WIDTH;
  const [browseOpen, setBrowseOpen] = useState(session.tabs.length === 0);
  const [layout, updateLayout] = useFilesLayout();
  const [viewModes, setViewMode] = useFileViewModes();
  const [previewReveal, setPreviewReveal] = useState<{ path: string; line: number; nonce: number }>();
  const viewTabsId = useId();
  const filePanelId = useId();
  const treeHidden = layout.treeHidden;
  const treeOnRight = useAppSettings().fileTreePosition !== "left";
  const browserId = useId();
  const browserRef = useRef<HTMLDivElement>(null);
  const [generation, setGeneration] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<{ path: string; handle: CodeEditorHandle } | undefined>(undefined);
  const pendingReveal = useRef<FileLocation | undefined>(undefined);
  const tabDataRef = useRef(tabData);
  tabDataRef.current = tabData;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    session.tabs = tabs;
    session.activePath = activePath;
    session.expanded = new Set(expanded);
    session.mode = mode;
    session.changedOnly = changedOnly;
    session.changedOpen = changedOpen;
    session.diffSource = diffSource;
    session.search = search;
  }, [session, tabs, activePath, expanded, mode, changedOnly, changedOpen, diffSource, search]);

  const changes = useMemo(() => {
    const map = new Map<string, FileListEntry & { status: FileChangeStatus }>();
    for (const entry of index?.entries ?? []) if (entry.status) map.set(entry.path, { ...entry, status: entry.status });
    return map;
  }, [index]);
  const statuses = useMemo(() => new Map([...changes].map(([path, entry]) => [path, entry.status])), [changes]);
  const treeEntries = useMemo(
    () => (changedOnly ? (index?.entries ?? []).filter((entry) => entry.status) : (index?.entries ?? [])),
    [changedOnly, index],
  );
  const treeExpanded = useMemo(() => {
    if (!changedOnly) return expanded;
    // The changed-files view is short, so every folder in it starts open.
    const all = new Set(expanded);
    for (const entry of treeEntries) for (const folder of ancestorDirectories(entry.path)) all.add(folder);
    return all;
  }, [changedOnly, expanded, treeEntries]);

  const updateTab = useCallback((path: string, update: (current: TabData | undefined) => TabData | undefined) => {
    setTabData((current) => {
      const next = new Map(current);
      const value = update(current.get(path));
      if (value) next.set(path, value);
      else next.delete(path);
      return next;
    });
  }, []);

  const setDraft = useCallback(
    (path: string, text: string | undefined) => {
      if (text === undefined) session.drafts.delete(path);
      else session.drafts.set(path, text);
      setDirty((current) => {
        const has = current.has(path);
        if (has === (text !== undefined)) return current;
        const next = new Set(current);
        if (text === undefined) next.delete(path);
        else next.add(path);
        return next;
      });
    },
    [session],
  );

  /** Copies the editor text into the draft store so it survives tab switches and closing the panel. */
  const captureDraft = useCallback(
    (path: string, handle: CodeEditorHandle) => {
      const data = tabDataRef.current.get(path);
      if (data?.status !== "ready" || data.file.content === undefined) return;
      const text = handle.getDoc();
      setDraft(path, sameText(text, data.file.content) ? undefined : text);
    },
    [setDraft],
  );

  const loadFile = useCallback(
    async (path: string) => {
      updateTab(path, (current) => (current?.status === "ready" ? current : { status: "loading" }));
      try {
        const file = await readFile(dispatch, worktreeId, path);
        updateTab(path, () => ({ status: "ready", file }));
      } catch (cause) {
        updateTab(path, () => ({
          status: "error",
          message: cause instanceof Error ? cause.message : "The file could not be opened.",
        }));
      }
    },
    [dispatch, worktreeId, updateTab],
  );

  const openPath = useCallback(
    (location: FileLocation) => {
      const { path } = location;
      setTabs((current) => (current.includes(path) ? current : [...current, path]));
      setActivePath(path);
      setExpanded((current) => {
        const folders = ancestorDirectories(path).filter((folder) => !current.has(folder));
        return folders.length === 0 ? current : new Set([...current, ...folders]);
      });
      setRevealKey((key) => key + 1);
      setBrowseOpen(false);
      setCloseRequest(undefined);
      pendingReveal.current = location.line ? location : undefined;
      if (location.line) {
        const line = location.line;
        setPreviewReveal((current) => ({ path, line, nonce: (current?.nonce ?? 0) + 1 }));
      }
      const editor = editorRef.current;
      if (editor?.path === path && location.line) {
        editor.handle.revealLine(location.line, location.column);
        pendingReveal.current = undefined;
      }
      const data = tabDataRef.current.get(path);
      if (!data || data.status === "error") void loadFile(path);
    },
    [loadFile],
  );

  // Tabs restored from an earlier visit load lazily, starting with the visible one.
  useEffect(() => {
    if (activePath && !tabDataRef.current.has(activePath)) void loadFile(activePath);
  }, [activePath, loadFile]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new focus request should act.
  useEffect(() => {
    if (!focus) return;
    if (focus.kind === "open") openPath(focus);
    else {
      setMode("search");
      updateLayout({ treeHidden: false });
      setBrowseOpen(true);
      setSearchFocusKey((key) => key + 1);
    }
  }, [focus?.nonce]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setPaneWidth(entry.contentRect.width);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  /** Picks up edits other programs (usually agents) made to the open file. */
  const checkActiveFile = useCallback(async () => {
    const path = activePathRef.current;
    const data = path ? tabDataRef.current.get(path) : undefined;
    if (!path || data?.status !== "ready" || data.saving) return;
    let latest: FileReadResult;
    try {
      latest = await readFile(dispatch, worktreeId, path);
    } catch (cause) {
      if (cause instanceof Error && isMissing(cause.message)) {
        updateTab(path, (current) => (current?.status === "ready" ? { ...current, deleted: true } : current));
      }
      return;
    }
    const current = tabDataRef.current.get(path);
    if (current?.status !== "ready" || current.saving) return;
    const open = editorRef.current;
    if (open?.path === path) captureDraft(path, open.handle);
    if (current.deleted) updateTab(path, () => ({ ...current, deleted: false }));
    if (latest.version === current.file.version) return;
    if (session.drafts.has(path)) {
      if (current.dismissedVersion === latest.version || current.diskChange?.version === latest.version) return;
      updateTab(path, () => ({ ...current, deleted: false, diskChange: latest }));
      return;
    }
    updateTab(path, () => ({ status: "ready", file: latest }));
    const editor = editorRef.current;
    // The editor's line separator is fixed when it mounts, so a switch between LF and CRLF needs a fresh one.
    const sameEnding = latest.lineEnding === current.file.lineEnding;
    if (sameEnding && editor?.path === path && latest.content !== undefined) editor.handle.setDoc(latest.content);
    else {
      if (editor?.path === path) editorRef.current = undefined;
      setGeneration((value) => value + 1);
    }
  }, [captureDraft, dispatch, session, updateTab, worktreeId]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void context.refresh(worktreeId, 0).catch(() => undefined);
      void checkActiveFile();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [checkActiveFile, context, worktreeId]);

  const save = useCallback(
    async (path: string, options: { overwrite?: boolean } = {}) => {
      const data = tabDataRef.current.get(path);
      if (data?.status !== "ready" || data.saving || data.file.content === undefined) return;
      const editor = editorRef.current;
      const content = editor?.path === path ? editor.handle.getDoc() : (session.drafts.get(path) ?? data.file.content);
      updateTab(path, () => ({ ...data, saving: true, saveError: undefined }));
      try {
        const result = await writeFile(dispatch, worktreeId, {
          path,
          content,
          expectedVersion: data.deleted ? "new" : data.file.version,
          bom: data.file.bom,
          ...(options.overwrite ? { overwrite: true } : {}),
        });
        if (result.status === "conflict") {
          updateTab(path, (current) =>
            current?.status === "ready"
              ? { ...current, saving: false, conflict: true, diskChange: undefined }
              : current,
          );
          return;
        }
        const file: FileReadResult = { ...data.file, version: result.version, size: result.size, content };
        updateTab(path, () => ({ status: "ready", file }));
        const now = editorRef.current?.path === path ? editorRef.current.handle.getDoc() : content;
        setDraft(path, sameText(now, content) ? undefined : now);
        void context.refresh(worktreeId, 0).catch(() => undefined);
      } catch (cause) {
        updateTab(path, (current) =>
          current?.status === "ready"
            ? {
                ...current,
                saving: false,
                saveError: cause instanceof Error ? cause.message : "The file could not be saved.",
              }
            : current,
        );
      }
    },
    [context, dispatch, session, setDraft, updateTab, worktreeId],
  );

  /** Throws away unsaved edits and shows what is on disk now. */
  const reloadFromDisk = useCallback(
    async (path: string) => {
      setDraft(path, undefined);
      updateTab(path, () => undefined);
      await loadFile(path);
      setGeneration((value) => value + 1);
    },
    [loadFile, setDraft, updateTab],
  );

  const closeTab = (path: string, force = false) => {
    const editor = editorRef.current;
    if (editor?.path === path) captureDraft(path, editor.handle);
    if (!force && session.drafts.has(path)) {
      setActivePath(path);
      setCloseRequest(path);
      return;
    }
    setDraft(path, undefined);
    setCloseRequest(undefined);
    updateTab(path, () => undefined);
    const position = tabs.indexOf(path);
    const next = tabs.filter((candidate) => candidate !== path);
    setTabs(next);
    if (activePath === path) setActivePath(next[Math.min(position, next.length - 1)]);
    if (next.length === 0) setBrowseOpen(true);
  };

  const toggleFolder = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const onEditorReady = useCallback((path: string, handle: CodeEditorHandle) => {
    editorRef.current = { path, handle };
    const reveal = pendingReveal.current;
    if (reveal?.path === path && reveal.line) {
      handle.revealLine(reveal.line, reveal.column);
      pendingReveal.current = undefined;
    }
  }, []);
  const onEditorDispose = useCallback(
    (path: string, handle: CodeEditorHandle) => {
      if (draftTimer.current !== undefined) clearTimeout(draftTimer.current);
      // An editor already detached was replaced with what is on disk; its old text is not a draft.
      if (editorRef.current?.handle !== handle) return;
      captureDraft(path, handle);
      editorRef.current = undefined;
    },
    [captureDraft],
  );
  const onEditorChange = useCallback(
    (path: string) => {
      if (draftTimer.current !== undefined) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
        const editor = editorRef.current;
        if (editor?.path === path) captureDraft(path, editor.handle);
      }, DRAFT_DELAY_MS);
    },
    [captureDraft],
  );

  const active = activePath ? tabData.get(activePath) : undefined;
  const activeChange = activePath ? changes.get(activePath) : undefined;
  const activeStatus = activeChange?.status;
  const activeTurn = useMemo(
    () => (activePath ? latestTurnFor(checkpoints, worktreeId, activePath) : undefined),
    [activePath, checkpoints, worktreeId],
  );
  const showDiff = activePath !== undefined && diffPath === activePath;
  const canDiff = activeStatus !== undefined || activeTurn !== undefined;
  const activeKind = activePath ? previewKind(activePath) : undefined;
  const activeIsText = active?.status === "ready" && active.file.content !== undefined;
  const viewMode = activeKind && activeIsText ? viewModes[activeKind] : undefined;
  const diffRevision = `${activeStatus ?? ""}:${activeChange?.additions ?? ""}:${activeChange?.deletions ?? ""}:${active?.status === "ready" ? active.file.version : ""}`;
  const changeViewMode = (mode: FileViewMode) => {
    if (activeKind) setViewMode(activeKind, mode);
  };
  const showTree = wide ? !treeHidden : browseOpen || tabs.length === 0;
  const showEditor = wide || !showTree;
  const changedCount = statuses.size;
  const treeWidth = clampTreeWidth(layout.treeWidth, paneWidth);
  const toggleTree = () => (wide ? updateLayout({ treeHidden: !treeHidden }) : setBrowseOpen((value) => !value));

  const browser = showTree ? (
    <div className="files-browser" id={browserId} ref={browserRef} style={wide ? { width: treeWidth } : undefined}>
      <div className="files-modes" role="tablist" aria-label="File list mode">
        <button
          className={mode === "tree" ? "is-active" : undefined}
          type="button"
          role="tab"
          aria-selected={mode === "tree"}
          onClick={() => setMode("tree")}
        >
          Files
        </button>
        <button
          className={mode === "search" ? "is-active" : undefined}
          type="button"
          role="tab"
          aria-selected={mode === "search"}
          onClick={() => {
            setMode("search");
            setSearchFocusKey((key) => key + 1);
          }}
        >
          Search
        </button>
        <span className="files-modes-spacer" />
        {mode === "tree" ? (
          <button
            className={`files-filter${changedOnly ? " is-active" : ""}`}
            type="button"
            aria-pressed={changedOnly}
            title="Show only files with uncommitted changes"
            onClick={() => setChangedOnly((value) => !value)}
          >
            Changed{changedCount > 0 ? ` ${changedCount}` : ""}
          </button>
        ) : null}
      </div>
      {mode === "search" ? (
        <FileSearchView
          worktreeId={worktreeId}
          settings={search}
          focusKey={searchFocusKey}
          onSettingsChange={setSearch}
          onOpen={openPath}
        />
      ) : !index ? (
        <LoadingState label="Loading files" />
      ) : changedOnly && treeEntries.length === 0 ? (
        <p className="files-hint">No uncommitted changes in this worktree.</p>
      ) : (
        <>
          <FileTreeView
            entries={treeEntries}
            expanded={treeExpanded}
            selectedPath={activePath}
            revealKey={revealKey}
            changedGroup={
              changedOnly ? undefined : { open: changedOpen, onToggle: () => setChangedOpen((value) => !value) }
            }
            onToggle={toggleFolder}
            onOpen={(path) => openPath({ path })}
          />
          {index.truncated ? (
            <p className="files-hint">This worktree has more files than ZLI lists. Use Search to find the rest.</p>
          ) : null}
        </>
      )}
    </div>
  ) : null;

  const editor = showEditor ? (
    <div className="files-editor">
      {tabs.length > 0 ? (
        <div className="file-tabs" role="tablist" aria-label="Open files">
          {tabs.map((path) => (
            <div className={`file-tab${path === activePath ? " is-active" : ""}`} key={path} title={path}>
              <button
                className="file-tab-label"
                type="button"
                role="tab"
                aria-selected={path === activePath}
                onClick={() => openPath({ path })}
                onAuxClick={(event) => {
                  if (event.button === 1) closeTab(path);
                }}
              >
                <span className={`file-tab-name${statuses.get(path) === "deleted" ? " is-deleted" : ""}`}>
                  {baseName(path)}
                </span>
                {dirty.has(path) ? <span className="file-tab-dirty" role="img" aria-label="Unsaved changes" /> : null}
              </button>
              <button
                className="file-tab-close"
                type="button"
                aria-label={`Close ${baseName(path)}`}
                onClick={() => closeTab(path)}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {!activePath ? (
        <EmptyState
          icon="file"
          title="Open a file"
          detail="Pick one in the file list, or click a file path in an agent's reply or terminal."
          hint={{ label: "Find a file by name", shortcut: quickOpenShortcut }}
        />
      ) : (
        <>
          <div className="file-path-bar">
            <span className="file-path" title={activePath}>
              {dirName(activePath) ? <span className="file-path-dir">{dirName(activePath)}/</span> : null}
              <span className="file-path-name">{baseName(activePath)}</span>
            </span>
            <FileStatusMark status={activeStatus} />
            <LineCounts additions={activeChange?.additions} deletions={activeChange?.deletions} />
            <span className="file-path-spacer" />
            {viewMode && !showDiff ? (
              <ViewModeTabs mode={viewMode} idBase={viewTabsId} panelId={filePanelId} onChange={changeViewMode} />
            ) : null}
            {active?.status === "ready" && active.file.content !== undefined ? (
              <span className="file-meta">
                {languageLabel(activePath)} · {active.file.lineEnding === "crlf" ? "CRLF" : "LF"}
              </span>
            ) : null}
            {canDiff || showDiff ? (
              <Button
                variant="ghost"
                size="sm"
                icon="diff"
                aria-pressed={showDiff}
                tooltip={showDiff ? "Show the file" : "Show what changed in this file"}
                onClick={() => setDiffPath(showDiff ? undefined : activePath)}
              >
                Diff
              </Button>
            ) : null}
            {active?.status === "ready" && active.file.content !== undefined ? (
              <Button
                variant={dirty.has(activePath) ? "primary" : "ghost"}
                size="sm"
                disabled={!dirty.has(activePath) || active.saving}
                tooltip={dirty.has(activePath) ? "Save" : "No unsaved changes"}
                shortcut="Mod+S"
                onClick={() => void save(activePath)}
              >
                {active.saving ? "Saving" : dirty.has(activePath) ? "Save" : "Saved"}
              </Button>
            ) : null}
          </div>
          {closeRequest === activePath ? (
            <FileBanner
              tone="warning"
              message={`${baseName(activePath)} has unsaved changes.`}
              actions={[
                {
                  label: "Save and close",
                  primary: true,
                  run: () =>
                    void save(activePath).then(() => {
                      if (!session.drafts.has(activePath)) closeTab(activePath, true);
                    }),
                },
                { label: "Discard changes", run: () => closeTab(activePath, true) },
                { label: "Cancel", run: () => setCloseRequest(undefined) },
              ]}
            />
          ) : null}
          {active?.status === "ready" ? (
            <FileBanners
              path={activePath}
              data={active}
              onOverwrite={() => void save(activePath, { overwrite: true })}
              onReload={() => void reloadFromDisk(activePath)}
              onKeepMine={() =>
                updateTab(activePath, (current) =>
                  current?.status === "ready"
                    ? { ...current, dismissedVersion: current.diskChange?.version, diskChange: undefined }
                    : current,
                )
              }
              onDismissError={() =>
                updateTab(activePath, (current) =>
                  current?.status === "ready" ? { ...current, saveError: undefined } : current,
                )
              }
            />
          ) : null}
          {showDiff ? (
            <FileDiffPanel
              worktreeId={worktreeId}
              path={activePath}
              revision={diffRevision}
              turn={activeTurn}
              source={diffSource}
              onSourceChange={setDiffSource}
              onOpenChanges={() => onOpenDiff(activePath)}
            />
          ) : null}
          <div className="file-body-host" hidden={showDiff}>
            <FileBody
              key={`${activePath}:${generation}`}
              worktreeId={worktreeId}
              path={activePath}
              data={active}
              status={activeStatus}
              draft={session.drafts.get(activePath)}
              viewMode={viewMode}
              panelId={filePanelId}
              labelledBy={viewMode ? `${viewTabsId}-${viewMode}` : undefined}
              reveal={previewReveal?.path === activePath ? previewReveal : undefined}
              onOpenFile={openPath}
              onViewModeChange={changeViewMode}
              onReady={onEditorReady}
              onDispose={onEditorDispose}
              onChange={onEditorChange}
              onSave={(path) => void save(path)}
              onRetry={() => void loadFile(activePath)}
              onOpenDiff={() => setDiffPath(activePath)}
              onClose={() => closeTab(activePath, true)}
            />
          </div>
        </>
      )}
    </div>
  ) : null;

  const divider =
    wide && showTree ? (
      <FilesDivider
        width={treeWidth}
        min={TREE_MIN_WIDTH}
        max={maxTreeWidth(paneWidth)}
        treeSide={treeOnRight ? "right" : "left"}
        controls={browserId}
        onPreview={(width) => {
          if (browserRef.current) browserRef.current.style.width = `${width}px`;
        }}
        onCommit={(width) => updateLayout({ treeWidth: width })}
        onReset={() => updateLayout({ treeWidth: TREE_DEFAULT_WIDTH })}
      />
    ) : null;

  return (
    <div className="tool-pane files-pane" ref={rootRef}>
      <PaneHeader icon="folderTree" title="Files" detail={worktree.branch}>
        <IconButton icon="search" size="sm" label="Go to file" shortcut={quickOpenShortcut} onClick={onQuickOpen} />
        <IconButton
          icon="reload"
          size="sm"
          label="Reload file list"
          tooltip="Reload file list"
          onClick={() => {
            void context.refresh(worktreeId, 0).catch(() => undefined);
            void checkActiveFile();
          }}
        />
        <IconButton
          icon={treeOnRight ? "panelRight" : "panelLeft"}
          size="sm"
          pressed={showTree}
          label={showTree ? "Hide file list" : "Show file list"}
          onClick={toggleTree}
        />
      </PaneHeader>
      <div className={`files-body${wide ? " is-split" : ""}${treeOnRight ? " is-tree-right" : ""}`}>
        {treeOnRight ? (
          <>
            {editor}
            {divider}
            {browser}
          </>
        ) : (
          <>
            {browser}
            {divider}
            {editor}
          </>
        )}
      </div>
    </div>
  );
}

type BannerAction = { label: string; primary?: boolean; run(): void };

function FileBanner({
  tone,
  message,
  actions,
}: {
  tone: "warning" | "danger";
  message: string;
  actions: BannerAction[];
}) {
  return (
    <div className={`banner banner-${tone} file-banner is-${tone}`} role="alert">
      <Icon name="alert" size={14} />
      <span className="banner-message file-banner-message">{message}</span>
      <span className="banner-actions file-banner-actions">
        {actions.map((action) => (
          <Button variant={action.primary ? "secondary" : "ghost"} size="sm" key={action.label} onClick={action.run}>
            {action.label}
          </Button>
        ))}
      </span>
    </div>
  );
}

function FileBanners({
  path,
  data,
  onOverwrite,
  onReload,
  onKeepMine,
  onDismissError,
}: {
  path: string;
  data: LoadedFile;
  onOverwrite(): void;
  onReload(): void;
  onKeepMine(): void;
  onDismissError(): void;
}) {
  const name = baseName(path);
  if (data.conflict) {
    return (
      <FileBanner
        tone="danger"
        message={`${name} changed on disk after you opened it, so it was not saved.`}
        actions={[
          { label: "Overwrite with mine", primary: true, run: onOverwrite },
          { label: "Reload from disk", run: onReload },
        ]}
      />
    );
  }
  if (data.deleted) {
    return <FileBanner tone="warning" message={`${name} was deleted on disk. Saving creates it again.`} actions={[]} />;
  }
  if (data.diskChange) {
    return (
      <FileBanner
        tone="warning"
        message={`${name} changed on disk while you were editing.`}
        actions={[
          { label: "Reload from disk", primary: true, run: onReload },
          { label: "Keep my edits", run: onKeepMine },
        ]}
      />
    );
  }
  if (data.saveError) {
    return <FileBanner tone="danger" message={data.saveError} actions={[{ label: "Dismiss", run: onDismissError }]} />;
  }
  return null;
}

const VIEW_MODE_LABELS: Record<FileViewMode, string> = { preview: "Preview", code: "Code", split: "Split" };

/** Preview, Code, and Split as one tab list; arrow keys move between them. */
function ViewModeTabs({
  mode,
  idBase,
  panelId,
  onChange,
}: {
  mode: FileViewMode;
  idBase: string;
  panelId: string;
  onChange(mode: FileViewMode): void;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: React.KeyboardEvent, index: number) => {
    const last = FILE_VIEW_MODES.length - 1;
    const next =
      event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : undefined;
    const target = next === undefined ? undefined : FILE_VIEW_MODES[next];
    if (next === undefined || !target) return;
    event.preventDefault();
    onChange(target);
    buttons.current[next]?.focus();
  };
  return (
    <div className="file-view-tabs" role="tablist" aria-label="Show the file as">
      {FILE_VIEW_MODES.map((value, index) => (
        <button
          key={value}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          id={`${idBase}-${value}`}
          className={value === mode ? "is-active" : undefined}
          type="button"
          role="tab"
          aria-selected={value === mode}
          aria-controls={panelId}
          tabIndex={value === mode ? 0 : -1}
          onClick={() => onChange(value)}
          onKeyDown={(event) => move(event, index)}
        >
          {VIEW_MODE_LABELS[value]}
        </button>
      ))}
    </div>
  );
}

type FileViewProps = {
  worktreeId: string;
  path: string;
  viewMode: FileViewMode | undefined;
  panelId: string;
  labelledBy: string | undefined;
  reveal: { line: number; nonce: number } | undefined;
  onReady(path: string, handle: CodeEditorHandle): void;
  onDispose(path: string, handle: CodeEditorHandle): void;
  onChange(path: string): void;
  onSave(path: string): void;
  onOpenFile(location: FileLocation): void;
  onViewModeChange(mode: FileViewMode): void;
};

function FileBody({
  path,
  data,
  status,
  draft,
  onRetry,
  onOpenDiff,
  onClose,
  ...view
}: FileViewProps & {
  data: TabData | undefined;
  status: FileChangeStatus | undefined;
  draft: string | undefined;
  onRetry(): void;
  onOpenDiff(): void;
  onClose(): void;
}) {
  if (!data || data.status === "loading") return <LoadingState label={`Opening ${baseName(path)}`} />;
  if (data.status === "error") {
    if (isMissing(data.message) && status === "deleted") {
      return (
        <EmptyState
          icon="trash"
          title="This file was deleted"
          detail="It is gone from the worktree. The diff shows what was removed."
        >
          <Button icon="diff" onClick={onOpenDiff}>
            Show diff
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </EmptyState>
      );
    }
    return (
      <EmptyState icon="alert" tone="danger" title="The file could not be opened" detail={data.message}>
        <Button icon="reload" onClick={onRetry}>
          Try again
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </EmptyState>
    );
  }
  const { file } = data;
  if (file.content === undefined) {
    const megabytes = (file.size / (1024 * 1024)).toFixed(1);
    return (
      <EmptyState
        icon="file"
        title={file.binary ? "Binary file" : "This file is too large to edit here"}
        detail={
          file.binary
            ? `${baseName(path)} is not text, so ZLI does not open it.`
            : `${baseName(path)} is ${megabytes} MB. ZLI opens text files up to 2 MB.`
        }
      />
    );
  }
  return (
    <TextFileView
      {...view}
      path={path}
      doc={draft ?? file.content}
      lineSeparator={file.lineEnding === "crlf" ? "\r\n" : "\n"}
    />
  );
}

/** The source line, possibly fractional, at the top of an editor. */
function editorTopLine(view: CodeEditorHandle["view"]): number {
  const offset = view.scrollDOM.scrollTop - view.documentPadding.top;
  const block = view.lineBlockAtHeight(Math.max(0, offset));
  const line = view.state.doc.lineAt(block.from).number;
  return line + Math.min(1, Math.max(0, (offset - block.top) / Math.max(1, block.height)));
}

function scrollEditorToLine(view: CodeEditorHandle["view"], line: number): void {
  const whole = Math.min(Math.max(1, Math.floor(line)), view.state.doc.lines);
  const block = view.lineBlockAt(view.state.doc.line(whole).from);
  view.scrollDOM.scrollTop = block.top + view.documentPadding.top + (line - whole) * block.height;
}

/** How long a programmatic scroll on one side of Split keeps the other side from echoing it back. */
const SCROLL_ECHO_MS = 120;

type ScrollEcho = { from: "editor" | "preview"; until: number } | undefined;

/** True while a scroll on `side` is most likely the echo of syncing from the other side. */
function isEcho(echo: ScrollEcho, side: "editor" | "preview"): boolean {
  return echo !== undefined && echo.from !== side && performance.now() < echo.until;
}

/**
 * The editor, plus the rendered preview for Markdown. The editor stays mounted while only the
 * preview shows, so undo history and unsaved edits survive switching views.
 */
function TextFileView({
  worktreeId,
  path,
  doc,
  lineSeparator,
  viewMode,
  panelId,
  labelledBy,
  reveal,
  onReady,
  onDispose,
  onChange,
  onSave,
  onOpenFile,
  onViewModeChange,
}: Omit<FileViewProps, "path"> & { path: string; doc: string; lineSeparator: "\n" | "\r\n" }) {
  const handleRef = useRef<CodeEditorHandle | undefined>(undefined);
  const previewRef = useRef<PreviewHandle | undefined>(undefined);
  const [liveText, setLiveText] = useState(doc);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastLine = useRef<number | undefined>(undefined);
  const pendingEditLine = useRef<number | undefined>(undefined);
  const echo = useRef<ScrollEcho>(undefined);
  const previousMode = useRef(viewMode);
  const showPreview = viewMode === "preview" || viewMode === "split";

  useEffect(() => () => clearTimeout(liveTimer.current), []);

  const ready = useCallback(
    (readyPath: string, handle: CodeEditorHandle) => {
      handleRef.current = handle;
      onReady(readyPath, handle);
    },
    [onReady],
  );
  const dispose = useCallback(
    (disposedPath: string, handle: CodeEditorHandle) => {
      if (handleRef.current === handle) handleRef.current = undefined;
      onDispose(disposedPath, handle);
    },
    [onDispose],
  );
  const docChanged = useCallback(() => {
    clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => {
      const handle = handleRef.current;
      if (handle) setLiveText(handle.getDoc());
    }, 60);
  }, []);
  const previewReady = useCallback((handle: PreviewHandle | undefined) => {
    previewRef.current = handle;
  }, []);

  // In Split, scrolling the editor scrolls the preview to the same source line.
  useEffect(() => {
    const handle = handleRef.current;
    if (!viewMode || !handle) return;
    const scroller = handle.view.scrollDOM;
    const onScroll = () => {
      if (scroller.offsetParent === null) return;
      lastLine.current = editorTopLine(handle.view);
      if (viewMode !== "split" || isEcho(echo.current, "editor")) return;
      echo.current = { from: "editor", until: performance.now() + SCROLL_ECHO_MS };
      previewRef.current?.scrollToLine(lastLine.current);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [viewMode]);

  const previewScrolled = () => {
    const line = previewRef.current?.topLine();
    if (line === undefined) return;
    lastLine.current = line;
    const handle = handleRef.current;
    if (viewMode !== "split" || !handle || isEcho(echo.current, "preview")) return;
    echo.current = { from: "preview", until: performance.now() + SCROLL_ECHO_MS };
    scrollEditorToLine(handle.view, line);
  };

  // Switching views keeps the same part of the document on screen.
  useLayoutEffect(() => {
    const previous = previousMode.current;
    previousMode.current = viewMode;
    const handle = handleRef.current;
    if (previous !== "preview" || viewMode === "preview" || !handle) return;
    const editLine = pendingEditLine.current;
    pendingEditLine.current = undefined;
    const line = lastLine.current;
    const frame = requestAnimationFrame(() => {
      if (editLine) handle.revealLine(editLine);
      else if (line) scrollEditorToLine(handle.view, line);
    });
    return () => cancelAnimationFrame(frame);
  }, [viewMode]);

  const editLine = (line: number) => {
    if (viewMode === "preview") {
      pendingEditLine.current = line;
      onViewModeChange("code");
    } else handleRef.current?.revealLine(line);
  };

  return (
    <div
      className={`file-view${viewMode ? ` is-${viewMode}` : ""}`}
      id={panelId}
      {...(viewMode ? { role: "tabpanel", "aria-labelledby": labelledBy } : {})}
    >
      <EditorSurface
        path={path}
        doc={doc}
        lineSeparator={lineSeparator}
        hidden={viewMode === "preview"}
        onReady={ready}
        onDispose={dispose}
        onChange={onChange}
        onDocChange={docChanged}
        onSave={onSave}
      />
      {showPreview ? (
        <Suspense fallback={<LoadingState label="Rendering preview" />}>
          <MarkdownPreview
            worktreeId={worktreeId}
            path={path}
            source={liveText}
            initialLine={lastLine.current}
            reveal={reveal}
            onOpenFile={onOpenFile}
            onEditLine={editLine}
            onReady={previewReady}
            onUserScroll={previewScrolled}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

/** Hosts one CodeMirror instance for one file; a new path or reload mounts a fresh editor. */
function EditorSurface({
  path,
  doc,
  lineSeparator,
  hidden,
  onReady,
  onDispose,
  onChange,
  onDocChange,
  onSave,
}: {
  path: string;
  doc: string;
  lineSeparator: "\n" | "\r\n";
  hidden?: boolean;
  onReady(path: string, handle: CodeEditorHandle): void;
  onDispose(path: string, handle: CodeEditorHandle): void;
  onChange(path: string): void;
  onDocChange?(): void;
  onSave(path: string): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const initial = useRef({ doc, lineSeparator });
  const callbacks = useRef({ onReady, onDispose, onChange, onDocChange, onSave });
  callbacks.current = { onReady, onDispose, onChange, onDocChange, onSave };

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    const handle = createCodeEditor({
      parent,
      doc: initial.current.doc,
      path,
      lineSeparator: initial.current.lineSeparator,
      onChange: () => callbacks.current.onChange(path),
      onDocChange: () => callbacks.current.onDocChange?.(),
      onSave: () => callbacks.current.onSave(path),
    });
    callbacks.current.onReady(path, handle);
    return () => {
      callbacks.current.onDispose(path, handle);
      handle.destroy();
    };
  }, [path]);

  return <div className="file-editor-host" ref={hostRef} data-path={path} hidden={hidden} />;
}
