import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { AddAgentDialog } from "./AddAgentDialog";
import { CommitDialog } from "./CommitDialog";
import { DiscardDialog } from "./DiscardDialog";
import { GitReviewPanel } from "./GitReviewPanel";
import { HelpDialog } from "./HelpDialog";
import { MergeDialog } from "./MergeDialog";
import { PathDialog } from "./PathDialog";
import { PreferencesDialog } from "./PreferencesDialog";
import { COLLAPSED_SIDEBAR_SIZE, Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { Workspace } from "./Workspace";
import { SetupWizard } from "./SetupWizard";
import { useAppShortcuts } from "../hooks/useAppShortcuts";
import { useTheme } from "../hooks/useTheme";
import { browserShellLayout, defaultShellSize, SHELL_LIMITS } from "../lib/chromePresentation";
import { agentBelongsToProject } from "../lib/workspaceRegistry";
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
import { ptyWrite } from "../tauri/terminal";
import { startPtyBridge, subscribePtyLifecycle, subscribePtyOutput } from "../terminal/ptyBridge";

const BrowserPanel = lazy(async () => {
  const mod = await import("./BrowserPanel");
  return { default: mod.BrowserPanel };
});

export function AppShell() {
  useTheme();

  const [setupOpen, setSetupOpen] = useState(true);
  const project = useProjectStore((s) => s.project);
  const error = useProjectStore((s) => s.error);
  const openFromPath = useProjectStore((s) => s.openFromPath);
  const gitPanelOpen = useLayoutStore((s) => s.gitPanelOpen);
  const loadProviders = useAgentStore((s) => s.loadProviders);
  const restoreWorkspaceAgents = useAgentStore((s) => s.restoreWorkspaceAgents);
  const refresh = useGitStore((s) => s.refresh);
  const browserOpen = useUiStore((s) => s.browserOpen);
  const sidebarCollapsed = useWorkspaceStore((s) => s.collapsed);
  const chrome = getChromeLayout();
  const browserLayout = browserShellLayout();
  const restoreAttempted = useRef(false);
  const activeProjectRoot = useRef<string | null>(null);

  useAppShortcuts();

  useEffect(() => {
    configureTaxChatRuntime({
      transport: { write: ptyWrite },
      bridge: {
        subscribePtyOutput,
        subscribePtyLifecycle,
      },
    });
    void startPtyBridge();
    return () => {
      useTaxChatStore.getState().reset();
    };
  }, []);

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
      for (const agent of Object.values(useAgentStore.getState().agents)) {
        if (agentBelongsToProject(agent, project)) useLayoutStore.getState().addLeaf(agent.terminalId);
      }
    }
    void loadProviders().then(() => {
      if (projectChanged) return restoreWorkspaceAgents(project);
      return undefined;
    });
    void refresh(project.path, { minIntervalMs: 1500 });
  }, [project, loadProviders, refresh, restoreWorkspaceAgents]);

  function dismissSetup() {
    setSetupOpen(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink text-paper">
      {!setupOpen ? <TopBar /> : null}
      {error && !project ? (
        <div className="banner banner-error mx-3 mt-2" role="alert">
          {error.message}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <div className="h-full min-w-0" hidden={setupOpen} inert={setupOpen}>
        <Group
          key={`${browserOpen ? "shell-browser" : "shell-main"}-${sidebarCollapsed ? "collapsed" : "expanded"}`}
          orientation="horizontal"
          className={`shell-group h-full min-w-0 ${browserOpen ? "shell-group-with-browser" : ""}`}
          resizeTargetMinimumSize={{ fine: 8, coarse: 20 }}
          onLayoutChanged={(layout, meta) => {
            if (!meta.isUserInteraction) return;
            const current = getChromeLayout();
            setChromeLayout({
              sidebar: layout.sidebar ?? current.sidebar,
              browser: layout.browser ?? current.browser,
              git: current.git,
            });
          }}
        >
          <Panel
            id="sidebar"
            defaultSize={sidebarCollapsed ? COLLAPSED_SIDEBAR_SIZE : defaultShellSize("sidebar", chrome.sidebar)}
            minSize={sidebarCollapsed ? COLLAPSED_SIDEBAR_SIZE : SHELL_LIMITS.sidebar.min}
            maxSize={sidebarCollapsed ? COLLAPSED_SIDEBAR_SIZE : SHELL_LIMITS.sidebar.max}
            groupResizeBehavior="preserve-pixel-size"
          >
            <Sidebar />
          </Panel>
          <Separator className="pane-handle pane-handle-h" />
          <Panel id="center" minSize="32" className="shell-center-panel min-h-0 min-w-0">
            {gitPanelOpen ? (
              <Group
                orientation="vertical"
                className="h-full"
                resizeTargetMinimumSize={{ fine: 8, coarse: 20 }}
                onLayoutChanged={(layout, meta) => {
                  if (!meta.isUserInteraction) return;
                  const current = getChromeLayout();
                  setChromeLayout({
                    ...current,
                    git: layout.git ?? current.git,
                  });
                }}
              >
                <Panel id="workspace" minSize="28%">
                  <Workspace />
                </Panel>
                <Separator className="pane-handle pane-handle-v" />
                <Panel
                  id="git"
                  defaultSize={defaultShellSize("git", chrome.git)}
                  minSize={SHELL_LIMITS.git.min}
                  maxSize={SHELL_LIMITS.git.max}
                >
                  <div className="h-full px-3 pb-3">
                    <div className="workspace-tile h-full">
                      <GitReviewPanel />
                    </div>
                  </div>
                </Panel>
              </Group>
            ) : (
              <Workspace />
            )}
          </Panel>
          {browserOpen ? (
            <>
              <Separator className="pane-handle pane-handle-h" />
              <Panel
                id="browser"
                defaultSize={defaultShellSize("browser", chrome.browser) || browserLayout.defaultSize}
                minSize={browserLayout.minSize}
                maxSize={browserLayout.maxSize}
                className="shell-browser-panel min-h-0 min-w-0"
              >
                <div className="h-full py-3 pr-3">
                  <div className="workspace-tile h-full">
                    <Suspense
                      fallback={
                        <div className="flex h-full items-center justify-center text-[12px] text-mute">
                          Loading browser…
                        </div>
                      }
                    >
                      <BrowserPanel obscured={setupOpen} />
                    </Suspense>
                  </div>
                </div>
              </Panel>
            </>
          ) : null}
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
    </div>
  );
}
