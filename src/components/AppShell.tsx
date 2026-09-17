import { Fragment, lazy, Suspense, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Group, Panel, Separator } from "react-resizable-panels";
import { AddAgentDialog } from "./AddAgentDialog";
import { CommitDialog } from "./CommitDialog";
import { DiscardDialog } from "./DiscardDialog";
import { GitReviewPanel } from "./GitReviewPanel";
import { HelpDialog } from "./HelpDialog";
import { MergeDialog } from "./MergeDialog";
import { PathDialog } from "./PathDialog";
import { PreferencesDialog } from "./PreferencesDialog";
import { WorktreeDialog } from "./WorktreeDialog";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { IconSidebar } from "./AppIcons";
import { Workspace } from "./Workspace";
import { TaxChatPanel } from "./TaxChatPanel";
import { SetupWizard } from "./SetupWizard";
import { useAppShortcuts } from "../hooks/useAppShortcuts";
import { useTheme } from "../hooks/useTheme";
import {
  appFrameVisibility,
  defaultShellSize,
  SHELL_LIMITS,
  sidebarCollapsedForWidth,
  utilityShellLayout,
  visibleUtilityPanes,
  type UtilityPaneId,
} from "../lib/chromePresentation";
import {
  getChromeLayout,
  setChromeLayout,
} from "../lib/preferences";
import { useAgentStore } from "../stores/agentStore";
import { useGitStore } from "../stores/gitStore";
import { useLayoutStore } from "../stores/layoutStore";
import { useProjectStore } from "../stores/projectStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { configureTaxChatRuntime, useTaxChatStore } from "../stores/taxChatStore";
import { useUiStore } from "../stores/uiStore";
import { controlClient } from "../control/client";
import { startPtyBridge, stopPtyBridge, subscribePtyLifecycle, subscribePtyOutput } from "../terminal/ptyBridge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { CommandPalette } from "./CommandPalette";
import { useAttentionStore } from "../stores/attentionStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTeamStore } from "../stores/teamStore";
import { useBrowserStore } from "../stores/browserStore";
import { controlEventsAfter, subscribeControlEvents } from "../tauri/control";
import { isAgentEventEnvelope, type AgentEventPayload } from "../lib/agentEvents";
import { rejectBrowserOpen } from "../lib/browser/browserBridge";
import { resolveBrowserOpenRequest } from "../lib/browser/openRequest";
import type { Agent } from "../types";

const BrowserPanel = lazy(async () => {
  const mod = await import("./BrowserPanel");
  return { default: mod.BrowserPanel };
});

function UtilityPaneContent({ id, obscured }: { id: UtilityPaneId; obscured: boolean }) {
  if (id === "browser") {
    return (
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-[12px] text-mute">
            Loading browser…
          </div>
        }
      >
        <BrowserPanel obscured={obscured} />
      </Suspense>
    );
  }
  if (id === "taxchat") return <TaxChatPanel />;
  return <GitReviewPanel />;
}

