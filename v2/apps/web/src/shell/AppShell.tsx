import { type ProjectProjection, type RuntimeProjection, type WorktreeProjection, WorktreeId } from "@zli-v2/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isSelectableProvider } from "../agent/providers.js";
import { AttentionPanel } from "../attention/AttentionPanel.js";
import { BrowserPane } from "../browser/BrowserPane.js";
import { type ReviewFocus, ReviewPane } from "../review/ReviewPane.js";
import { getBridge, type ZliBridge } from "../runtime/bridge.js";
import { makeCommandId } from "../runtime/commandId.js";
import { RuntimeProvider, useRuntime } from "../runtime/RuntimeProvider.js";
import { AgentTile } from "../sessions/AgentTile.js";
import { createWorktree, ensureCheckout, startSessionAgent } from "../sessions/launch.js";
import { type NewAgentRequest, NewAgentDialog } from "../sessions/NewAgentDialog.js";
import { type AgentSession, deriveSessions, gridColumns, type SessionMode } from "../sessions/sessions.js";
import { useWorkbenchState } from "../sessions/workbench.js";
import { LegacyImportDialog } from "../settings/LegacyImportDialog.js";
import { Sidebar, type WorktreeAction } from "../sidebar/Sidebar.js";
import { TerminalDrawer } from "../terminal/TerminalDrawer.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { PanelResizer, usePanelWidth } from "../workspace/PanelResizer.js";
import { HelpDialog } from "./HelpDialog.js";
import "./AppShell.css";

type SidePane = "browser" | "review";

const sidePaneLabel: Record<SidePane, string> = { browser: "Browser", review: "Changes" };

