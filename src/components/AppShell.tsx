import { lazy, Suspense, useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { AddAgentDialog } from "./AddAgentDialog";
import { CommitDialog } from "./CommitDialog";
import { DiscardDialog } from "./DiscardDialog";
import { GitReviewPanel } from "./GitReviewPanel";
import { HelpDialog } from "./HelpDialog";
import { MergeDialog } from "./MergeDialog";
import { PathDialog } from "./PathDialog";
import { PreferencesDialog } from "./PreferencesDialog";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { Workspace } from "./Workspace";
import { SetupWizard } from "./SetupWizard";
import { useAppShortcuts } from "../hooks/useAppShortcuts";
import { useTheme } from "../hooks/useTheme";
import { defaultShellSize, SHELL_LIMITS } from "../lib/chromePresentation";
import {
  getChromeLayout,
  setChromeLayout,
  setSetupDismissed,
  wasSetupDismissed,
} from "../lib/preferences";
import { useAgentStore } from "../stores/agentStore";
import { useGitStore } from "../stores/gitStore";
import { useLayoutStore } from "../stores/layoutStore";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { startPtyBridge } from "../terminal/ptyBridge";

const BrowserPanel = lazy(async () => {
  const mod = await import("./BrowserPanel");
  return { default: mod.BrowserPanel };
});

export function AppShell() {
  useTheme();

  const [setupOpen, setSetupOpen] = useState(() => !wasSetupDismissed());
  const project = useProjectStore((s) => s.project);
  const error = useProjectStore((s) => s.error);
  const gitPanelOpen = useLayoutStore((s) => s.gitPanelOpen);
  const loadProviders = useAgentStore((s) => s.loadProviders);
  const refresh = useGitStore((s) => s.refresh);
  const browserOpen = useUiStore((s) => s.browserOpen);
  const chrome = getChromeLayout();

  useAppShortcuts();

  useEffect(() => {
    void startPtyBridge();
  }, []);

  useEffect(() => {
    if (!project) return;
    void loadProviders();
    void refresh(project.path, { minIntervalMs: 1500 });
  }, [project, loadProviders, refresh]);

  function dismissSetup() {
    setSetupDismissed(true);
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
        <div className="h-full" hidden={setupOpen} inert={setupOpen}>
        <Group
          key={browserOpen ? "shell-browser" : "shell-main"}
          orientation="horizontal"
          className="h-full"
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
            defaultSize={defaultShellSize("sidebar", chrome.sidebar)}
            minSize={SHELL_LIMITS.sidebar.min}
            maxSize={SHELL_LIMITS.sidebar.max}
            groupResizeBehavior="preserve-pixel-size"
          >
            <Sidebar />
          </Panel>
          <Separator className="pane-handle pane-handle-h" />
          <Panel id="center" minSize="32" className="min-h-0 min-w-0">
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
                defaultSize={defaultShellSize("browser", chrome.browser)}
                minSize={SHELL_LIMITS.browser.min}
                maxSize={SHELL_LIMITS.browser.max}
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