export function AppShell() {
  useTheme();

  const [setupOpen, setSetupOpen] = useState(true);
  const project = useProjectStore((s) => s.project);
  const error = useProjectStore((s) => s.error);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ requestId: string; projectId: string; agentId: string | null; url: string }>("browser-open-request", ({ payload }) => {
      const active = useProjectStore.getState().project;
      const decision = resolveBrowserOpenRequest(payload, active);
      if (decision.kind === "inactive") {
        void rejectBrowserOpen(decision.requestId).catch(() => undefined);
        return;
      }
      useBrowserStore.getState().setPendingOpen({
        requestId: decision.requestId,
        agentId: decision.agentId,
        url: decision.url,
      });
      useUiStore.getState().setBrowserUrl(decision.url);
      useUiStore.getState().setBrowserOpen(true);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  const openFromPath = useProjectStore((s) => s.openFromPath);
  const gitPanelOpen = useLayoutStore((s) => s.gitPanelOpen);
  const loadProviders = useAgentStore((s) => s.loadProviders);
  const initializeSessions = useSessionStore((s) => s.initialize);
  const checkpointSessions = useSessionStore((s) => s.checkpoint);
  const refresh = useGitStore((s) => s.refresh);
  const browserOpen = useUiStore((s) => s.browserOpen);
  const taxChatOpen = useUiStore((s) => s.taxChatOpen);
  const sidebarCollapsed = useWorkspaceStore((s) => s.collapsed);
  const setSidebarCollapsed = useWorkspaceStore((s) => s.setCollapsed);
  const frameVisibility = appFrameVisibility(sidebarCollapsed);
  const chrome = getChromeLayout();
  const utilityPanes = visibleUtilityPanes({
    browserOpen,
    taxChatOpen,
    changesOpen: gitPanelOpen,
  });
  const utilityLayout = utilityShellLayout(utilityPanes);
  const storedUtilitySize =
    utilityPanes.length === 1 && utilityPanes[0] === "changes" ? chrome.git : chrome.browser;
  const utilityDefaultSize =
    storedUtilitySize === undefined ? utilityLayout.defaultSize : `${storedUtilitySize}%`;
  const restoreAttempted = useRef(false);
  const activeProjectRoot = useRef<string | null>(null);

  useAppShortcuts();

  useEffect(() => {
    const collapseForViewport = () => {
      if (sidebarCollapsedForWidth(window.innerWidth, useWorkspaceStore.getState().collapsed)) {
        setSidebarCollapsed(true);
      }
    };
    collapseForViewport();
    window.addEventListener("resize", collapseForViewport);
    return () => window.removeEventListener("resize", collapseForViewport);
  }, [setSidebarCollapsed]);

  useEffect(() => {
    let release: (() => void) | undefined;
    let disposed = false;
    void useAttentionStore.getState().connect().then((disconnect) => {
      if (disposed) disconnect();
      else release = disconnect;
    });
    return () => {
      disposed = true;
      release?.();
    };
  }, []);

  useEffect(() => {
    let release: (() => void) | undefined;
    let disposed = false;
    const applyTeamEvent = (candidate: unknown) => {
      if (!isAgentEventEnvelope(candidate)) return;
      useTeamStore.getState().apply(candidate);
      useBrowserStore.getState().applyEvent(candidate);
      const active = useProjectStore.getState().project;
      if (active && (candidate.projectId === active.path || candidate.projectId === active.repositoryRoot)) {
        useTaxChatStore.getState().applyEvent(candidate);
      }
      const payload = candidate.payload as AgentEventPayload;
      if (candidate.kind === "agent_started" && candidate.agentId && payload.type === "agent") {
        const agent: Agent = {
          id: candidate.agentId,
          name: payload.name,
          provider: payload.providerId as Agent["provider"],
          terminalId: payload.terminalId,
          cwd: payload.worktreePath,
          branch: payload.branch,
          worktreePath: payload.worktreePath,
          status: "running",
          error: null,
        };
        useAgentStore.getState().trackExternal(agent, candidate.projectId);
      }
      if (candidate.kind === "agent_focus_requested" && candidate.agentId) {
        useAgentStore.getState().selectAgent(candidate.agentId);
      }
    };
    void subscribeControlEvents(applyTeamEvent).then(async (disconnect) => {
      if (disposed) {
        disconnect();
        return;
      }
      release = disconnect;
      const replay = await controlEventsAfter(useTeamStore.getState().lastSequence);
      replay.forEach(applyTeamEvent);
    });
    return () => {
      disposed = true;
      release?.();
    };
  }, []);

  useEffect(() => {
    configureTaxChatRuntime({
      transport: {
        send: async (input) => controlClient.request("taxchat.send", {
          projectId: input.projectId,
          body: input.body,
          recipientIds: input.recipientIds,
          ...(input.senderAgentId ? { senderAgentId: input.senderAgentId } : {}),
        }),
      },
      bridge: {
        subscribePtyOutput,
        subscribePtyLifecycle,
      },
    });
    void startPtyBridge();
    return () => {
      void stopPtyBridge();
      useTaxChatStore.getState().reset();
    };
  }, []);

  useEffect(() => {
    configureTaxChatRuntime({ projectId: project?.path ?? null });
  }, [project?.path]);

  useEffect(() => {
    if (restoreAttempted.current) return;
    restoreAttempted.current = true;
    const savedRoot = useWorkspaceStore.getState().activeProjectRoot;
    const saved = savedRoot ? useWorkspaceStore.getState().getWorkspace(savedRoot) : undefined;
    if (!saved) return;
    void openFromPath(saved.project.path).then((opened) => {
      if (opened) setSetupOpen(false);
    });
  }, [openFromPath]);

  useEffect(() => {
    if (!project) return;
    const projectChanged = activeProjectRoot.current !== project.repositoryRoot;
    activeProjectRoot.current = project.repositoryRoot;
    if (projectChanged) {
      useLayoutStore.getState().resetProject();
      useTaxChatStore.getState().reset();
    }
    void loadProviders();
    if (projectChanged) void initializeSessions(project.path);
    void refresh(project.path, { minIntervalMs: 1500 });
  }, [project, loadProviders, refresh, initializeSessions]);

  useEffect(() => {
    if (!project) return;
    const projectId = project.path;
    const checkpoint = () => { void checkpointSessions(projectId); };
    const timer = window.setInterval(checkpoint, 5_000);
    window.addEventListener("beforeunload", checkpoint);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("beforeunload", checkpoint);
      checkpoint();
    };
  }, [project, checkpointSessions]);

  function dismissSetup() {
    setSetupOpen(false);
  }

  return (
    <TooltipProvider>
    <div className="app-shell flex h-full min-h-0 flex-col bg-ink text-paper">
      <div className="relative min-h-0 flex-1">
        <div className="h-full min-w-0" hidden={setupOpen} inert={setupOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="app-sidebar-toggle"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-pressed={!sidebarCollapsed}
            >
              <IconSidebar className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}</TooltipContent>
        </Tooltip>
        <Group
          key={`app-frame-${sidebarCollapsed ? "collapsed" : "expanded"}`}
          orientation="horizontal"
          className="app-frame h-full min-w-0"
          resizeTargetMinimumSize={{ fine: 8, coarse: 20 }}
          onLayoutChanged={(layout, meta) => {
            if (!meta.isUserInteraction) return;
            const current = getChromeLayout();
            setChromeLayout({
              sidebar: layout.sidebar ?? current.sidebar,
              browser: current.browser,
              git: current.git,
            });
          }}
        >
          {frameVisibility.sidebar ? (
            <>
              <Panel
                id="sidebar"
                defaultSize={defaultShellSize("sidebar", chrome.sidebar)}
                minSize={SHELL_LIMITS.sidebar.min}
                maxSize={SHELL_LIMITS.sidebar.max}
                groupResizeBehavior="preserve-pixel-size"
              >
                <Sidebar />
              </Panel>
              {frameVisibility.separator ? <Separator className="pane-handle pane-handle-h" /> : null}
            </>
          ) : null}
          <Panel id="app-content" minSize="32" className={`app-frame-content min-h-0 min-w-0${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}>
            <TopBar />
            {error && !project ? <div className="banner banner-error mx-3 mt-2" role="alert">{error.message}</div> : null}
            <div className="min-h-0 flex-1">
              <Group
                key={`workspace-utilities-${utilityPanes.join("-") || "none"}`}
                orientation="horizontal"
                className="shell-group h-full min-w-0"
                resizeTargetMinimumSize={{ fine: 8, coarse: 20 }}
                onLayoutChanged={(layout, meta) => {
                  if (!meta.isUserInteraction || utilityPanes.length === 0) return;
                  const current = getChromeLayout();
                  const utilitySize = layout.utility;
                  if (utilitySize === undefined) return;
                  setChromeLayout(
                    utilityPanes.length === 1 && utilityPanes[0] === "changes"
                      ? { ...current, git: utilitySize }
                      : { ...current, browser: utilitySize },
                  );
                }}
              >
                <Panel id="center" minSize="360px" className="shell-center-panel min-h-0 min-w-0">
                  <Workspace />
                </Panel>
                {utilityPanes.length > 0 ? (
                  <>
                    <Separator className="pane-handle pane-handle-h" />
                    <Panel
                      id="utility"
                      defaultSize={utilityDefaultSize}
                      minSize={utilityLayout.minSize}
                      maxSize={utilityLayout.maxSize}
                      className="shell-utility-panel min-h-0 min-w-0"
                    >
                      <Group
                        key={`utility-stack-${utilityPanes.join("-")}`}
                        orientation="vertical"
                        className="h-full min-h-0"
                        resizeTargetMinimumSize={{ fine: 8, coarse: 20 }}
                      >
                        {utilityPanes.map((paneId, index) => (
                          <Fragment key={paneId}>
                            {index > 0 ? <Separator className="pane-handle pane-handle-v" /> : null}
                            <Panel
                              id={`utility-${paneId}`}
                              defaultSize={`${100 / utilityPanes.length}%`}
                              minSize="140px"
                              className="min-h-0 min-w-0"
                            >
                              <div className="workspace-tile h-full min-h-0 min-w-0 overflow-hidden">
                                <UtilityPaneContent id={paneId} obscured={setupOpen} />
                              </div>
                            </Panel>
                          </Fragment>
                        ))}
                      </Group>
                    </Panel>
                  </>
                ) : null}
              </Group>
            </div>
          </Panel>
        </Group>
        </div>
        {setupOpen ? <SetupWizard onComplete={dismissSetup} /> : null}
      </div>
      <AddAgentDialog />
      <PathDialog />
      <CommitDialog />
      <DiscardDialog />
      <MergeDialog />
      <HelpDialog />
      <PreferencesDialog />
      <WorktreeDialog />
      <CommandPalette />
    </div>
    </TooltipProvider>
  );
}
