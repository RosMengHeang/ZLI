import {
  type Account,
  MCP_CATALOG,
  type PluginAction,
  type PluginOrigin,
  type ProjectProjection,
  type RuntimeProjection,
  type SetupDecision,
  threadOccupiesWorktree,
  WorktreeId,
  type WorktreeProjection,
  type WorktreeSetupProjection,
  worktreeDevServers,
} from "@zli-v2/contracts";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { accountLabel, launchAccountId, sessionAccountId, useAccounts } from "../accounts/accounts.js";
import { isSelectableProvider, listedDiscoveries, preferredProvider, providerDisplayName } from "../agent/providers.js";
import { AttentionPanel } from "../attention/AttentionPanel.js";
import { type BrowserOpenRequest, BrowserPane, type BrowserReveal } from "../browser/BrowserPane.js";
import type { StartRunsRequest } from "../chat/ChatView.js";
import { forkWorktree } from "../chat/checkpointClient.js";
import { addCodeReference } from "../chat/codeReferences.js";
import { textBase64 } from "../chat/pastedText.js";
import { devServerCommands } from "../devservers/DevServers.js";
import { FileIndexProvider, type OpenFileRequest } from "../files/FileIndex.js";
import type { AskAgentTarget, FilesFocus } from "../files/FilesPane.js";
import { filesWorktreeFor } from "../files/filesWorktree.js";
import { QuickOpen } from "../files/QuickOpen.js";
import { type IssueLink, issuePrompt, rememberIssueLink } from "../issues/issueStart.js";
import { MobilePane, type MobileReveal } from "../mobile/MobilePane.js";
import { useAgentNotifications } from "../notifications/useAgentNotifications.js";
import { PluginActionDialog } from "../plugins/PluginActionDialog.js";
import {
  actionApprovalKey,
  actionTerminalCommand,
  isActionApproved,
  listPlugins,
  rememberActionApproval,
  usePluginContributions,
} from "../plugins/plugins.js";
import { PromptsDialog } from "../prompts/PromptsDialog.js";
import { type ManagerRequest, onPromptManagerRequest } from "../prompts/prompts.js";
import { usePullRequestPolling } from "../review/pullRequestStore.js";
import { ReviewNotesPill } from "../review/ReviewNotesPill.js";
import type { ReviewFocus } from "../review/ReviewPane.js";
import { getBridge, type NotificationSettings, type ZliBridge } from "../runtime/bridge.js";
import { makeCommandId } from "../runtime/commandId.js";
import { RuntimeProvider, useRuntime, useShellProjection } from "../runtime/RuntimeProvider.js";
import { AgentTile } from "../sessions/AgentTile.js";
import { keepRunCleanup, planRuns, type RunGroup, runPosition, withoutRun } from "../sessions/bestOf.js";
import { CompareRunsDialog } from "../sessions/CompareRunsDialog.js";
import { firstMessageStep, TERMINAL_FIRST_MESSAGE_DELAY_MS, terminalFirstMessage } from "../sessions/firstMessage.js";
import type { HandoffRequest } from "../sessions/HandoffDialog.js";
import { canHandOff, inlineFirstMessage, recentContextMessage } from "../sessions/handoff.js";
import { createWorktree, ensureCheckout, samePath, startAccountSignIn, startSessionAgent } from "../sessions/launch.js";
import { NewAgentDialog, type NewAgentPrefill, type NewAgentRequest } from "../sessions/NewAgentDialog.js";
import {
  type AgentSession,
  deriveSessions,
  gridLayout,
  type PendingLaunch,
  type SessionMode,
  sessionStopCommands,
  sessionTitle,
} from "../sessions/sessions.js";
import { groupFinished, useRunStates } from "../sessions/useRunStates.js";
import { forgetSession, useWorkbenchState } from "../sessions/workbench.js";
import { resolveLaunchDefaults, updateAppSettings, useAppSettings } from "../settings/appSettings.js";
import { ExpiredSignInNotice } from "../settings/ExpiredSignInNotice.js";
import type { IntegrationsView } from "../settings/IntegrationsSection.js";
import { LegacyImportDialog } from "../settings/LegacyImportDialog.js";
import { SettingsDialog, type SettingsSection } from "../settings/SettingsDialog.js";
import { SetupApprovalDialog } from "../setup/SetupApprovalDialog.js";
import { nextSetupApproval, setupDeferKey } from "../setup/setup.js";
import { Sidebar, type WorktreeAction } from "../sidebar/Sidebar.js";
import { TerminalDrawer } from "../terminal/TerminalDrawer.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { LoadingState } from "../ui/Pane.js";
import { TooltipLayer } from "../ui/Tooltip.js";
import { RestartToUpdateDialog } from "../updates/RestartToUpdateDialog.js";
import { UpdatePill } from "../updates/UpdatePill.js";
import { busyAgentCount } from "../updates/updateCopy.js";
import { useUpdates } from "../updates/useUpdates.js";
import { PanelResizer, usePanelWidth } from "../workspace/PanelResizer.js";
import { CloseAgentDialog, DeleteAgentDialog, deletableWorktree, KeepRunDialog } from "./AgentDialogs.js";
import { CommandPalette, type PaletteCommand } from "./CommandPalette.js";
import { HelpDialog } from "./HelpDialog.js";
import { useShortcuts } from "./keybindings.js";
import { DisconnectedState, GridEmptyState, LoadingFilesPane, RuntimeLoadingState } from "./ShellStates.js";
import { type SidePane, sidePaneLabel, Topbar } from "./Topbar.js";
import { useGlobalShortcuts } from "./useGlobalShortcuts.js";
import { WorktreeDialog } from "./WorktreeDialog.js";
import "./AppShell.css";
import "./shell.css";
import "../files/files.css";

// The editor is large, so it loads the first time the Files panel opens instead of at startup.
const FilesPane = lazy(() => import("../files/FilesPane.js").then((module) => ({ default: module.FilesPane })));
const HandoffDialog = lazy(() =>
  import("../sessions/HandoffDialog.js").then((module) => ({ default: module.HandoffDialog })),
);
const IssuesDialog = lazy(() =>
  import("../issues/IssuesDialog.js").then((module) => ({ default: module.IssuesDialog })),
);
const UsageDialog = lazy(() => import("../usage/UsageDialog.js").then((module) => ({ default: module.UsageDialog })));
// The diff viewer and pull request tools load the first time the Changes panel opens.
const ReviewPane = lazy(() => import("../review/ReviewPane.js").then((module) => ({ default: module.ReviewPane })));
// Release notes render through the Markdown parser, which stays out of the startup bundle.
const WhatsNewDialog = lazy(() =>
  import("../updates/WhatsNewDialog.js").then((module) => ({ default: module.WhatsNewDialog })),
);

export function AppShell({ bridge = getBridge() }: { bridge?: ZliBridge } = {}) {
  return (
    <RuntimeProvider bridge={bridge}>
      <WorkspaceApp />
    </RuntimeProvider>
  );
}

