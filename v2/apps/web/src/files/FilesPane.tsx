import type { FileChangeStatus, FileReadResult, WorktreeProjection } from "@zli-v2/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { EmptyState, LoadingState, PaneHeader } from "../ui/Pane.js";
import { type CodeEditorHandle, createCodeEditor, languageLabel } from "./codeEditor.js";
import { useFileIndex, useFileIndexContext } from "./FileIndex.js";
import { FileSearchView, type SearchSettings } from "./FileSearchView.js";
import { FileStatusMark, FileTreeView } from "./FileTreeView.js";
import { readFile, writeFile } from "./fileClient.js";
import { baseName, dirName, type FileLocation } from "./filePaths.js";
import { ancestorDirectories } from "./fileTree.js";

export type FilesFocus =
  | { kind: "open"; path: string; line?: number | undefined; column?: number | undefined; nonce: number }
  | { kind: "search"; nonce: number };

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
  const [search, setSearch] = useState<SearchSettings>(session.search);
  const [tabData, setTabData] = useState<ReadonlyMap<string, TabData>>(new Map());
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set(session.drafts.keys()));
  const [revealKey, setRevealKey] = useState(0);
  const [searchFocusKey, setSearchFocusKey] = useState(0);
  const [closeRequest, setCloseRequest] = useState<string>();
  const [wide, setWide] = useState(true);
  const [browseOpen, setBrowseOpen] = useState(session.tabs.length === 0);
  const [treeHidden, setTreeHidden] = useState(false);
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
    session.search = search;
  }, [session, tabs, activePath, expanded, mode, changedOnly, search]);

  const statuses = useMemo(() => {
    const map = new Map<string, FileChangeStatus>();
    for (const entry of index?.entries ?? []) if (entry.status) map.set(entry.path, entry.status);
    return map;
  }, [index]);
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
      setTreeHidden(false);
      setBrowseOpen(true);
      setSearchFocusKey((key) => key + 1);
    }
  }, [focus?.nonce]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWide(entry.contentRect.width >= SPLIT_MIN_WIDTH);
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
  const activeStatus = activePath ? statuses.get(activePath) : undefined;
  const showTree = wide ? !treeHidden : browseOpen || tabs.length === 0;
  const showEditor = wide || !showTree;
  const changedCount = statuses.size;

  return (
    <div className="tool-pane files-pane" ref={rootRef}>
      <PaneHeader icon="folderTree" title="Files" detail={worktree.branch}>
        <IconButton
          icon="panelLeft"
          size="sm"
          pressed={showTree}
          label={showTree ? "Hide file list" : "Show file list"}
          onClick={() => (wide ? setTreeHidden((value) => !value) : setBrowseOpen((value) => !value))}
        />
        <IconButton icon="search" size="sm" label="Go to file" shortcut="Mod+P" onClick={onQuickOpen} />
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
      </PaneHeader>
      <div className={`files-body${wide ? " is-split" : ""}`}>
        {showTree ? (
          <div className="files-browser">
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
                  onToggle={toggleFolder}
                  onOpen={(path) => openPath({ path })}
                />
                {index.truncated ? (
                  <p className="files-hint">
                    This worktree has more files than ZLI lists. Use Search to find the rest.
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}
        {showEditor ? (
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
                      {dirty.has(path) ? (
                        <span className="file-tab-dirty" role="img" aria-label="Unsaved changes" />
                      ) : null}
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
                hint={{ label: "Find a file by name", shortcut: "Mod+P" }}
              />
            ) : (
              <>
                <div className="file-path-bar">
                  <span className="file-path" title={activePath}>
                    {dirName(activePath) ? <span className="file-path-dir">{dirName(activePath)}/</span> : null}
                    <span className="file-path-name">{baseName(activePath)}</span>
                  </span>
                  <FileStatusMark status={activeStatus} />
                  <span className="file-path-spacer" />
                  {active?.status === "ready" && active.file.content !== undefined ? (
                    <span className="file-meta">
                      {languageLabel(activePath)} · {active.file.lineEnding === "crlf" ? "CRLF" : "LF"}
                    </span>
                  ) : null}
                  {activeStatus ? (
                    <Button variant="ghost" size="sm" icon="diff" onClick={() => onOpenDiff(activePath)}>
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
                <FileBody
                  key={`${activePath}:${generation}`}
                  path={activePath}
                  data={active}
                  status={activeStatus}
                  draft={session.drafts.get(activePath)}
                  onReady={onEditorReady}
                  onDispose={onEditorDispose}
                  onChange={onEditorChange}
                  onSave={(path) => void save(path)}
                  onRetry={() => void loadFile(activePath)}
                  onOpenDiff={() => onOpenDiff(activePath)}
                  onClose={() => closeTab(activePath, true)}
                />
              </>
            )}
          </div>
        ) : null}
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

function FileBody({
  path,
  data,
  status,
  draft,
  onReady,
  onDispose,
  onChange,
  onSave,
  onRetry,
  onOpenDiff,
  onClose,
}: {
  path: string;
  data: TabData | undefined;
  status: FileChangeStatus | undefined;
  draft: string | undefined;
  onReady(path: string, handle: CodeEditorHandle): void;
  onDispose(path: string, handle: CodeEditorHandle): void;
  onChange(path: string): void;
  onSave(path: string): void;
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
    <EditorSurface
      path={path}
      doc={draft ?? file.content}
      lineSeparator={file.lineEnding === "crlf" ? "\r\n" : "\n"}
      onReady={onReady}
      onDispose={onDispose}
      onChange={onChange}
      onSave={onSave}
    />
  );
}

/** Hosts one CodeMirror instance for one file; a new path or reload mounts a fresh editor. */
function EditorSurface({
  path,
  doc,
  lineSeparator,
  onReady,
  onDispose,
  onChange,
  onSave,
}: {
  path: string;
  doc: string;
  lineSeparator: "\n" | "\r\n";
  onReady(path: string, handle: CodeEditorHandle): void;
  onDispose(path: string, handle: CodeEditorHandle): void;
  onChange(path: string): void;
  onSave(path: string): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const initial = useRef({ doc, lineSeparator });
  const callbacks = useRef({ onReady, onDispose, onChange, onSave });
  callbacks.current = { onReady, onDispose, onChange, onSave };

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;
    const handle = createCodeEditor({
      parent,
      doc: initial.current.doc,
      path,
      lineSeparator: initial.current.lineSeparator,
      onChange: () => callbacks.current.onChange(path),
      onSave: () => callbacks.current.onSave(path),
    });
    callbacks.current.onReady(path, handle);
    return () => {
      callbacks.current.onDispose(path, handle);
      handle.destroy();
    };
  }, [path]);

  return <div className="file-editor-host" ref={hostRef} data-path={path} />;
}