type PaletteCommand = { label: string; icon: IconName; hint?: string; action(): void };

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
  const [paletteQuery, setPaletteQuery] = useState("");
  const [activeCommandIndex, setActiveCommandIndex] = useState(0);
  const [worktreeDialogProject, setWorktreeDialogProject] = useState<ProjectProjection>();
  const [newAgentProject, setNewAgentProject] = useState<ProjectProjection | "default">();
  const [notice, setNotice] = useState<string>();
  const [legacyImportBatchId, setLegacyImportBatchId] = useState<string>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [version, setVersion] = useState<string>();
  const paletteSearchRef = useRef<HTMLInputElement>(null);
  const launching = useRef(new Set<string>());

  const sessions = useMemo(
    () => (projection ? deriveSessions(projection, workbench.pending) : []),
    [projection, workbench.pending],
  );
  const listedSessions = useMemo(
    () => sessions.filter((session) => !workbench.hidden.includes(session.sessionId)),
    [sessions, workbench.hidden],
  );
  const tiles = useMemo(
    () => listedSessions.filter((session) => !workbench.closed.includes(session.sessionId)),
    [listedSessions, workbench.closed],
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

  const openNewAgent = useCallback(
    (project?: ProjectProjection) => {
      if (!hasProjects) return;
      setPaletteOpen(false);
      setNewAgentProject(project ?? "default");
    },
    [hasProjects],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === "k") {
        event.preventDefault();
        setPaletteQuery("");
        setActiveCommandIndex(0);
        setPaletteOpen(true);
      } else if (mod && key === "n" && !event.shiftKey) {
        event.preventDefault();
        openNewAgent();
      } else if (mod && key === "b") {
        event.preventDefault();
        updateWorkbench((state) => ({ ...state, sidebarOpen: !state.sidebarOpen }));
      } else if (mod && key === "j") {
        event.preventDefault();
        updateWorkbench((state) => ({ ...state, drawerOpen: !state.drawerOpen }));
      } else if (event.key === "Escape") {
        setPaletteOpen(false);
        setPaletteQuery("");
        setWorktreeDialogProject(undefined);
        setNewAgentProject(undefined);
        setLegacyImportBatchId(undefined);
        setHelpOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openNewAgent, updateWorkbench]);

  useEffect(() => {
    if (paletteOpen) paletteSearchRef.current?.focus();
  }, [paletteOpen]);

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
      setNotice("The desktop bridge is unavailable. Start ZLI from Electron.");
      return;
    }
    const path = await bridge.dialog.openProject();
    if (!path) return;
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "project.register", path },
    });
    if (response?.accepted === false) setNotice(response.error.message);
  };

  const exportSupportBundle = async () => {
    if (!bridge) {
      setNotice("The desktop bridge is unavailable. Start ZLI from Electron.");
      return;
    }
    const destinationPath = await bridge.dialog.saveSupportBundle();
    if (!destinationPath) return;
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "diagnostics.createSupportBundle", destinationPath },
    });
    if (response?.accepted === false) setNotice(response.error.message);
    else setNotice("Creating a redacted support bundle...");
  };

  const startLegacyImport = async () => {
    if (!bridge) {
      setNotice("The desktop bridge is unavailable. Start ZLI from Electron.");
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
    if (response?.accepted === false) setNotice(response.error.message);
  };

  const importLegacyRecords = async (selectedRecordIds: string[]) => {
    if (!legacyImportBatchId) return;
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "legacy.import", batchId: legacyImportBatchId, selectedRecordIds },
    });
    if (response?.accepted === false) setNotice(response.error.message);
  };

  const rollbackLegacyImport = async () => {
    if (!legacyImportBatchId) return;
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "legacy.rollbackImport", batchId: legacyImportBatchId },
    });
    if (response?.accepted === false) setNotice(response.error.message);
  };

  const bundlePath = projection?.diagnostics?.lastBundle?.path;
  useEffect(() => {
    if (bundlePath) setNotice(`Support bundle saved: ${bundlePath}`);
  }, [bundlePath]);

  useEffect(() => {
    const message = projection?.diagnostics?.lastError;
    if (message) setNotice(`Support bundle failed: ${message}`);
  }, [projection?.diagnostics?.lastError]);

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
    if (response?.accepted === false) setNotice(response.error.message);
    else if (action === "remove" && worktree.worktreeId === selectedWorktreeId) setSelectedWorktreeId(undefined);
  };

  const submitWorktree = async (project: ProjectProjection, branch: string, baseRef: string) => {
    const result = await createWorktree(dispatch, project, branch, baseRef);
    if ("error" in result) {
      setNotice(result.error);
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

  const closeTile = (session: AgentSession) =>
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

  const hideSession = (session: AgentSession) =>
    updateWorkbench((state) => ({
      ...state,
      hidden: [...state.hidden, session.sessionId],
      closed: [...state.closed, session.sessionId],
      pending: state.pending.filter((entry) => entry.sessionId !== session.sessionId),
      ...(state.maximizedSessionId === session.sessionId ? { maximizedSessionId: undefined } : {}),
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
      ? [{ label: "New agent", icon: "plus" as const, hint: "Ctrl N", action: () => openNewAgent() }]
      : []),
    { label: "Open project", icon: "folderOpen", action: () => void openProject() },
    ...(hasProjects
      ? [
          {
            label: "New worktree",
            icon: "branch" as const,
            action: () => setWorktreeDialogProject(contextProject ?? projection?.projects[0]),
          },
        ]
      : []),
    {
      label: "Focus agent",
      icon: "bot",
      action: () => {
        setSidePane(undefined);
        const target = activeSession ?? tiles.at(-1);
        if (target) focusSession(target);
      },
    },
    {
      label: "Toggle terminal",
      icon: "terminal",
      hint: "Ctrl J",
      action: () => updateWorkbench((state) => ({ ...state, drawerOpen: !state.drawerOpen })),
    },
    { label: "Focus browser", icon: "globe", action: () => setSidePane("browser") },
    { label: "Focus review", icon: "diff", action: () => setSidePane("review") },
    {
      label: workbench.sidebarOpen ? "Hide sidebar" : "Show sidebar",
      icon: "panelLeft",
      hint: "Ctrl B",
      action: () => updateWorkbench((state) => ({ ...state, sidebarOpen: !state.sidebarOpen })),
    },
    { label: "Export support bundle", icon: "download", action: () => void exportSupportBundle() },
    { label: "Import legacy snapshot", icon: "upload", action: () => void startLegacyImport() },
    { label: "Help and diagnostics", icon: "help", action: () => setHelpOpen(true) },
  ];
  const filteredCommands = commands.filter((command) =>
    command.label.toLowerCase().includes(paletteQuery.trim().toLowerCase()),
  );
  const runPaletteCommand = (command: PaletteCommand) => {
    setPaletteOpen(false);
    setPaletteQuery("");
    command.action();
  };
  const handlePaletteKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveCommandIndex((index) => (filteredCommands.length === 0 ? 0 : (index + 1) % filteredCommands.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveCommandIndex((index) =>
        filteredCommands.length === 0 ? 0 : (index - 1 + filteredCommands.length) % filteredCommands.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = filteredCommands[activeCommandIndex];
      if (command) runPaletteCommand(command);
    }
  };
  const overlayOpen =
    paletteOpen ||
    worktreeDialogProject !== undefined ||
    newAgentProject !== undefined ||
    helpOpen ||
    (legacyImportBatchId !== undefined && projection !== undefined);
  const columns = gridColumns(visibleTiles.length);
  const rows = Math.max(1, Math.ceil(visibleTiles.length / columns));

  return (
    <div className={`app-shell${workbench.sidebarOpen ? "" : " is-sidebar-hidden"}`}>
      {workbench.sidebarOpen ? (
        <Sidebar
          projection={projection}
          sessions={listedSessions}
          activeSessionId={activeSession?.sessionId}
          activeWorktreeId={contextWorktree?.worktreeId}
          onSelectSession={focusSession}
          onHideSession={hideSession}
          onSelectWorktree={(worktree) => {
            setNotice(undefined);
            setSelectedWorktreeId(worktree.worktreeId);
            const latest = tiles.filter((session) => session.worktreeId === worktree.worktreeId).at(-1);
            updateWorkbench((state) => ({ ...state, activeSessionId: latest?.sessionId }));
          }}
          onNewAgent={openNewAgent}
          onOpenProject={() => void openProject()}
          onCreateWorktree={(project) => setWorktreeDialogProject(project ?? contextProject ?? projection?.projects[0])}
          onWorktreeAction={(worktree, action) => void worktreeAction(worktree, action)}
          onOpenHelp={() => setHelpOpen(true)}
          onHideSidebar={() => updateWorkbench((state) => ({ ...state, sidebarOpen: false }))}
        />
      ) : null}
      <main className="main-workspace">
        <header className="topbar">
          {workbench.sidebarOpen ? null : (
            <button
              className="icon-button"
              type="button"
              onClick={() => updateWorkbench((state) => ({ ...state, sidebarOpen: true }))}
              aria-label="Show sidebar"
              title="Show sidebar (Ctrl B)"
            >
              <Icon name="panelLeft" size={15} />
            </button>
          )}
          <div className="topbar-context">
            {contextWorktree ? (
              <>
                {contextProject ? <span className="topbar-project">{contextProject.name}</span> : null}
                <span className="topbar-branch" title={contextWorktree.path}>
                  <Icon name="branch" size={12} />
                  <span>{contextWorktree.branch}</span>
                </span>
              </>
            ) : (
              <span className="topbar-project is-empty">
                {hasProjects ? "No worktree selected" : "No project open"}
              </span>
            )}
            {tiles.length > 0 ? (
              <span className="topbar-count">
                {tiles.length} {tiles.length === 1 ? "agent" : "agents"}
              </span>
            ) : null}
          </div>
          <span className="topbar-spacer" />
          {workbench.sidebarOpen || !hasProjects ? null : (
            <button className="ghost-button" type="button" onClick={() => openNewAgent()}>
              <Icon name="plus" size={13} />
              New agent
            </button>
          )}
          <div className="topbar-tools">
            <button
              className={`tool-toggle${workbench.drawerOpen ? " is-active" : ""}`}
              type="button"
              aria-pressed={workbench.drawerOpen}
              title="Terminal (Ctrl J)"
              onClick={() => updateWorkbench((state) => ({ ...state, drawerOpen: !state.drawerOpen }))}
            >
              <Icon name="panelBottom" size={14} />
              <span>Terminal</span>
            </button>
            <button
              className={`tool-toggle${sidePane === "browser" ? " is-active" : ""}`}
              type="button"
              aria-pressed={sidePane === "browser"}
              onClick={() => toggleSidePane("browser")}
            >
              <Icon name="globe" size={14} />
              <span>Browser</span>
            </button>
            <button
              className={`tool-toggle${sidePane === "review" ? " is-active" : ""}`}
              type="button"
              aria-pressed={sidePane === "review"}
              onClick={() => toggleSidePane("review")}
            >
              <Icon name="diff" size={14} />
              <span>Review</span>
            </button>
          </div>
          <button className="command-trigger" type="button" onClick={() => setPaletteOpen(true)}>
            <Icon name="search" size={13} />
            <span>Search</span>
            <kbd>Ctrl K</kbd>
          </button>
        </header>
        {notice && (
          <div className="notice-bar" role="alert">
            <Icon name="alert" size={14} />
            <span>{notice}</span>
            <button
              className="icon-button"
              type="button"
              onClick={() => setNotice(undefined)}
              aria-label="Dismiss message"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
        <AttentionPanel items={projection?.attention ?? []} />
        {!bridge ? (
          <DisconnectedState />
        ) : !projection ? (
          <LoadingState />
        ) : (
          <div className="workspace-body">
            <div className="workbench-column">
              <section className="agent-grid-region" aria-label="Agents">
                {visibleTiles.length === 0 ? (
                  <GridEmptyState
                    projection={projection}
                    closedCount={listedSessions.length}
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
                        onClose={() => closeTile(session)}
                        onOpenDiff={(path) => {
                          focusSession(session);
                          setSidePane("review");
                          setReviewFocus(path ? { path, nonce: Date.now() } : undefined);
                        }}
                        onStart={(mode) => startInSession(session, mode)}
                        onRetryPending={() => retryPending(session)}
                        onDismissPending={() => closeTile(session)}
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
                  {sidePane === "browser" ? (
                    <BrowserPane worktree={contextWorktree} obscured={overlayOpen} />
                  ) : (
                    <ReviewPane worktree={contextWorktree} focus={reviewFocus} />
                  )}
                </aside>
              </>
            ) : null}
          </div>
        )}
      </main>
      {paletteOpen && (
        <div className="palette-backdrop">
          <button
            className="dialog-scrim"
            type="button"
            aria-label="Close command palette"
            onClick={() => setPaletteOpen(false)}
          />
          <section
            className="command-palette"
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="palette-search">
              <Icon name="search" size={15} />
              <input
                ref={paletteSearchRef}
                value={paletteQuery}
                onChange={(event) => {
                  setPaletteQuery(event.target.value);
                  setActiveCommandIndex(0);
                }}
                onKeyDown={handlePaletteKeyDown}
                placeholder="Search commands"
                aria-label="Search commands"
              />
            </div>
            <div className="palette-section">
              {filteredCommands.length === 0 ? (
                <p className="palette-empty">No matching commands.</p>
              ) : (
                filteredCommands.map((command, index) => (
                  <button
                    className={index === activeCommandIndex ? "is-active" : undefined}
                    type="button"
                    key={command.label}
                    aria-label={command.label}
                    onClick={() => runPaletteCommand(command)}
                    onMouseMove={() => setActiveCommandIndex(index)}
                  >
                    <Icon name={command.icon} size={15} />
                    <span className="palette-label">{command.label}</span>
                    {command.hint ? <kbd>{command.hint}</kbd> : null}
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      )}
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
      {worktreeDialogProject && (
        <WorktreeDialog
          onClose={() => setWorktreeDialogProject(undefined)}
          onSubmit={(branch, baseRef) => void submitWorktree(worktreeDialogProject, branch, baseRef)}
        />
      )}
      {newAgentProject && projection && (
        <NewAgentDialog
          projection={projection}
          initialProject={newAgentProject === "default" ? (contextProject ?? projection.projects[0]) : newAgentProject}
          initialWorktreeId={selectedWorktreeId ?? contextWorktree?.worktreeId}
          onClose={() => setNewAgentProject(undefined)}
          onSubmit={submitNewAgent}
        />
      )}
    </div>
  );
}

function GridEmptyState({
  projection,
  closedCount,
  onOpenProject,
  onNewAgent,
}: {
  projection: RuntimeProjection;
  closedCount: number;
  onOpenProject(): void;
  onNewAgent(): void;
}) {
  if (projection.projects.length === 0) {
    return (
      <div className="center-state">
        <span className="empty-icon">
          <Icon name="folderOpen" size={20} />
        </span>
        <h1>Open a project to start</h1>
        <p>Pick a Git repository. Agents run side by side in it, each in its own terminal.</p>
        <button className="primary-button" type="button" onClick={onOpenProject}>
          Open project
        </button>
      </div>
    );
  }
  return (
    <div className="center-state">
      <span className="empty-icon">
        <Icon name="grid" size={20} />
      </span>
      <h1>No agents on the board</h1>
      <p>
        {closedCount > 0
          ? "Pick an agent in the sidebar to bring it back, or start another one."
          : "Start an agent in a terminal or a chat. Run several at once, each in its own worktree or in the current checkout."}
      </p>
      <button className="primary-button" type="button" onClick={onNewAgent}>
        <Icon name="plus" size={14} />
        New agent
        <kbd>Ctrl N</kbd>
      </button>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="center-state">
      <span className="empty-icon">
        <Icon name="loader" size={20} />
      </span>
      <h1>Connecting to the local runtime</h1>
      <p>Projects, worktrees, and agents appear once the runtime responds.</p>
    </div>
  );
}

function DisconnectedState() {
  return (
    <div className="center-state">
      <span className="empty-icon">
        <Icon name="alert" size={20} />
      </span>
      <h1>Start ZLI from the desktop app</h1>
      <p>
        This window has no runtime bridge. Run <code>pnpm --dir v2 desktop:dev</code> from the repository root.
      </p>
    </div>
  );
}

function WorktreeDialog({ onClose, onSubmit }: { onClose(): void; onSubmit(branch: string, baseRef: string): void }) {
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const branchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    branchInputRef.current?.focus();
  }, []);
  return (
    <div className="palette-backdrop">
      <button className="dialog-scrim" type="button" aria-label="Close worktree dialog" onClick={onClose} />
      <section
        className="dialog worktree-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Create worktree"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div>
            <h2>New worktree</h2>
            <p className="dialog-subtitle">A separate folder and branch, so agents never edit the same files.</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </div>
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(branch, baseRef);
          }}
        >
          <label className="field">
            <span className="field-label">Branch name</span>
            <input
              ref={branchInputRef}
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder="feature/my-change"
            />
          </label>
          <label className="field">
            <span className="field-label">Start from</span>
            <input value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="HEAD" />
            <span className="field-hint">Any ref or commit. Leave empty to use the current HEAD.</span>
          </label>
          <div className="dialog-actions">
            <button className="secondary-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button" type="submit" disabled={!branch.trim()}>
              Create worktree
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