function WorkspaceApp() {
  const { bridge, dispatch } = useRuntime();
  const projection = useShellProjection();
  const [workbench, updateWorkbench] = useWorkbenchState();
  const settings = useAppSettings();
  const { state: accountsState, accounts } = useAccounts();
  const loadedAccounts = accountsState.status === "ready" ? accounts : undefined;
  const [selectedWorktreeId, setSelectedWorktreeId] = useState<string>();
  const [sidePane, setSidePane] = useState<SidePane>();
  const [reviewFocus, setReviewFocus] = useState<ReviewFocus>();
  const [panelWidth, setPanelWidth] = usePanelWidth(sidePane ?? "files");
  const [gridRegionRef, gridWidth] = useElementWidth<HTMLElement>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [worktreeDialogProject, setWorktreeDialogProject] = useState<ProjectProjection>();
  const [newAgentProject, setNewAgentProject] = useState<ProjectProjection | "default">();
  const [issuesProject, setIssuesProject] = useState<ProjectProjection | "default">();
  /** The issue the open New agent dialog was started from. */
  const [issueStart, setIssueStart] = useState<{ link: Omit<IssueLink, "linkedAt">; prefill: NewAgentPrefill }>();
  const [notice, setNotice] = useState<{
    message: string;
    tone: "danger" | "info";
    action?: { label: string; run(): void };
  }>();
  const showError = useCallback((message: string) => setNotice({ message, tone: "danger" }), []);
  const [legacyImportBatchId, setLegacyImportBatchId] = useState<string>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>();
  const [focusConnector, setFocusConnector] = useState<string>();
  const [integrationsView, setIntegrationsView] = useState<IntegrationsView>();
  const [settingsKey, setSettingsKey] = useState(0);
  const [usageOpen, setUsageOpen] = useState(false);
  const [closeRequest, setCloseRequest] = useState<AgentSession>();
  const [deleteRequest, setDeleteRequest] = useState<AgentSession>();
  const [actionRequest, setActionRequest] = useState<{
    action: PluginAction;
    pluginName: string;
    origin: PluginOrigin;
    key: string | undefined;
  }>();
  const [handoffRequest, setHandoffRequest] = useState<AgentSession>();
  const [compareGroupId, setCompareGroupId] = useState<string>();
  const [keepRequest, setKeepRequest] = useState<{ group: RunGroup; session: AgentSession }>();
  const [version, setVersion] = useState<string>();
  const [browserReveal, setBrowserReveal] = useState<BrowserReveal>();
  const [browserOpen, setBrowserOpen] = useState<BrowserOpenRequest>();
  const [mobileReveal, setMobileReveal] = useState<MobileReveal>();
  /** Set by the palette, so the Mobile pane pops its selected device out once it has the device list. */
  const [mobilePopOutRequest, setMobilePopOutRequest] = useState<number>();
  const [filesFocus, setFilesFocus] = useState<FilesFocus>();
  const [quickOpen, setQuickOpen] = useState(false);
  /** Setup approvals the person closed without answering; they stay reachable from the sidebar. */
  const [deferredSetups, setDeferredSetups] = useState<string[]>([]);
  const [promptManager, setPromptManager] = useState<ManagerRequest>();
  const [restartConfirm, setRestartConfirm] = useState(false);
  const setupApprovalRef = useRef<WorktreeSetupProjection>(undefined);
  const whatsNewRef = useRef(false);
  const launching = useRef(new Set<string>());
  const projectionRef = useRef(projection);
  projectionRef.current = projection;

  const sessions = useMemo(
    () => (projection ? deriveSessions(projection, workbench.pending, workbench.chats) : []),
    [projection, workbench.pending, workbench.chats],
  );
  /** Asks one tile to open its New chat menu, so the person picks blank or recent context each time. */
  const [newChatRequest, setNewChatRequest] = useState<{ sessionId: string; nonce: number }>();
  const readyWorktreeIds = useMemo(() => {
    const withoutGit = new Set(
      (projection?.projects ?? []).filter((project) => project.git === false).map((project) => project.projectId),
    );
    return (projection?.worktrees ?? [])
      .filter((worktree) => worktree.status === "ready" && !withoutGit.has(worktree.projectId))
      .map((worktree) => worktree.worktreeId)
      .sort();
  }, [projection?.worktrees, projection?.projects]);
  // Keeps the sidebar's pull request and CI badges current; checks still running are revisited sooner.
  usePullRequestPolling(dispatch, readyWorktreeIds);
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
  const runStates = useRunStates(workbench.groups, sessions);
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
  /** A folder picked in the Files panel while the focused agent's worktree is not ready. */
  const [filesFolderId, setFilesFolderId] = useState<string>();
  const files = useMemo(
    () => filesWorktreeFor(projection, contextWorktree, filesFolderId),
    [projection, contextWorktree, filesFolderId],
  );
  const pluginActions = usePluginContributions(paletteOpen).actions;

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

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const notifications = useAgentNotifications(
    bridge,
    useMemo(() => visibleTiles.map((session) => session.sessionId), [visibleTiles]),
    (sessionId) => {
      const session = sessionsRef.current.find((candidate) => candidate.sessionId === sessionId);
      if (session) focusSession(session);
    },
  );

  const updates = useUpdates(bridge);
  const busyAgents = busyAgentCount(sessions);
  const readyUpdate = updates.status?.state.status === "ready" ? updates.status.state : undefined;
  /** Restarts into the downloaded update, asking first when that would cut an agent off mid-turn. */
  const restartToUpdate = () => {
    setPaletteOpen(false);
    setSettingsSection(undefined);
    if (busyAgents > 0) setRestartConfirm(true);
    else void updates.install();
  };

  /** Brings an agent forward and puts the cursor in its prompt. */
  const showAgent = useCallback(
    (sessionId: string) => {
      const session = sessions.find((candidate) => candidate.sessionId === sessionId);
      if (!session) return;
      focusSession(session);
      requestAnimationFrame(() => {
        const tile = document.querySelector(`.agent-tile[data-session-id="${CSS.escape(sessionId)}"]`);
        tile
          ?.querySelector<HTMLElement>(
            session.mode === "chat" ? 'textarea[aria-label^="Message"]' : ".xterm-helper-textarea",
          )
          ?.focus();
      });
    },
    [sessions, focusSession],
  );

  /** The chat that Ask about this in the Files panel adds references to: the focused agent's, or the newest open one. */
  const askAgent = useMemo((): AskAgentTarget | undefined => {
    const worktreeId = contextWorktree?.worktreeId;
    const usable = (session: AgentSession) =>
      session.worktreeId === worktreeId &&
      session.mode === "chat" &&
      session.thread !== undefined &&
      session.thread.status !== "stopped" &&
      session.thread.status !== "failed";
    const session = activeSession && usable(activeSession) ? activeSession : tiles.findLast(usable);
    const thread = session?.thread;
    if (!session || !thread) return undefined;
    return {
      name: providerDisplayName(session.provider, projection?.providers),
      ask: (reference) => {
        addCodeReference(thread.threadId, reference);
        showAgent(session.sessionId);
      },
    };
  }, [activeSession, contextWorktree?.worktreeId, projection?.providers, showAgent, tiles]);

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
  const mobileAvailable = Boolean(bridge?.mobile);
  const mobilePopOutAvailable = Boolean(bridge?.mobile?.popOut);
  useEffect(() => {
    if (!bridge?.mobile) return;
    let key = 0;
    return bridge.mobile.onReveal(({ deviceId }) => {
      key += 1;
      setMobileReveal({ deviceId, key });
      setSidePane("mobile");
    });
  }, [bridge]);

  const contextDevServers = useMemo(
    () => worktreeDevServers(projection?.devServers, contextWorktree?.worktreeId),
    [projection?.devServers, contextWorktree?.worktreeId],
  );
  const mobileDevServers = useMemo(() => {
    const titles = new Map(projection?.terminals.map((terminal) => [terminal.terminalId, terminal.title]));
    return contextDevServers.map(({ port, url, terminalId }) => ({ port, url, name: titles.get(terminalId) }));
  }, [contextDevServers, projection?.terminals]);
  const openDevServer = useCallback(
    (url: string) => {
      const worktreeId = contextWorktree?.worktreeId;
      if (!worktreeId) return;
      setBrowserOpen({ url, worktreeId, key: Date.now() });
      setSidePane("browser");
    },
    [contextWorktree?.worktreeId],
  );

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

  const openIssues = useCallback(
    (project?: ProjectProjection) => {
      if (!hasProjects) return;
      setPaletteOpen(false);
      setIssuesProject(project ?? "default");
    },
    [hasProjects],
  );

  const toggleSidePane = (next: SidePane) => setSidePane((current) => (current === next ? undefined : next));
  // Zoomed far in, the window is too narrow to keep the sidebar beside the work, so it starts hidden
  // there without changing the saved choice for wider windows.
  const narrow = useNarrowWindow();
  const [narrowSidebarOpen, setNarrowSidebarOpen] = useState(false);
  const sidebarOpen = narrow ? narrowSidebarOpen : workbench.sidebarOpen;
  const toggleSidebar = () =>
    narrow
      ? setNarrowSidebarOpen((open) => !open)
      : updateWorkbench((state) => ({ ...state, sidebarOpen: !state.sidebarOpen }));
  const hideSidebar = () =>
    narrow ? setNarrowSidebarOpen(false) : updateWorkbench((state) => ({ ...state, sidebarOpen: false }));
  const toggleDrawer = () => updateWorkbench((state) => ({ ...state, drawerOpen: !state.drawerOpen }));
  const openSettings = (section: SettingsSection = "agents") => {
    setPaletteOpen(false);
    setFocusConnector(undefined);
    setIntegrationsView(undefined);
    setSettingsSection(section);
  };
  /** Opens Integrations at a connector; a server name that is not in the catalog opens the Installed tab. */
  const openConnectors = useCallback((connectorId?: string) => {
    const entry = connectorId ? MCP_CATALOG.find((candidate) => candidate.id === connectorId.toLowerCase()) : undefined;
    setPaletteOpen(false);
    setFocusConnector(entry?.id);
    setIntegrationsView(connectorId && !entry ? "installed" : "browse");
    // A new key reopens a dialog that is already showing, so it lands on the connector.
    setSettingsKey((key) => key + 1);
    setSettingsSection("integrations");
  }, []);
  useEffect(
    () => bridge?.notifications?.onOpenConnector?.(({ connectorId }) => openConnectors(connectorId)),
    [bridge, openConnectors],
  );
  const openUsage = () => {
    setPaletteOpen(false);
    setUsageOpen(true);
  };
  const shortcuts = useShortcuts();
  useGlobalShortcuts({
    palette: () => setPaletteOpen(true),
    newAgent: () => openNewAgent(),
    newChat: () => {
      const target = newChatTarget(activeSession);
      if (target) setNewChatRequest({ sessionId: target.sessionId, nonce: Date.now() });
      else showError("Focus an agent's chat first, then start a new chat in it.");
    },
    quickOpen: openQuickOpen,
    searchFiles: searchInFiles,
    toggleSidebar,
    toggleDrawer,
    toggleFiles: () => toggleSidePane("files"),
    toggleBrowser: () => toggleSidePane("browser"),
    toggleMobile: () => {
      if (mobileAvailable) toggleSidePane("mobile");
    },
    toggleChanges: () => toggleSidePane("review"),
    settings: () => openSettings(),
    escape: () => {
      setPaletteOpen(false);
      setQuickOpen(false);
      setWorktreeDialogProject(undefined);
      setNewAgentProject(undefined);
      setIssuesProject(undefined);
      setIssueStart(undefined);
      setLegacyImportBatchId(undefined);
      setHelpOpen(false);
      setSettingsSection(undefined);
      setUsageOpen(false);
      setCloseRequest(undefined);
      setDeleteRequest(undefined);
      setActionRequest(undefined);
      setHandoffRequest(undefined);
      setCompareGroupId(undefined);
      setKeepRequest(undefined);
      setPromptManager(undefined);
      setRestartConfirm(false);
      if (whatsNewRef.current) updates.dismissWhatsNew();
      const approval = setupApprovalRef.current;
      if (approval) deferSetup(approval);
    },
  });
  useEffect(
    () =>
      onPromptManagerRequest((request) => {
        setPaletteOpen(false);
        setPromptManager(request);
      }),
    [],
  );
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
      const provider = launch.provider;
      if (!isSelectableProvider(provider)) {
        fail("This agent is not supported.");
        continue;
      }
      launching.current.add(launch.sessionId);
      const fork = launch.fork;
      const forked = fork
        ? forkWorktree(dispatch, worktree.worktreeId, fork).then(
            () => undefined,
            (cause: unknown) =>
              cause instanceof Error ? cause.message : "The files could not be copied into the new worktree.",
          )
        : Promise.resolve(undefined);
      void forked
        .then(
          (failure) =>
            failure ??
            startSessionAgent(dispatch, projection, {
              provider,
              mode: launch.mode,
              permissionMode: launch.permissionMode ?? "full-access",
              ...(launch.model ? { model: launch.model } : {}),
              ...(launch.accountId ? { accountId: launch.accountId } : {}),
              sessionId: launch.sessionId,
              worktreeId: worktree.worktreeId,
              cwd: worktree.path,
            }),
        )
        .then((failure) => {
          // The id stays in `launching` until a retry: an effect from an earlier render can still run with
          // this launch not yet marked started, and it must not fork the worktree and start it again.
          updateWorkbench((state) => {
            // The pending entry may already be gone because the session showed up in the projection first.
            const prompt = failure ? undefined : launch.prompt;
            const message = prompt
              ? { text: prompt, ...(launch.promptFile ? { file: launch.promptFile } : {}) }
              : undefined;
            return {
              ...state,
              pending: state.pending.map((candidate) => {
                if (candidate.sessionId !== launch.sessionId) return candidate;
                if (failure) return { ...candidate, errorMessage: failure };
                const { prompt: _prompt, promptFile: _file, fork: _fork, ...rest } = candidate;
                return { ...rest, started: true };
              }),
              ...(message ? { firstMessages: { ...state.firstMessages, [launch.sessionId]: message } } : {}),
            };
          });
        });
    }
  }, [dispatch, projection, sessions, updateWorkbench, workbench.pending]);

  // A first message goes out once its agent can take input: an idle chat, or a CLI that had time to draw.
  const delivering = useRef(new Set<string>());
  useEffect(() => {
    const forget = (sessionId: string) =>
      updateWorkbench((state) => {
        const { [sessionId]: _sent, ...firstMessages } = state.firstMessages;
        return { ...state, firstMessages };
      });
    const run = async (command: Record<string, unknown>) => {
      try {
        const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
        if (response?.accepted === false) showError(response.error.message);
      } catch (cause) {
        showError(cause instanceof Error ? cause.message : "The first message could not be sent.");
      }
    };
    for (const [sessionId, message] of Object.entries(workbench.firstMessages)) {
      if (delivering.current.has(sessionId)) continue;
      const step = firstMessageStep(
        sessions.find((session) => session.sessionId === sessionId),
        message.after,
      );
      if (step.kind === "wait") continue;
      if (step.kind === "drop") {
        forget(sessionId);
        continue;
      }
      delivering.current.add(sessionId);
      if (step.kind === "chat") {
        forget(sessionId);
        const { file } = message;
        void run({
          type: "thread.send",
          threadId: step.threadId,
          text: message.text,
          ...(file
            ? { attachments: [{ name: file.name, mimeType: "text/plain", dataBase64: textBase64(file.text) }] }
            : {}),
        }).finally(() => delivering.current.delete(sessionId));
        continue;
      }
      const keys = terminalFirstMessage(inlineFirstMessage(message.text, message.file));
      setTimeout(() => {
        forget(sessionId);
        void run({ type: "terminal.write", terminalId: step.terminalId, data: keys.body })
          .then(() => new Promise((resolve) => setTimeout(resolve, 150)))
          .then(() => run({ type: "terminal.write", terminalId: step.terminalId, data: keys.submit }))
          .finally(() => delivering.current.delete(sessionId));
      }, TERMINAL_FIRST_MESSAGE_DELAY_MS);
    }
  }, [dispatch, sessions, showError, updateWorkbench, workbench.firstMessages]);

  // A run deleted some other way leaves its group.
  useEffect(() => {
    if (!projection) return;
    const known = new Set(sessions.map((session) => session.sessionId));
    const gone = workbench.groups.flatMap((group) => group.sessionIds.filter((sessionId) => !known.has(sessionId)));
    if (gone.length === 0) return;
    updateWorkbench((state) => ({
      ...state,
      groups: gone.reduce((groups, sessionId) => withoutRun(groups, sessionId), state.groups),
    }));
  }, [projection, sessions, updateWorkbench, workbench.groups]);

  useEffect(() => {
    const finished = workbench.groups.filter((group) => !group.notified && groupFinished(group, runStates));
    if (finished.length === 0) return;
    const ids = new Set(finished.map((group) => group.groupId));
    updateWorkbench((state) => ({
      ...state,
      groups: state.groups.map((group) => (ids.has(group.groupId) ? { ...group, notified: true } : group)),
    }));
    const group = finished.at(-1);
    if (!group) return;
    setNotice({
      message: `All ${group.sessionIds.length} runs for ${group.label} finished. Compare them and keep one.`,
      tone: "info",
      action: { label: "Compare", run: () => setCompareGroupId(group.groupId) },
    });
  }, [runStates, updateWorkbench, workbench.groups]);

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

  /** Polls the projection, which catches up with a command a moment after it is accepted. */
  const waitForProjection = async <T,>(
    pick: (current: RuntimeProjection) => T | undefined,
    timeoutMs = 8000,
  ): Promise<T | undefined> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = projectionRef.current;
      const found = current ? pick(current) : undefined;
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  };

  const startingScratch = useRef(false);
  /** A chat outside any project, in a folder of its own that ZLI keeps for quick questions. */
  const startScratchChat = async () => {
    setPaletteOpen(false);
    if (!bridge?.scratch) {
      showError("The desktop bridge is unavailable. Start ZLI from Electron.");
      return;
    }
    if (startingScratch.current) return;
    startingScratch.current = true;
    setNotice(undefined);
    try {
      const path = await bridge.scratch.folder();
      if (!path) throw new Error("The scratch folder could not be created.");
      const findProject = (current: RuntimeProjection) =>
        current.projects.find((candidate) => samePath(candidate.path, path));
      let project = projectionRef.current ? findProject(projectionRef.current) : undefined;
      if (!project) {
        const response = await dispatch({
          protocolVersion: 1,
          commandId: makeCommandId(),
          command: { type: "project.register", path },
        });
        if (response?.accepted === false) throw new Error(response.error.message);
        project = await waitForProjection(findProject);
      }
      const current = projectionRef.current;
      if (!project || !current) throw new Error("The scratch folder could not be added.");
      const listed = listedDiscoveries(current.providers);
      const defaults = resolveLaunchDefaults(settings, project.projectId);
      const provider =
        listed.find((entry) => entry.provider === defaults.provider && entry.status === "found")?.provider ??
        (listed.some((entry) => entry.status === "found") ? preferredProvider(listed) : undefined);
      if (!provider) throw new Error("No agent CLI is installed. Install one, then start a scratch chat.");
      const checkout = await ensureCheckout(dispatch, current, project);
      if ("error" in checkout) throw new Error(checkout.error);
      const accountId = launchAccountId(accounts, provider, undefined);
      const launch: PendingLaunch = {
        sessionId: makeCommandId(),
        worktreeId: checkout.worktreeId,
        provider,
        mode: "chat",
        permissionMode: defaults.permissionMode ?? "full-access",
        ...(defaults.provider === provider && defaults.model ? { model: defaults.model } : {}),
        ...(accountId ? { accountId } : {}),
        createdAt: new Date().toISOString(),
      };
      updateWorkbench((state) => ({
        ...state,
        pending: [...state.pending, launch],
        activeSessionId: launch.sessionId,
        maximizedSessionId: undefined,
      }));
      setSelectedWorktreeId(checkout.worktreeId);
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : "The scratch chat could not start.");
    } finally {
      startingScratch.current = false;
    }
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

  // Setup problems never block the worktree, so they are announced once as they happen.
  const announcedSetups = useRef<Set<string>>(undefined);
  const worktreeSetups = projection?.worktreeSetups;
  const hasProjection = projection !== undefined;
  useEffect(() => {
    if (!hasProjection) return;
    const problems = (worktreeSetups ?? []).filter((setup) => setup.status === "invalid" || setup.status === "failed");
    const key = (setup: WorktreeSetupProjection) => `${setup.worktreeId}:${setup.status}:${setup.errorMessage ?? ""}`;
    if (!announcedSetups.current) {
      announcedSetups.current = new Set(problems.map(key));
      return;
    }
    for (const setup of problems) {
      if (announcedSetups.current.has(key(setup))) continue;
      announcedSetups.current.add(key(setup));
      const branch =
        projectionRef.current?.worktrees.find((worktree) => worktree.worktreeId === setup.worktreeId)?.branch ??
        "the new worktree";
      showError(
        setup.status === "invalid"
          ? `${setup.errorMessage ?? "zli.json could not be read."} ${branch} was created without running setup.`
          : `Setup failed in ${branch}. ${setup.errorMessage ?? ""}`.trim(),
      );
    }
  }, [hasProjection, worktreeSetups, showError]);

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
    // Same as picking it in the sidebar, so the new worktree is the one in view and stays listed there.
    setSelectedWorktreeId(result.worktreeId);
    updateWorkbench((state) => ({ ...state, activeSessionId: undefined }));
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
    const launch: PendingLaunch = {
      sessionId: makeCommandId(),
      worktreeId,
      provider: request.provider,
      mode: request.mode,
      permissionMode: request.permissionMode,
      ...(request.model ? { model: request.model } : {}),
      ...(request.prompt ? { prompt: request.prompt } : {}),
      ...(request.accountId ? { accountId: request.accountId } : {}),
      createdAt: new Date().toISOString(),
    };
    if (issueStart) {
      rememberIssueLink(worktreeId, { ...issueStart.link, sessionId: launch.sessionId, linkedAt: launch.createdAt });
    }
    updateWorkbench((state) => ({
      ...state,
      pending: [...state.pending, launch],
      activeSessionId: launch.sessionId,
      maximizedSessionId: undefined,
    }));
    setSelectedWorktreeId(worktreeId);
    setNewAgentProject(undefined);
    setIssueStart(undefined);
    return undefined;
  };
  const submitHandoff = async (from: AgentSession, request: HandoffRequest): Promise<string | undefined> => {
    const worktree = findWorktree(from.worktreeId);
    if (worktree?.status !== "ready") return "The worktree for this agent is gone.";
    if (request.stopCurrent) await stopSession(from);
    // The same agent keeps the same login; another agent gets its own default.
    const accountId = launchAccountId(
      accounts,
      request.provider,
      request.provider === from.provider ? sessionAccountId(from) : undefined,
    );
    const launch: PendingLaunch = {
      sessionId: makeCommandId(),
      worktreeId: worktree.worktreeId,
      provider: request.provider,
      mode: request.mode,
      permissionMode: from.thread?.permissionMode ?? "full-access",
      ...(accountId ? { accountId } : {}),
      prompt: request.message.text,
      promptFile: request.message.transcript,
      createdAt: new Date().toISOString(),
    };
    updateWorkbench((state) => ({
      ...state,
      pending: [...state.pending, launch],
      closed:
        request.stopCurrent && !state.closed.includes(from.sessionId)
          ? [...state.closed, from.sessionId]
          : state.closed,
      activeSessionId: launch.sessionId,
      ...(state.maximizedSessionId ? { maximizedSessionId: launch.sessionId } : {}),
    }));
    setHandoffRequest(undefined);
    return undefined;
  };
  /** Starts one agent per run, each in a new worktree that copies the files the runs start from. */
  const startRuns = async (source: AgentSession, request: StartRunsRequest): Promise<string | undefined> => {
    const sourceWorktree = findWorktree(source.worktreeId);
    const project = projection?.projects.find((entry) => entry.projectId === sourceWorktree?.projectId);
    if (!projection || !sourceWorktree || !project) return "The worktree for this agent is gone.";
    const plan = planRuns(
      sourceWorktree.branch,
      request.runs,
      projection.worktrees.map((worktree) => worktree.branch),
    );
    const baseRef = sourceWorktree.branch === "HEAD" ? "" : sourceWorktree.branch;
    const created: string[] = [];
    for (const run of plan) {
      const result = await createWorktree(dispatch, project, run.branch, baseRef);
      if ("error" in result) {
        await Promise.all(created.map((worktreeId) => send({ type: "worktree.cancel", worktreeId })));
        return result.error;
      }
      created.push(result.worktreeId);
    }
    const createdAt = new Date().toISOString();
    const launches: PendingLaunch[] = plan.map((run, index): PendingLaunch => {
      const accountId = launchAccountId(
        accounts,
        run.agent.provider,
        run.agent.provider === source.provider ? sessionAccountId(source) : undefined,
      );
      return {
        sessionId: makeCommandId(),
        worktreeId: created[index] ?? "",
        provider: run.agent.provider,
        mode: "chat",
        permissionMode: request.permissionMode,
        ...(run.agent.model ? { model: run.agent.model } : {}),
        ...(accountId ? { accountId } : {}),
        prompt: request.prompt,
        fork: request.from,
        createdAt,
      };
    });
    const group: RunGroup = {
      groupId: makeCommandId(),
      sourceSessionId: source.sessionId,
      label: sourceWorktree.branch === "HEAD" ? "this chat" : sourceWorktree.branch,
      prompt: request.prompt,
      sessionIds: launches.map((launch) => launch.sessionId),
      createdAt,
    };
    updateWorkbench((state) => ({
      ...state,
      pending: [...state.pending, ...launches],
      groups: [...state.groups, group],
      activeSessionId: launches[0]?.sessionId ?? state.activeSessionId,
      maximizedSessionId: undefined,
    }));
    return undefined;
  };

  const keepRun = async (group: RunGroup, kept: AgentSession) => {
    setKeepRequest(undefined);
    setCompareGroupId(undefined);
    const current = projectionRef.current;
    if (!current) return;
    updateWorkbench((state) => ({ ...state, groups: state.groups.filter((entry) => entry.groupId !== group.groupId) }));
    focusSession(kept);
    const discarded = keepRunCleanup(current, sessionsRef.current, group, kept.sessionId);
    await Promise.all(discarded.map(({ session, worktree }) => deleteSession(session, worktree !== undefined, true)));
  };

  const handoffTarget = (session: AgentSession | undefined) =>
    session?.mode === "chat" &&
    canHandOff(session, projection?.messages) &&
    findWorktree(session.worktreeId)?.status === "ready"
      ? session
      : undefined;

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

  const deleteSession = async (session: AgentSession, removeWorktree: boolean, deleteBranch = false): Promise<void> => {
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
    if (worktree.status !== "ready" && worktree.status !== "failed") {
      await send({ type: "worktree.cancel", worktreeId: worktree.worktreeId });
      return;
    }
    // The person confirmed that uncommitted changes in the folder are lost.
    const removed = await send({
      type: "worktree.remove",
      worktreeId: worktree.worktreeId,
      force: true,
      ...(deleteBranch ? { deleteBranch: true } : {}),
    });
    if (removed && worktree.worktreeId === selectedWorktreeId) setSelectedWorktreeId(undefined);
  };

  const renameProject = async (projectId: string, name: string) => {
    const response = await dispatch({
      protocolVersion: 1,
      commandId: makeCommandId(),
      command: { type: "project.rename", projectId, name },
    });
    if (response?.accepted === false) showError(response.error.message);
  };

  /** Removes a project from ZLI. Its folder, and the folders of its worktrees, stay on disk. */
  const removeProject = async (projectId: string): Promise<string | undefined> => {
    const current = projectionRef.current;
    if (!current) return "The runtime is not connected.";
    const request = async (command: Record<string, unknown>): Promise<string | undefined> => {
      try {
        const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
        if (!response) return "The runtime is not connected.";
        return response.accepted === false ? response.error.message : undefined;
      } catch (cause) {
        return cause instanceof Error ? cause.message : "The command failed.";
      }
    };
    const worktreeIds = new Set<string>(
      current.worktrees.filter((worktree) => worktree.projectId === projectId).map((worktree) => worktree.worktreeId),
    );
    const isRunning = (state: RuntimeProjection) =>
      state.terminals.some(
        (terminal) =>
          worktreeIds.has(terminal.worktreeId) && (terminal.status === "running" || terminal.status === "starting"),
      ) || state.threads.some((thread) => worktreeIds.has(thread.worktreeId) && threadOccupiesWorktree(thread.status));
    const inProject = deriveSessions(current, workbench.pending).filter((session) =>
      worktreeIds.has(session.worktreeId),
    );
    const shells = current.terminals.filter(
      (terminal) =>
        terminal.kind !== "agent" &&
        worktreeIds.has(terminal.worktreeId) &&
        (terminal.status === "running" || terminal.status === "starting"),
    );
    const stops = [
      ...inProject.flatMap((session) => sessionStopCommands(session)),
      ...shells.map((terminal) => ({ type: "terminal.stop", terminalId: terminal.terminalId })),
    ];
    if (stops.length > 0) {
      await Promise.all(stops.map((command) => request(command)));
      await waitForProjection((state) => (isRunning(state) ? undefined : true));
    }
    for (const session of inProject) {
      if (!session.terminal && !session.thread) continue;
      const problem = await request({ type: "session.delete", sessionId: session.sessionId });
      if (problem) return problem;
    }
    updateWorkbench((state) => inProject.reduce((next, session) => forgetSession(next, session.sessionId), state));
    const problem = await request({ type: "project.archive", projectId });
    if (problem) return problem;
    updateAppSettings((settingsNow) => {
      const { [projectId]: _removed, ...projects } = settingsNow.projects;
      return { ...settingsNow, projects };
    });
    if (selectedWorktreeId && worktreeIds.has(selectedWorktreeId)) setSelectedWorktreeId(undefined);
    return undefined;
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
    launching.current.delete(session.sessionId);
    updateWorkbench((state) => ({
      ...state,
      pending: state.pending.map((entry) => {
        if (entry.sessionId !== session.sessionId) return entry;
        const { errorMessage: _error, started: _started, ...rest } = entry;
        return rest;
      }),
    }));
  };

  /** Runs the agent's sign-in in a tile, in the worktree in focus, so the person can finish it there. */
  const signInAccount = async (account: Account): Promise<string | undefined> => {
    const worktree = contextWorktree?.status === "ready" ? contextWorktree : undefined;
    if (!projection || !worktree) return "Add a project first. Sign in runs in a terminal in one of its folders.";
    const sessionId = makeCommandId();
    const failure = await startAccountSignIn(dispatch, projection, {
      provider: account.provider,
      accountId: account.id,
      sessionId,
      worktreeId: worktree.worktreeId,
      cwd: worktree.path,
    });
    if (failure) return failure;
    setSettingsSection(undefined);
    setSelectedWorktreeId(worktree.worktreeId);
    updateWorkbench((state) => ({ ...state, activeSessionId: sessionId, maximizedSessionId: undefined }));
    return undefined;
  };

  const startInSession = (session: AgentSession, mode: SessionMode): Promise<string | undefined> => {
    const worktree = findWorktree(session.worktreeId);
    if (!projection || !worktree) return Promise.resolve("The worktree for this agent is gone.");
    if (worktree.status !== "ready") return Promise.resolve("The worktree is not ready yet.");
    if (!isSelectableProvider(session.provider)) return Promise.resolve("This agent is not supported.");
    const model = session.thread?.model ?? session.terminal?.agent?.model;
    const accountId = sessionAccountId(session);
    const started = startSessionAgent(dispatch, projection, {
      provider: session.provider,
      mode,
      permissionMode: session.thread?.permissionMode ?? session.terminal?.agent?.permissionMode ?? "full-access",
      ...(model ? { model } : {}),
      ...(accountId ? { accountId } : {}),
      sessionId: session.sessionId,
      worktreeId: worktree.worktreeId,
      cwd: worktree.path,
    });
    // A chat started while an earlier one is on screen is the newest, so the tile shows it instead.
    return started.then((failure) => {
      if (!failure && mode === "chat") {
        updateWorkbench((state) => {
          if (!state.chats[session.sessionId]) return state;
          const { [session.sessionId]: _shown, ...chats } = state.chats;
          return { ...state, chats };
        });
      }
      return failure;
    });
  };

  const newChatTarget = (session: AgentSession | undefined) =>
    session?.mode === "chat" &&
    session.thread &&
    isSelectableProvider(session.provider) &&
    findWorktree(session.worktreeId)?.status === "ready"
      ? session
      : undefined;

  /**
   * Starts another chat in the session's tile. The current chat stops and stays in the tile's history;
   * one with an agent conversation id picks up again when it gets a message.
   */
  const startNewChat = async (session: AgentSession, withContext: boolean): Promise<string | undefined> => {
    const current = projectionRef.current;
    const worktree = findWorktree(session.worktreeId);
    if (!current || !worktree) return "The worktree for this agent is gone.";
    const thread = session.thread;
    const message =
      withContext && thread
        ? recentContextMessage({
            title: sessionTitle(session, current.messages, current.providers),
            name: providerDisplayName(session.provider, current.providers),
            branch: worktree.branch,
            messages: (current.messages ?? []).filter((entry) => entry.threadId === thread.threadId),
          })
        : undefined;
    if (thread && thread.status !== "stopped" && thread.status !== "failed") {
      const stopped = await send({ type: "thread.stop", threadId: thread.threadId });
      if (!stopped) return "The current chat could not be stopped.";
    }
    const after = (session.threads ?? []).map((entry) => entry.threadId);
    updateWorkbench((state) => {
      const { [session.sessionId]: _shown, ...chats } = state.chats;
      return {
        ...state,
        chats,
        ...(message
          ? {
              firstMessages: {
                ...state.firstMessages,
                [session.sessionId]: { text: message.text, file: message.transcript, after },
              },
            }
          : {}),
      };
    });
    const failure = await startInSession(session, "chat");
    if (failure && message) {
      updateWorkbench((state) => {
        const { [session.sessionId]: _message, ...firstMessages } = state.firstMessages;
        return { ...state, firstMessages };
      });
    }
    return failure;
  };

  /** Shows an earlier chat in the session's tile. The chat on screen stops, so one agent runs per tile. */
  const openChat = async (session: AgentSession, threadId: string) => {
    const thread = session.thread;
    if (thread && thread.threadId !== threadId && thread.status !== "stopped" && thread.status !== "failed") {
      if (!(await send({ type: "thread.stop", threadId: thread.threadId }))) return;
    }
    const latest = session.threads?.at(-1)?.threadId;
    updateWorkbench((state) => {
      const { [session.sessionId]: _shown, ...chats } = state.chats;
      return { ...state, chats: threadId === latest ? chats : { ...chats, [session.sessionId]: threadId } };
    });
  };

  /** Asks first unless the person already approved this exact command from this plugin. */
  const runPluginAction = async (action: PluginAction) => {
    const key = await actionApprovalKey(action);
    if (key && isActionApproved(key)) {
      await startPluginAction(action);
      return;
    }
    const plugin = await listPlugins(dispatch)
      .then((result) => result.plugins.find((entry) => entry.name === action.plugin))
      .catch(() => undefined);
    setActionRequest({
      action,
      pluginName: plugin?.displayName ?? action.plugin,
      origin: plugin?.origin ?? "other",
      key,
    });
  };

  /** Selects the project's own folder, adding it as the project's checkout when it is not in the workspace yet. */
  const openProjectFolder = async (projectId: string): Promise<string | undefined> => {
    const project = projection?.projects.find((candidate) => candidate.projectId === projectId);
    if (!projection || !project) return undefined;
    try {
      const checkout = await ensureCheckout(dispatch, projection, project);
      if ("error" in checkout) {
        showError(checkout.error);
        return undefined;
      }
      setSelectedWorktreeId(checkout.worktreeId);
      return checkout.worktreeId;
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : "The project folder could not be opened.");
      return undefined;
    }
  };
  const openBrowserInProject = async (projectId: string) => {
    await openProjectFolder(projectId);
  };
  const openFilesInProject = async (projectId: string) => {
    setFilesFolderId(await openProjectFolder(projectId));
  };

  const checkoutTried = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the panel opening or the need changing should act.
  useEffect(() => {
    if (sidePane !== "files" || !files.needsCheckout || !projection || !contextProject) return;
    if (checkoutTried.current.has(contextProject.projectId)) return;
    checkoutTried.current.add(contextProject.projectId);
    void ensureCheckout(dispatch, projection, contextProject).catch(() => undefined);
  }, [sidePane, files.needsCheckout, contextProject?.projectId]);

  /** Runs in the current worktree, or else in the project's own checkout. */
  const startPluginAction = async (action: PluginAction) => {
    const project = contextProject ?? projection?.projects[0];
    if (!projection || !project) return;
    try {
      const worktree =
        contextWorktree?.status === "ready" ? contextWorktree : await ensureCheckout(dispatch, projection, project);
      if ("error" in worktree) {
        showError(worktree.error);
        return;
      }
      const response = await dispatch({
        protocolVersion: 1,
        commandId: makeCommandId(),
        command: actionTerminalCommand(action, worktree),
      });
      if (response?.accepted === false) {
        showError(response.error.message);
        return;
      }
      setSelectedWorktreeId(worktree.worktreeId);
      updateWorkbench((state) => ({ ...state, drawerOpen: true }));
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : "The action could not start.");
    }
  };

  const deferSetup = (setup: WorktreeSetupProjection) =>
    setDeferredSetups((current) => [...current, setupDeferKey(setup)]);
  const reviewSetup = (worktreeId: string) =>
    setDeferredSetups((current) => current.filter((key) => !key.startsWith(`${worktreeId}:`)));
  const showSetupOutput = (worktreeId: string) => {
    focusWorktree(worktreeId);
    updateWorkbench((state) => ({ ...state, drawerOpen: true }));
  };
  const respondToSetup = async (
    setup: WorktreeSetupProjection,
    decision: SetupDecision,
  ): Promise<string | undefined> => {
    try {
      const response = await dispatch({
        protocolVersion: 1,
        commandId: makeCommandId(),
        command: {
          type: "worktree.setup.respond",
          worktreeId: setup.worktreeId,
          commandsHash: setup.commandsHash,
          decision,
        },
      });
      return response?.accepted === false ? response.error.message : undefined;
    } catch (cause) {
      return cause instanceof Error ? cause.message : "The answer could not be sent.";
    }
  };

  const commands: PaletteCommand[] = [
    ...(hasProjects
      ? [
          {
            label: "New agent",
            icon: "plus" as const,
            group: "Create" as const,
            shortcut: shortcuts.newAgent,
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
    ...(hasProjects
      ? [{ label: "Start from issue", icon: "issue" as const, group: "Create" as const, action: () => openIssues() }]
      : []),
    { label: "Add project", icon: "folderPlus", group: "Create", action: () => void openProject() },
    ...(bridge?.scratch
      ? [
          {
            label: "New scratch chat",
            icon: "scratch" as const,
            group: "Create" as const,
            action: () => void startScratchChat(),
          },
        ]
      : []),
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
    ...(newChatTarget(activeSession)
      ? [
          {
            label: "New chat",
            icon: "squarePen" as const,
            group: "Create" as const,
            shortcut: shortcuts.newChat,
            action: () => {
              setPaletteOpen(false);
              const target = newChatTarget(activeSession);
              if (target) void startNewChat(target, false).then((failure) => failure && showError(failure));
            },
          },
          ...(canHandOff(activeSession ?? {}, projection?.messages)
            ? [
                {
                  label: "New chat with recent context",
                  icon: "message" as const,
                  group: "Create" as const,
                  action: () => {
                    setPaletteOpen(false);
                    const target = newChatTarget(activeSession);
                    if (target) void startNewChat(target, true).then((failure) => failure && showError(failure));
                  },
                },
              ]
            : []),
        ]
      : []),
    ...(handoffTarget(activeSession)
      ? [
          {
            label: "Continue with another agent",
            icon: "handoff" as const,
            group: "Create" as const,
            action: () => {
              setPaletteOpen(false);
              setHandoffRequest(activeSession);
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
            shortcut: shortcuts.quickOpen,
            action: openQuickOpen,
          },
          {
            label: "Search in files",
            icon: "search" as const,
            group: "Go to" as const,
            shortcut: shortcuts.searchFiles,
            action: searchInFiles,
          },
        ]
      : []),
    {
      label: "Saved prompts",
      icon: "bookmark",
      group: "Go to",
      action: () => setPromptManager({ projectId: contextProject?.projectId }),
    },
    {
      label: "Toggle terminal",
      icon: "terminal",
      group: "View",
      shortcut: shortcuts.toggleDrawer,
      action: toggleDrawer,
    },
    {
      label: "Focus files",
      icon: "folderTree",
      group: "View",
      shortcut: shortcuts.toggleFiles,
      action: () => setSidePane("files"),
    },
    {
      label: "Focus browser",
      icon: "globe",
      group: "View",
      shortcut: shortcuts.toggleBrowser,
      action: () => setSidePane("browser"),
    },
    ...(mobileAvailable
      ? [
          {
            label: "Focus mobile",
            icon: "smartphone",
            group: "View",
            shortcut: shortcuts.toggleMobile,
            action: () => setSidePane("mobile"),
          } satisfies PaletteCommand,
        ]
      : []),
    ...(mobilePopOutAvailable
      ? [
          {
            label: "Pop out mobile device",
            icon: "externalLink",
            group: "View",
            action: () => {
              setSidePane("mobile");
              setMobilePopOutRequest(Date.now());
            },
          } satisfies PaletteCommand,
        ]
      : []),
    {
      label: "Focus changes",
      icon: "diff",
      group: "View",
      shortcut: shortcuts.toggleChanges,
      action: () => setSidePane("review"),
    },
    {
      label: sidebarOpen ? "Hide sidebar" : "Show sidebar",
      icon: "panelLeft",
      group: "View",
      shortcut: shortcuts.toggleSidebar,
      action: toggleSidebar,
    },
    ...(bridge?.app.zoom
      ? [
          {
            label: "Zoom in",
            icon: "zoomIn" as const,
            group: "View" as const,
            shortcut: "Mod+=",
            action: () => void bridge.app.zoom?.("in"),
          },
          {
            label: "Zoom out",
            icon: "zoomOut" as const,
            group: "View" as const,
            shortcut: "Mod+-",
            action: () => void bridge.app.zoom?.("out"),
          },
          {
            label: "Actual size",
            icon: "search" as const,
            group: "View" as const,
            shortcut: "Mod+0",
            action: () => void bridge.app.zoom?.("reset"),
          },
        ]
      : []),
    { label: "Export support bundle", icon: "download", group: "App", action: () => void exportSupportBundle() },
    { label: "Import legacy snapshot", icon: "upload", group: "App", action: () => void startLegacyImport() },
    { label: "Settings", icon: "settings", group: "App", shortcut: shortcuts.settings, action: () => openSettings() },
    {
      label: "Keyboard shortcuts",
      icon: "command",
      group: "App",
      action: () => openSettings("shortcuts"),
    },
    {
      label: "Integrations: connectors, MCP servers, and plugins",
      icon: "puzzle",
      group: "App",
      action: () => openSettings("integrations"),
    },
    { label: "Usage and cost", icon: "gauge", group: "App", action: openUsage },
    { label: "Help and diagnostics", icon: "help", group: "App", action: () => setHelpOpen(true) },
    ...(updates.available
      ? [
          {
            label: "Check for updates",
            icon: "reload" as const,
            group: "App" as const,
            action: () => {
              openSettings("updates");
              void updates.check();
            },
          },
        ]
      : []),
    ...(readyUpdate
      ? [
          {
            label: `Restart to update to v${readyUpdate.version}`,
            icon: "rotate" as const,
            group: "App" as const,
            action: restartToUpdate,
          },
        ]
      : []),
    ...notificationCommands(notifications.settings, (patch) => void notifications.update(patch)),
    ...devServerCommands(contextDevServers, openDevServer),
    ...(hasProjects
      ? pluginActions.map((action) => ({
          label: `${action.name} (${action.plugin})`,
          icon: "puzzle" as const,
          group: "Plugins" as const,
          action: () => void runPluginAction(action),
        }))
      : []),
  ];
  const otherOverlayOpen =
    paletteOpen ||
    quickOpen ||
    worktreeDialogProject !== undefined ||
    newAgentProject !== undefined ||
    issuesProject !== undefined ||
    helpOpen ||
    settingsSection !== undefined ||
    usageOpen ||
    closeRequest !== undefined ||
    deleteRequest !== undefined ||
    actionRequest !== undefined ||
    handoffRequest !== undefined ||
    workbench.groups.some((group) => group.groupId === compareGroupId) ||
    keepRequest !== undefined ||
    promptManager !== undefined ||
    (restartConfirm && readyUpdate !== undefined) ||
    (legacyImportBatchId !== undefined && projection !== undefined);
  // Waits behind other dialogs so it never stacks on top of one.
  const setupApproval = otherOverlayOpen ? undefined : nextSetupApproval(projection, deferredSetups);
  setupApprovalRef.current = setupApproval;
  // What's new waits behind everything else, setup approvals included.
  const whatsNew = otherOverlayOpen || setupApproval ? undefined : updates.whatsNew;
  whatsNewRef.current = whatsNew !== undefined;
  const overlayOpen = otherOverlayOpen || setupApproval !== undefined || whatsNew !== undefined;
  const { columns, rows, tall } = gridLayout(visibleTiles.length, gridWidth);
  const handoffSession = handoffRequest
    ? sessions.find((session) => session.sessionId === handoffRequest.sessionId)
    : undefined;
  const handoffWorktree = handoffSession ? findWorktree(handoffSession.worktreeId) : undefined;
  const compareGroup = workbench.groups.find((group) => group.groupId === compareGroupId);

  return (
    <FileIndexProvider onOpenFile={openFile}>
      <div className={`app-shell${sidebarOpen ? "" : " is-sidebar-hidden"}`}>
        {sidebarOpen ? (
          <Sidebar
            projection={projection}
            sessions={sessions}
            accounts={loadedAccounts}
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
            onRemoveProject={async (projectId) => {
              const name = projection?.projects.find((project) => project.projectId === projectId)?.name ?? "project";
              const problem = await removeProject(projectId);
              if (!problem)
                setNotice({ message: `Removed ${name} from ZLI. Its folder is still on disk.`, tone: "info" });
              return problem;
            }}
            onRenameProject={(projectId, name) => void renameProject(projectId, name)}
            onWorktreeAction={(worktree, action) => void worktreeAction(worktree, action)}
            onReviewSetup={(worktree) => reviewSetup(worktree.worktreeId)}
            onShowSetupOutput={(worktree) => showSetupOutput(worktree.worktreeId)}
            onOpenHelp={() => setHelpOpen(true)}
            onOpenSettings={() => openSettings()}
            onOpenUsage={openUsage}
            onHideSidebar={hideSidebar}
            runGroups={workbench.groups}
            runStates={runStates}
            onCompareRuns={(group) => setCompareGroupId(group.groupId)}
          />
        ) : null}
        <main className="main-workspace">
          <Topbar
            sidebarOpen={sidebarOpen}
            project={contextWorktree ? contextProject : undefined}
            worktree={contextWorktree}
            hasProjects={hasProjects}
            drawerOpen={workbench.drawerOpen}
            sidePane={sidePane}
            onShowSidebar={toggleSidebar}
            onNewAgent={() => openNewAgent()}
            onOpenIssues={() => openIssues(contextProject)}
            onToggleDrawer={toggleDrawer}
            onToggleSidePane={toggleSidePane}
            onOpenPalette={() => setPaletteOpen(true)}
            devServers={contextDevServers}
            onOpenDevServer={openDevServer}
            mobileAvailable={mobileAvailable}
            updateNotice={
              <>
                <ReviewNotesPill worktree={contextWorktree} onShowAgent={showAgent} />
                <UpdatePill
                  status={updates.status}
                  onRestart={restartToUpdate}
                  onOpenRelease={() => void updates.openReleasePage()}
                  onOpenSettings={() => openSettings("updates")}
                />
              </>
            }
          />
          {notice ? (
            <div className={`banner banner-${notice.tone}`} role={notice.tone === "danger" ? "alert" : "status"}>
              <Icon name={notice.tone === "danger" ? "alert" : "check"} size={14} />
              <span className="banner-message">{notice.message}</span>
              {notice.action ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    notice.action?.run();
                    setNotice(undefined);
                  }}
                >
                  {notice.action.label}
                </Button>
              ) : null}
              <IconButton label="Dismiss message" icon="x" size="sm" onClick={() => setNotice(undefined)} />
            </div>
          ) : null}
          {bridge ? <ExpiredSignInNotice onSignInAgain={openConnectors} /> : null}
          <AttentionPanel items={projection?.attention ?? []} />
          {!bridge ? (
            <DisconnectedState />
          ) : !projection ? (
            <RuntimeLoadingState />
          ) : (
            <div className="workspace-body">
              <div className="workbench-column">
                <section className="agent-grid-region" aria-label="Agents" ref={gridRegionRef}>
                  {visibleTiles.length === 0 ? (
                    <GridEmptyState
                      projection={projection}
                      closedCount={sessions.length}
                      onOpenProject={() => void openProject()}
                      onNewAgent={() => openNewAgent()}
                      onScratchChat={bridge.scratch ? () => void startScratchChat() : undefined}
                    />
                  ) : (
                    <div
                      className="agent-grid"
                      style={{
                        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                        // Rows keep a usable height; past that the grid scrolls.
                        gridTemplateRows: `repeat(${rows}, minmax(${rows > 1 ? 260 : 0}px, 1fr))`,
                      }}
                    >
                      {visibleTiles.map((session, index) => (
                        <AgentTile
                          key={session.sessionId}
                          projection={projection}
                          session={session}
                          tall={index < tall}
                          accountLabel={accountLabel(loadedAccounts, sessionAccountId(session))}
                          worktree={findWorktree(session.worktreeId)}
                          active={session.sessionId === activeSession?.sessionId}
                          maximized={maximized?.sessionId === session.sessionId}
                          canMaximize={tiles.length > 1}
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
                          onReviewSetup={() => reviewSetup(session.worktreeId)}
                          onShowSetupOutput={() => showSetupOutput(session.worktreeId)}
                          onHandoff={handoffTarget(session) ? () => setHandoffRequest(session) : undefined}
                          onNewChat={
                            newChatTarget(session) ? (withContext) => startNewChat(session, withContext) : undefined
                          }
                          canCarryContext={canHandOff(session, projection.messages)}
                          newChatRequest={
                            newChatRequest?.sessionId === session.sessionId ? newChatRequest.nonce : undefined
                          }
                          newChatShortcut={shortcuts.newChat}
                          onOpenChat={(threadId) => void openChat(session, threadId)}
                          onOpenConnectors={openConnectors}
                          run={runPosition(workbench.groups, session.sessionId)}
                          onStartRuns={
                            runPosition(workbench.groups, session.sessionId)
                              ? undefined
                              : (request) => startRuns(session, request)
                          }
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
                          worktree={files.worktree}
                          focus={filesFocus}
                          askAgent={askAgent}
                          projects={projection?.projects}
                          onOpenProject={openFilesInProject}
                          onQuickOpen={openQuickOpen}
                          onOpenDiff={(path) => {
                            setSidePane("review");
                            setReviewFocus({ path, nonce: Date.now() });
                          }}
                        />
                      </Suspense>
                    ) : sidePane === "browser" ? (
                      <BrowserPane
                        worktree={contextWorktree}
                        obscured={overlayOpen}
                        reveal={browserReveal}
                        openRequest={browserOpen}
                        onShowAgent={showAgent}
                        projects={projection?.projects}
                        onOpenProject={openBrowserInProject}
                      />
                    ) : sidePane === "mobile" ? (
                      <MobilePane
                        reveal={mobileReveal}
                        devServers={mobileDevServers}
                        popOutRequest={mobilePopOutRequest}
                        onPopOutRequestDone={() => setMobilePopOutRequest(undefined)}
                      />
                    ) : (
                      <Suspense fallback={<LoadingState label="Loading the changes" />}>
                        <ReviewPane worktree={contextWorktree} focus={reviewFocus} onShowAgent={showAgent} />
                      </Suspense>
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
            onOpenUpdates={
              updates.available
                ? () => {
                    setHelpOpen(false);
                    openSettings("updates");
                  }
                : undefined
            }
            onClose={() => setHelpOpen(false)}
          />
        )}
        {settingsSection ? (
          <SettingsDialog
            key={settingsKey}
            projection={projection}
            initialProjectId={contextProject?.projectId}
            initialSection={settingsSection}
            integrationsView={integrationsView}
            focusConnector={focusConnector}
            notifications={{ settings: notifications.settings, update: (patch) => void notifications.update(patch) }}
            updates={updates}
            onRestartToUpdate={restartToUpdate}
            onSignIn={signInAccount}
            onAddProject={() => void openProject()}
            onRemoveProject={removeProject}
            onClose={() => setSettingsSection(undefined)}
          />
        ) : null}
        {usageOpen ? (
          <Suspense fallback={null}>
            <UsageDialog
              projection={projection}
              initialProjectId={contextProject?.projectId}
              accounts={loadedAccounts}
              onClose={() => setUsageOpen(false)}
            />
          </Suspense>
        ) : null}
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
        {actionRequest ? (
          <PluginActionDialog
            action={actionRequest.action}
            pluginName={actionRequest.pluginName}
            origin={actionRequest.origin}
            canRemember={actionRequest.key !== undefined}
            onRun={(remember) => {
              const { action, key } = actionRequest;
              setActionRequest(undefined);
              if (remember && key) rememberActionApproval(key);
              void startPluginAction(action);
            }}
            onCancel={() => setActionRequest(undefined)}
          />
        ) : null}
        {handoffSession && handoffWorktree && projection ? (
          <Suspense fallback={null}>
            <HandoffDialog
              projection={projection}
              session={handoffSession}
              worktree={handoffWorktree}
              onClose={() => setHandoffRequest(undefined)}
              onSubmit={(request) => submitHandoff(handoffSession, request)}
            />
          </Suspense>
        ) : null}

        {compareGroup && !keepRequest ? (
          <CompareRunsDialog
            group={compareGroup}
            sessions={sessions}
            onViewDiff={(session) => {
              setCompareGroupId(undefined);
              focusSession(session);
              setSidePane("review");
              setReviewFocus(undefined);
            }}
            onKeep={(session) => setKeepRequest({ group: compareGroup, session })}
            onClose={() => setCompareGroupId(undefined)}
          />
        ) : null}
        {keepRequest && projection ? (
          <KeepRunDialog
            index={keepRequest.group.sessionIds.indexOf(keepRequest.session.sessionId) + 1}
            count={keepRequest.group.sessionIds.length}
            branch={findWorktree(keepRequest.session.worktreeId)?.branch ?? "its worktree"}
            discarded={keepRunCleanup(projection, sessions, keepRequest.group, keepRequest.session.sessionId).map(
              ({ session, worktree }) => ({
                title: `Run ${keepRequest.group.sessionIds.indexOf(session.sessionId) + 1}, ${providerDisplayName(session.provider, projection.providers)}`,
                branch: worktree?.branch,
              }),
            )}
            onKeep={() => void keepRun(keepRequest.group, keepRequest.session)}
            onCancel={() => setKeepRequest(undefined)}
          />
        ) : null}
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
            prefill={issueStart?.prefill}
            onClose={() => {
              setNewAgentProject(undefined);
              setIssueStart(undefined);
            }}
            accounts={accounts}
            onSubmit={submitNewAgent}
          />
        )}
        {issuesProject && projection ? (
          <Suspense fallback={null}>
            <IssuesDialog
              projection={projection}
              initialProject={issuesProject === "default" ? (contextProject ?? projection.projects[0]) : issuesProject}
              onClose={() => setIssuesProject(undefined)}
              onConnectLinear={() => {
                setIssuesProject(undefined);
                openSettings("issues");
              }}
              onStart={(project, issue) => {
                const { source, key, reference, title, url } = issue;
                setIssuesProject(undefined);
                setIssueStart({
                  link: { source, key, reference, title, url },
                  prefill: { issue: { source, key, reference, title }, prompt: issuePrompt(issue) },
                });
                setNewAgentProject(project);
              }}
            />
          </Suspense>
        ) : null}
        {promptManager && projection ? (
          <PromptsDialog
            project={
              projection.projects.find((project) => project.projectId === promptManager.projectId) ?? contextProject
            }
            initialDraft={promptManager.draft}
            onClose={() => setPromptManager(undefined)}
          />
        ) : null}
        {setupApproval && projection ? (
          <SetupApprovalDialog
            key={setupDeferKey(setupApproval)}
            setup={setupApproval}
            project={projection.projects.find((project) => project.projectId === setupApproval.projectId)}
            worktree={findWorktree(setupApproval.worktreeId)}
            onRespond={(decision) => respondToSetup(setupApproval, decision)}
            onDefer={() => deferSetup(setupApproval)}
          />
        ) : null}
        {restartConfirm && readyUpdate ? (
          <RestartToUpdateDialog
            version={readyUpdate.version}
            busyCount={busyAgents}
            onRestart={() => {
              setRestartConfirm(false);
              void updates.install();
            }}
            onCancel={() => setRestartConfirm(false)}
          />
        ) : null}
        {whatsNew ? (
          <Suspense fallback={null}>
            <WhatsNewDialog
              whatsNew={whatsNew}
              bridge={bridge}
              onOpenRelease={() => void updates.openReleasePage()}
              onClose={updates.dismissWhatsNew}
            />
          </Suspense>
        ) : null}
        <TooltipLayer />
      </div>
    </FileIndexProvider>
  );
}

function notificationCommands(
  settings: NotificationSettings | undefined,
  update: (patch: Partial<NotificationSettings>) => void,
): PaletteCommand[] {
  if (!settings) return [];
  return [
    {
      label: settings.enabled ? "Turn off agent notifications" : "Turn on agent notifications",
      icon: "bell",
      group: "App",
      action: () => update({ enabled: !settings.enabled }),
    },
    ...(settings.enabled
      ? [
          {
            label: settings.sound ? "Mute notification sound" : "Play a sound with notifications",
            icon: "bell" as const,
            group: "App" as const,
            action: () => update({ sound: !settings.sound }),
          },
        ]
      : []),
  ];
}

/** The content width of an element, kept current as it resizes. */
function useElementWidth<T extends HTMLElement>(): [(element: T | null) => void, number | undefined] {
  const [width, setWidth] = useState<number>();
  const ref = useCallback((element: T | null) => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const NARROW_WINDOW = "(max-width: 720px)";

/** Whether the window is too narrow for the sidebar and the work side by side, which zooming in can cause. */
function useNarrowWindow(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => undefined;
      const query = window.matchMedia(NARROW_WINDOW);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(NARROW_WINDOW).matches,
  );
}
