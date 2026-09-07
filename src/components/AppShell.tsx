import { useEffect } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { AddAgentDialog } from "./AddAgentDialog";
import { CommitDialog } from "./CommitDialog";
import { DiscardDialog } from "./DiscardDialog";
import { GitReviewPanel } from "./GitReviewPanel";
import { MergeDialog } from "./MergeDialog";
import { PathDialog } from "./PathDialog";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { Workspace } from "./Workspace";
import { useAgentStore } from "../stores/agentStore";
import { useGitStore } from "../stores/gitStore";
import { useLayoutStore } from "../stores/layoutStore";
import { useProjectStore } from "../stores/projectStore";
import { startPtyBridge } from "../terminal/ptyBridge";

export function AppShell() {
  const project = useProjectStore((s) => s.project);
  const error = useProjectStore((s) => s.error);
  const gitPanelOpen = useLayoutStore((s) => s.gitPanelOpen);
  const loadProviders = useAgentStore((s) => s.loadProviders);
  const refresh = useGitStore((s) => s.refresh);

  useEffect(() => {
    void startPtyBridge();
  }, []);

  useEffect(() => {
    if (!project) return;
    void loadProviders();
    void refresh(project.path);
  }, [project, loadProviders, refresh]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#1e1e1e] text-[#cccccc]">
      <TopBar />
      {error && !project ? (
        <div className="border-b border-[#5a1d1d] bg-[#3a1515] px-2 py-1 text-[11px] text-[#f14c4c]">
          {error.message}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <Group orientation="horizontal" className="h-full">
          <Panel defaultSize="18" minSize="12" maxSize="32">
            <Sidebar />
          </Panel>
          <Separator className="pane-handle pane-handle-h" />
          <Panel minSize="40">
            {gitPanelOpen ? (
              <Group orientation="vertical" className="h-full">
                <Panel defaultSize="68" minSize="30">
                  <Workspace />
                </Panel>
                <Separator className="pane-handle pane-handle-v" />
                <Panel defaultSize="32" minSize="18">
                  <GitReviewPanel />
                </Panel>
              </Group>
            ) : (
              <Workspace />
            )}
          </Panel>
        </Group>
      </div>
      <footer className="flex h-5 shrink-0 items-center gap-3 border-t border-[#3e3e42] bg-[#007acc] px-2 text-[11px] text-white">
        <span>{project ? project.currentBranch : "no repo"}</span>
        <span className="opacity-80">{project ? project.path : "Open a Git repository to begin"}</span>
      </footer>
      <AddAgentDialog />
      <PathDialog />
      <CommitDialog />
      <DiscardDialog />
      <MergeDialog />
    </div>
  );
}
