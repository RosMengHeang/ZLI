import { type ProjectProjection, WorktreeId, type WorktreeProjection } from "@zli-v2/contracts";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isSelectableProvider, providerDisplayName } from "../agent/providers.js";
import { AttentionPanel } from "../attention/AttentionPanel.js";
import { BrowserPane, type BrowserReveal } from "../browser/BrowserPane.js";
import { FileIndexProvider, type OpenFileRequest } from "../files/FileIndex.js";
import type { FilesFocus } from "../files/FilesPane.js";
import { QuickOpen } from "../files/QuickOpen.js";
import { type ReviewFocus, ReviewPane } from "../review/ReviewPane.js";
import { getBridge, type ZliBridge } from "../runtime/bridge.js";
import { makeCommandId } from "../runtime/commandId.js";
import { RuntimeProvider, useRuntime } from "../runtime/RuntimeProvider.js";
import { AgentTile } from "../sessions/AgentTile.js";
import { createWorktree, ensureCheckout, startSessionAgent } from "../sessions/launch.js";
import { NewAgentDialog, type NewAgentRequest } from "../sessions/NewAgentDialog.js";
import {
  type AgentSession,
  deriveSessions,
  gridColumns,
  type SessionMode,
  sessionStopCommands,
  sessionTitle,
} from "../sessions/sessions.js";
import { forgetSession, useWorkbenchState } from "../sessions/workbench.js";
import { LegacyImportDialog } from "../settings/LegacyImportDialog.js";
import { Sidebar, type WorktreeAction } from "../sidebar/Sidebar.js";
import { TerminalDrawer } from "../terminal/TerminalDrawer.js";
import { IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { TooltipLayer } from "../ui/Tooltip.js";
import { PanelResizer, usePanelWidth } from "../workspace/PanelResizer.js";
import { CloseAgentDialog, DeleteAgentDialog, deletableWorktree } from "./AgentDialogs.js";
import { CommandPalette, type PaletteCommand } from "./CommandPalette.js";
import { HelpDialog } from "./HelpDialog.js";
import { DisconnectedState, GridEmptyState, LoadingFilesPane, RuntimeLoadingState } from "./ShellStates.js";
import { type SidePane, sidePaneLabel, Topbar } from "./Topbar.js";
import { useGlobalShortcuts } from "./useGlobalShortcuts.js";
import { WorktreeDialog } from "./WorktreeDialog.js";
import "./AppShell.css";
import "./shell.css";
import "../files/files.css";

// The editor is large, so it loads the first time the Files panel opens instead of at startup.
const FilesPane = lazy(() => import("../files/FilesPane.js").then((module) => ({ default: module.FilesPane })));

export function AppShell({ bridge = getBridge() }: { bridge?: ZliBridge } = {}) {
  return (
    <RuntimeProvider bridge={bridge}>
      <WorkspaceApp />
    </RuntimeProvider>
  );
}

function WorkspaceApp() {
  const { bridge, projection, dispatch } = useRuntime();
  const [workbench, updateWorkbench] = useWorkbenchState();
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string>();
  const [sidePane, setSidePane] = useState<SidePane>();
  const [reviewFocus, setReviewFocus] = useState<ReviewFocus>();
  const [panelWidth, setPanelWidth] = usePanelWidth();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [worktreeDialogProject, setWorktreeDialogProject] = useState<ProjectProjection>();
  const [newAgentProject, setNewAgentProject] = useState<ProjectProjection | "default">();
  const [notice, setNotice] = useState<{ message: string; tone: "danger" | "info" }>();
  const showError = useCallback((message: string) => setNotice({ message, tone: "danger" }), []);
  const [legacyImportBatchId, setLegacyImportBatchId] = useState<string>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [closeRequest, setCloseRequest] = useState<AgentSession>();
  const [deleteRequest, setDeleteRequest] = useState<AgentSession>();
  const [version, setVersion] = useState<string>();
  const [browserReveal, setBrowserReveal] = useState<BrowserReveal>();
  const [filesFocus, setFilesFocus] = useState<FilesFocus>();
  const [quickOpen, setQuickOpen] = useState(false);
  const launching = useRef(new Set<string>());
  const projectionRef = useRef(projection);
  projectionRef.current = projection;

  const sessions = useMemo(
    () => (projection ? deriveSessions(projection, workbench.pending) : []),
    [projection, workbench.pending],
  );
  const tiles = useMemo(
    () => sessions.filter((session) => !workbench.closed.includes(session.sessionId)),
    [sessions, workbench.closed],
  );
  const backgroundSessionIds = useMemo(
    () =>
      new Set(
        sessions
          .filter((session) => workbench.closed.includes(session.sessionId) && sessionStopCommands(session).length > 0)
          .map((session) => session.sessionId),
      ),
    [sessions, workbench.closed],
  );
  const activeSession = tiles.find((session) => session.sessionId === workbench.activeSessionId);
  const maximized = tiles.find((session) => session.sessionId === workbench.maximizedSessionId);
  const visibleTiles = maximized ? [maximized] : tiles;
  const findWorktree = useCallback(
    (worktreeId: string | undefined) => projection?.worktrees.find((worktree) => worktree.worktreeId === worktreeId),
    [projection?.worktrees],
  );
  const contextWorktree =
    findWorktree(activeSession?.worktreeId) ??
    findWorktree(selectedWorktreeId) ??
    projection?.worktrees.find((worktree) => worktree.status === "ready");
  const contextProject = projection?.projects.find((project) => project.projectId === contextWorktree?.projectId);
  const hasProjects = (projection?.projects.length ?? 0) > 0;

  const focusSession = useCallback(
    (session: AgentSession) => {
      setSelectedWorktreeId(session.worktreeId);
      updateWorkbench((state) =>
        state.activeSessionId === session.sessionId &&
        !state.closed.includes(session.sessionId) &&
        (!state.maximizedSessionId || state.maximizedSessionId === session.sessionId)
          ? state
          : {
              ...state,
              activeSessionId: session.sessionId,
              closed: state.closed.filter((id) => id !== session.sessionId),
              ...(state.maximizedSessionId && state.maximizedSessionId !== session.sessionId
                ? { maximizedSessionId: session.sessionId }
                : {}),
            },
      );
    },
    [updateWorkbench],
  );

  const tilesRef = useRef(tiles);
  tilesRef.current = tiles;
  /**
   * The utility panels follow the active agent's worktree, so showing something from another worktree
   * moves focus to an agent there.
   */
  const focusWorktree = useCallback(
    (worktreeId: string) => {
      setSelectedWorktreeId(worktreeId);
      updateWorkbench((state) => {
        const current = tilesRef.current.find((session) => session.sessionId === state.activeSessionId);
        if (current?.worktreeId === worktreeId) return state;
        const latest = tilesRef.current.filter((session) => session.worktreeId === worktreeId).at(-1);
        return {
          ...state,
          activeSessionId: latest?.sessionId,
          ...(state.maximizedSessionId ? { maximizedSessionId: latest?.sessionId } : {}),
        };
      });
    },
    [updateWorkbench],
  );
  useEffect(() => {
    if (!bridge) return;
    let key = 0;
    return bridge.browser.onReveal(({ browserTabId, worktreeId }) => {
      key += 1;
      setBrowserReveal({ browserTabId, worktreeId, key });
      setSidePane("browser");
      focusWorktree(worktreeId);
    });
  }, [bridge, focusWorktree]);

  const openFile = useCallback(
    ({ worktreeId, path, line, column }: OpenFileRequest) => {
      setQuickOpen(false);
      setSidePane("files");
      focusWorktree(worktreeId);
      setFilesFocus({ kind: "open", path, line, column, nonce: Date.now() });
    },
    [focusWorktree],
  );
  const contextWorktreeRef = useRef(contextWorktree);
  contextWorktreeRef.current = contextWorktree;
  const openQuickOpen = useCallback(() => {
    if (contextWorktreeRef.current?.status !== "ready") return;
    setPaletteOpen(false);
    setQuickOpen(true);
  }, []);
  const searchInFiles = useCallback(() => {
    setPaletteOpen(false);
    setSidePane("files");
    setFilesFocus({ kind: "search", nonce: Date.now() });
  }, []);

  const openNewAgent = useCallback(
    (project?: ProjectProjection) => {
      if (!hasProjects) return;
      setPaletteOpen(false);
      setNewAgentProject(project ?? "default");
    },
    [hasProjects],
  );

  const toggleSidebar = () => updateWorkbench((state) => ({ ...state, sidebarOpen: !state.sidebarOpen }));
  const toggleDrawer = () => updateWorkbench((state) => ({ ...state, drawerOpen: !state.drawerOpen }));
  useGlobalShortcuts({
    onPalette: () => setPaletteOpen(true),
    onNewAgent: () => openNewAgent(),
    onQuickOpen: openQuickOpen,
    onSearchFiles: searchInFiles,
    onToggleSidebar: toggleSidebar,
    onToggleDrawer: toggleDrawer,
    onEscape: () => {
      setPaletteOpen(false);
      setQuickOpen(false);
      setWorktreeDialogProject(undefined);
      setNewAgentProject(undefined);
      setLegacyImportBatchId(undefined);
      setHelpOpen(false);
      setCloseRequest(undefined);
      setDeleteRequest(undefined);
    },
  });
  // Agents wait for their worktree; start each one once its folder is ready.
  useEffect(() => {
    if (!projection) return;
    const existing = new Set(sessions.filter((session) => !session.pending).map((session) => session.sessionId));
    const settled = workbench.pending.filter((launch) => existing.has(launch.sessionId));
    if (settled.length > 0) {
      updateWorkbench((state) => ({
        ...state,
        pending: state.pending.filter((launch) => !existing.has(launch.sessionId)),
      }));
    }
    for (const launch of workbench.pending) {
      if (launch.errorMessage || launch.started || existing.has(launch.sessionId)) continue;
      if (launching.current.has(launch.sessionId)) continue;
      const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === launch.worktreeId);
      const fail = (message: string) =>
        updateWorkbench((state) => ({
          ...state,
          pending: state.pending.map((entry) =>
            entry.sessionId === launch.sessionId ? { ...entry, errorMessage: message } : entry,
          ),
        }));
      if (!worktree) continue;
      if (worktree.status === "failed" || worktree.status === "cancelled" || worktree.status === "cancelling") {
        fail(worktree.errorMessage ?? "The worktree could not be created.");
        continue;
      }
      if (worktree.status !== "ready") continue;
      if (!isSelectableProvider(launch.provider)) {
        fail("This agent is not supported.");
        continue;
      }
      launching.current.add(launch.sessionId);
      void startSessionAgent(dispatch, projection, {
        provider: launch.provider,
        mode: launch.mode,
        permissionMode: launch.permissionMode ?? "full-access",
        ...(launch.model ? { model: launch.model } : {}),
        sessionId: launch.sessionId,
        worktreeId: worktree.worktreeId,
        cwd: worktree.path,
      }).then((failure) => {
        launching.current.delete(launch.sessionId);
        updateWorkbench((state) => ({
          ...state,
          pending: state.pending.map((entry) =>
            entry.sessionId !== launch.sessionId
              ? entry
              : failure
                ? { ...entry, errorMessage: failure }
                : { ...entry, started: true },
          ),
        }));
      });
    }
  }, [dispatch, projection, sessions, updateWorkbench, workbench.pending]);

  const openProject = async () => {
    if (!bridge) {
      showError("The desktop bridge is unavailable. Start ZLI from Electron.");
      return;
    }
    const path = await bridge.dialog.openProject();
    if (!path) return;
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "project.register", path },
    });
    if (response?.accepted === false) showError(response.error.message);
  };

  const exportSupportBundle = async () => {
    if (!bridge) {
      showError("The desktop bridge is unavailable. Start ZLI from Electron.");
      return;
    }
    const destinationPath = await bridge.dialog.saveSupportBundle();
    if (!destinationPath) return;
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "diagnostics.createSupportBundle", destinationPath },
    });
    if (response?.accepted === false) showError(response.error.message);
    else setNotice({ message: "Creating a redacted support bundle.", tone: "info" });
  };

  const startLegacyImport = async () => {
    if (!bridge) {
      showError("The desktop bridge is unavailable. Start ZLI from Electron.");
      return;
    }
    const snapshotPath = await bridge.dialog.openLegacySnapshot();
    if (!snapshotPath) return;
    const batchId = makeCommandId();
    setLegacyImportBatchId(batchId);
    setPaletteOpen(false);
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "legacy.scan", batchId, snapshotPath },
    });
    if (response?.accepted === false) showError(response.error.message);
  };

  const importLegacyRecords = async (selectedRecordIds: string[]) => {
    if (!legacyImportBatchId) return;
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "legacy.import", batchId: legacyImportBatchId, selectedRecordIds },
    });
    if (response?.accepted === false) showError(response.error.message);
  };

  const rollbackLegacyImport = async () => {
    if (!legacyImportBatchId) return;
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "legacy.rollbackImport", batchId: legacyImportBatchId },
    });
    if (response?.accepted === false) showError(response.error.message);
  };

  const bundlePath = projection?.diagnostics?.lastBundle?.path;
  useEffect(() => {
    if (bundlePath) setNotice({ message: `Support bundle saved: ${bundlePath}`, tone: "info" });
  }, [bundlePath]);

  useEffect(() => {
    const message = projection?.diagnostics?.lastError;
    if (message) showError(`Support bundle failed: ${message}`);
  }, [projection?.diagnostics?.lastError, showError]);

  useEffect(() => {
    if (!helpOpen || !bridge) return;
    void bridge.app
      .getVersion()
      .then(setVersion)
      .catch(() => setVersion("development"));
  }, [bridge, helpOpen]);

  const worktreeAction = async (worktree: WorktreeProjection, action: WorktreeAction) => {
    setNotice(undefined);
    const worktreeId = WorktreeId.parse(worktree.worktreeId);
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command:
        action === "remove"
          ? { type: "worktree.remove", worktreeId }
          : { type: action === "retry" ? "worktree.retry" : "worktree.cancel", worktreeId },
    });
    if (response?.accepted === false) showError(response.error.message);
    else if (action === "remove" && worktree.worktreeId === selectedWorktreeId) setSelectedWorktreeId(undefined);
  };

  const submitWorktree = async (project: ProjectProjection, branch: string, baseRef: string) => {
    const result = await createWorktree(dispatch, project, branch, baseRef);
    if ("error" in result) {
      showError(result.error);
      return;
    }
    setWorktreeDialogProject(undefined);
    setSelectedWorktreeId(result.worktreeId);
  };

  const submitNewAgent = async (request: NewAgentRequest): Promise<string | undefined> => {
    if (!projection) return "The runtime is not connected.";
    let worktreeId: string;
    if (request.placement.kind === "new") {
      const result = await createWorktree(
        dispatch,
        request.project,
        request.placement.branch,
        request.placement.baseRef,
      );
      if ("error" in result) return result.error;
      worktreeId = result.worktreeId;
    } else if (request.placement.kind === "checkout") {
      const result = await ensureCheckout(dispatch, projection, request.project);
      if ("error" in result) return result.error;
      worktreeId = result.worktreeId;
    } else {
      worktreeId = request.placement.worktreeId;
    }
    const sessionId = makeCommandId();
    updateWorkbench((state) => ({
      ...state,
      pending: [
        ...state.pending,
        {
          sessionId,
          worktreeId,
          provider: request.provider,
          mode: request.mode,
          permissionMode: request.permissionMode,
          ...(request.model ? { model: request.model } : {}),
          createdAt: new Date().toISOString(),
        },
      ],
      modes: { ...state.modes, [sessionId]: request.mode },
      activeSessionId: sessionId,
      maximizedSessionId: undefined,
    }));
    setSelectedWorktreeId(worktreeId);
    setNewAgentProject(undefined);
    return undefined;
  };

  const send = async (command: Record<string, unknown>): Promise<boolean> => {
    try {
      const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
      if (response?.accepted === false) {
        showError(response.error.message);
        return false;
      }
      return response !== undefined;
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : "The command failed.");
      return false;
    }
  };

  const stopSession = async (session: AgentSession): Promise<void> => {
    await Promise.all(sessionStopCommands(session).map((command) => send(command)));
  };

  const closeTile = (session: AgentSession) => {
    if (sessionStopCommands(session).length > 0) setCloseRequest(session);
    else closeTileNow(session);
  };

  /** Resolves once the session runs nothing, or after the timeout. */
  const waitUntilStopped = async (sessionId: string, timeoutMs = 8000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = projectionRef.current;
      const live = current ? deriveSessions(current).find((candidate) => candidate.sessionId === sessionId) : undefined;
      if (!live || sessionStopCommands(live).length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const deleteSession = async (session: AgentSession, removeWorktree: boolean): Promise<void> => {
    setNotice(undefined);
    const worktree = removeWorktree ? findWorktree(session.worktreeId) : undefined;
    // Windows keeps a folder locked while a process runs inside it, so the agent must exit before git removes it.
    if (worktree && sessionStopCommands(session).length > 0) {
      await stopSession(session);
      await waitUntilStopped(session.sessionId);
    }
    if (session.terminal || session.thread) {
      const deleted = await send({ type: "session.delete", sessionId: session.sessionId });
      if (!deleted) return;
    }
    updateWorkbench((state) => forgetSession(state, session.sessionId));
    if (!worktree) return;
    // The person confirmed that uncommitted changes in the folder are lost.
    const removed = await send({ type: "worktree.remove", worktreeId: worktree.worktreeId, force: true });
    if (removed && worktree.worktreeId === selectedWorktreeId) setSelectedWorktreeId(undefined);
  };

  const closeTileNow = (session: AgentSession) =>
    updateWorkbench((state) => ({
      ...state,
      pending:
        session.terminal || session.thread
          ? state.pending
          : state.pending.filter((entry) => entry.sessionId !== session.sessionId),
      closed: session.terminal || session.thread ? [...state.closed, session.sessionId] : state.closed,
      ...(state.maximizedSessionId === session.sessionId ? { maximizedSessionId: undefined } : {}),
      ...(state.activeSessionId === session.sessionId ? { activeSessionId: undefined } : {}),
    }));

  const retryPending = (session: AgentSession) => {
    const worktree = findWorktree(session.worktreeId);
    if (worktree?.status === "failed") void worktreeAction(worktree, "retry");
    updateWorkbench((state) => ({
      ...state,
      pending: state.pending.map((entry) => {
        if (entry.sessionId !== session.sessionId) return entry;
        const { errorMessage: _error, started: _started, ...rest } = entry;
        return rest;
      }),
    }));
  };

  const startInSession = (session: AgentSession, mode: SessionMode): Promise<string | undefined> => {
    const worktree = findWorktree(session.worktreeId);
    if (!projection || !worktree) return Promise.resolve("The worktree for this agent is gone.");
    if (worktree.status !== "ready") return Promise.resolve("The worktree is not ready yet.");
    if (!isSelectableProvider(session.provider)) return Promise.resolve("This agent is not supported.");
    const model = session.thread?.model ?? session.terminal?.agent?.model;
    updateWorkbench((state) => ({ ...state, modes: { ...state.modes, [session.sessionId]: mode } }));
    return startSessionAgent(dispatch, projection, {
      provider: session.provider,
      mode,
      permissionMode: session.thread?.permissionMode ?? session.terminal?.agent?.permissionMode ?? "full-access",
      ...(model ? { model } : {}),
      sessionId: session.sessionId,
      worktreeId: worktree.worktreeId,
      cwd: worktree.path,
    });
  };

  const toggleSidePane = (next: SidePane) => setSidePane((current) => (current === next ? undefined : next));
  const commands: PaletteCommand[] = [
    ...(hasProjects
      ? [
          {
            label: "New agent",
            icon: "plus" as const,
            group: "Create" as const,
            shortcut: "Mod+N",
            action: () => openNewAgent(),
          },
        ]
      : []),
    ...(hasProjects
      ? [
          {
            label: "New worktree",
            icon: "branch" as const,
            group: "Create" as const,
            action: () => setWorktreeDialogProject(contextProject ?? projection?.projects[0]),
          },
        ]
      : []),
    { label: "Open project", icon: "folderOpen", group: "Create", action: () => void openProject() },
    ...(tiles.length > 0
      ? [
          {
            label: "Focus agent",
            icon: "bot" as const,
            group: "Go to" as const,
            action: () => {
              setSidePane(undefined);
              const target = activeSession ?? tiles.at(-1);
              if (target) focusSession(target);
            },
          },
        ]
      : []),
    ...(contextWorktree?.status === "ready"
      ? [
          {
            label: "Go to file",
            icon: "file" as const,
            group: "Go to" as const,
            shortcut: "Mod+P",
            action: openQuickOpen,
          },
          {
            label: "Search in files",
            icon: "search" as const,
            group: "Go to" as const,
            shortcut: "Mod+Shift+F",
            action: searchInFiles,
          },
        ]
      : []),
    { label: "Toggle terminal", icon: "terminal", group: "View", shortcut: "Mod+J", action: toggleDrawer },
    { label: "Focus files", icon: "folderTree", group: "View", action: () => setSidePane("files") },
    { label: "Focus browser", icon: "globe", group: "View", action: () => setSidePane("browser") },
    { label: "Focus changes", icon: "diff", group: "View", action: () => setSidePane("review") },
    {
      label: workbench.sidebarOpen ? "Hide sidebar" : "Show sidebar",
      icon: "panelLeft",
      group: "View",
      shortcut: "Mod+B",
      action: toggleSidebar,
    },
    { label: "Export support bundle", icon: "download", group: "App", action: () => void exportSupportBundle() },
    { label: "Import legacy snapshot", icon: "upload", group: "App", action: () => void startLegacyImport() },
    { label: "Help and diagnostics", icon: "help", group: "App", action: () => setHelpOpen(true) },
  ];
  const overlayOpen =
    paletteOpen ||
    quickOpen ||
    worktreeDialogProject !== undefined ||
    newAgentProject !== undefined ||
    helpOpen ||
    closeRequest !== undefined ||
    deleteRequest !== undefined ||
    (legacyImportBatchId !== undefined && projection !== undefined);
  const columns = gridColumns(visibleTiles.length);
  const rows = Math.max(1, Math.ceil(visibleTiles.length / columns));

  return (
    <FileIndexProvider onOpenFile={openFile}>
      <div className={`app-shell${workbench.sidebarOpen ? "" : " is-sidebar-hidden"}`}>
        {workbench.sidebarOpen ? (
          <Sidebar
            projection={projection}
            sessions={sessions}
            activeSessionId={activeSession?.sessionId}
            backgroundSessionIds={backgroundSessionIds}
            activeWorktreeId={contextWorktree?.worktreeId}
            onSelectSession={focusSession}
            onStopSession={(session) => void stopSession(session)}
            onDeleteSession={setDeleteRequest}
            onSelectWorktree={(worktree) => {
              setNotice(undefined);
              setSelectedWorktreeId(worktree.worktreeId);
              const latest = tiles.filter((session) => session.worktreeId === worktree.worktreeId).at(-1);
              updateWorkbench((state) => ({ ...state, activeSessionId: latest?.sessionId }));
            }}
            onNewAgent={openNewAgent}
            onOpenProject={() => void openProject()}
            onCreateWorktree={(project) =>
              setWorktreeDialogProject(project ?? contextProject ?? projection?.projects[0])
            }
            onWorktreeAction={(worktree, action) => void worktreeAction(worktree, action)}
            onOpenHelp={() => setHelpOpen(true)}
            onHideSidebar={() => updateWorkbench((state) => ({ ...state, sidebarOpen: false }))}
          />
        ) : null}
        <main className="main-workspace">
          <Topbar
            sidebarOpen={workbench.sidebarOpen}
            project={contextWorktree ? contextProject : undefined}
            worktree={contextWorktree}
            hasProjects={hasProjects}
            agentCount={tiles.length}
            drawerOpen={workbench.drawerOpen}
            sidePane={sidePane}
            onShowSidebar={toggleSidebar}
            onNewAgent={() => openNewAgent()}
            onToggleDrawer={toggleDrawer}
            onToggleSidePane={toggleSidePane}
            onOpenPalette={() => setPaletteOpen(true)}
          />
          {notice ? (
            <div className={`banner banner-${notice.tone}`} role={notice.tone === "danger" ? "alert" : "status"}>
              <Icon name={notice.tone === "danger" ? "alert" : "check"} size={14} />
              <span className="banner-message">{notice.message}</span>
              <IconButton label="Dismiss message" icon="x" size="sm" onClick={() => setNotice(undefined)} />
            </div>
          ) : null}
          <AttentionPanel items={projection?.attention ?? []} />
          {!bridge ? (
            <DisconnectedState />
          ) : !projection ? (
            <RuntimeLoadingState />
          ) : (
            <div className="workspace-body">
              <div className="workbench-column">
                <section className="agent-grid-region" aria-label="Agents">
                  {visibleTiles.length === 0 ? (
                    <GridEmptyState
                      projection={projection}
                      closedCount={sessions.length}
                      onOpenProject={() => void openProject()}
                      onNewAgent={() => openNewAgent()}
                    />
                  ) : (
                    <div
                      className="agent-grid"
                      style={{
                        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
                      }}
                    >
                      {visibleTiles.map((session) => (
                        <AgentTile
                          key={session.sessionId}
                          projection={projection}
                          session={session}
                          worktree={findWorktree(session.worktreeId)}
                          mode={workbench.modes[session.sessionId] ?? session.defaultMode}
                          active={session.sessionId === activeSession?.sessionId}
                          maximized={maximized?.sessionId === session.sessionId}
                          canMaximize={tiles.length > 1}
                          onModeChange={(mode) =>
                            updateWorkbench((state) => ({
                              ...state,
                              modes: { ...state.modes, [session.sessionId]: mode },
                            }))
                          }
                          onFocus={() => focusSession(session)}
                          onToggleMaximize={() =>
                            updateWorkbench((state) => ({
                              ...state,
                              maximizedSessionId:
                                state.maximizedSessionId === session.sessionId ? undefined : session.sessionId,
                            }))
                          }
                          onStop={() => void stopSession(session)}
                          onClose={() => closeTile(session)}
                          onOpenDiff={(path) => {
                            focusSession(session);
                            setSidePane("review");
                            setReviewFocus(path ? { path, nonce: Date.now() } : undefined);
                          }}
                          onStart={(mode) => startInSession(session, mode)}
                          onRetryPending={() => retryPending(session)}
                          onDismissPending={() => closeTileNow(session)}
                        />
                      ))}
                    </div>
                  )}
                </section>
                {workbench.drawerOpen ? (
                  <TerminalDrawer
                    projection={projection}
                    worktree={contextWorktree}
                    sessionId={activeSession?.sessionId}
                    height={workbench.drawerHeight}
                    onHeightChange={(drawerHeight) => updateWorkbench((state) => ({ ...state, drawerHeight }))}
                    onClose={() => updateWorkbench((state) => ({ ...state, drawerOpen: false }))}
                  />
                ) : null}
              </div>
              {sidePane ? (
                <>
                  <PanelResizer width={panelWidth} onChange={setPanelWidth} />
                  <aside
                    className="tool-panel"
                    aria-label={`${sidePaneLabel[sidePane]} panel`}
                    style={{ width: panelWidth }}
                  >
                    {sidePane === "files" ? (
                      <Suspense fallback={<LoadingFilesPane />}>
                        <FilesPane
                          worktree={contextWorktree}
                          focus={filesFocus}
                          onQuickOpen={openQuickOpen}
                          onOpenDiff={(path) => {
                            setSidePane("review");
                            setReviewFocus({ path, nonce: Date.now() });
                          }}
                        />
                      </Suspense>
                    ) : sidePane === "browser" ? (
                      <BrowserPane worktree={contextWorktree} obscured={overlayOpen} reveal={browserReveal} />
                    ) : (
                      <ReviewPane worktree={contextWorktree} focus={reviewFocus} />
                    )}
                  </aside>
                </>
              ) : null}
            </div>
          )}
        </main>
        {paletteOpen ? <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} /> : null}
        {quickOpen && contextWorktree ? (
          <QuickOpen
            worktreeId={contextWorktree.worktreeId}
            branch={contextWorktree.branch}
            onOpen={(location) => openFile({ worktreeId: contextWorktree.worktreeId, ...location })}
            onClose={() => setQuickOpen(false)}
          />
        ) : null}
        {legacyImportBatchId && projection && (
          <LegacyImportDialog
            projection={projection}
            batchId={legacyImportBatchId}
            onImport={(selected) => void importLegacyRecords(selected)}
            onRollback={() => void rollbackLegacyImport()}
            onClose={() => setLegacyImportBatchId(undefined)}
          />
        )}
        {helpOpen && (
          <HelpDialog
            version={version}
            onSupportBundle={() => {
              setHelpOpen(false);
              void exportSupportBundle();
            }}
            onImportLegacy={() => {
              setHelpOpen(false);
              void startLegacyImport();
            }}
            onClose={() => setHelpOpen(false)}
          />
        )}
        {closeRequest && projection && (
          <CloseAgentDialog
            title={sessionTitle(closeRequest, projection.messages, projection.providers)}
            provider={providerDisplayName(closeRequest.provider, projection.providers)}
            onStopAndClose={() => {
              const session = closeRequest;
              setCloseRequest(undefined);
              void stopSession(session);
              closeTileNow(session);
            }}
            onKeepRunning={() => {
              const session = closeRequest;
              setCloseRequest(undefined);
              closeTileNow(session);
            }}
            onCancel={() => setCloseRequest(undefined)}
          />
        )}
        {deleteRequest && projection && (
          <DeleteAgentDialog
            title={sessionTitle(deleteRequest, projection.messages, projection.providers)}
            provider={providerDisplayName(deleteRequest.provider, projection.providers)}
            running={sessionStopCommands(deleteRequest).length > 0}
            worktree={deletableWorktree(projection, sessions, deleteRequest)}
            onDelete={(removeWorktree) => {
              const session = deleteRequest;
              setDeleteRequest(undefined);
              void deleteSession(session, removeWorktree);
            }}
            onCancel={() => setDeleteRequest(undefined)}
          />
        )}
        {worktreeDialogProject && (
          <WorktreeDialog
            onClose={() => setWorktreeDialogProject(undefined)}
            onSubmit={(branch, baseRef) => void submitWorktree(worktreeDialogProject, branch, baseRef)}
          />
        )}
        {newAgentProject && projection && (
          <NewAgentDialog
            projection={projection}
            initialProject={
              newAgentProject === "default" ? (contextProject ?? projection.projects[0]) : newAgentProject
            }
            initialWorktreeId={selectedWorktreeId ?? contextWorktree?.worktreeId}
            onClose={() => setNewAgentProject(undefined)}
            onSubmit={submitNewAgent}
          />
        )}
        <TooltipLayer />
      </div>
    </FileIndexProvider>
  );
}
