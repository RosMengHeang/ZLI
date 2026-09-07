import { useEffect } from "react";
import { isModKey, isTypingTarget } from "../lib/platform";
import { useLayoutStore } from "../stores/layoutStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useUiStore } from "../stores/uiStore";

export function useAppShortcuts(): void {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.isComposing || event.repeat) return;
      if (event.key === "Escape") {
        const ui = useUiStore.getState();
        if (ui.helpOpen) {
          ui.setHelpOpen(false);
          event.preventDefault();
          return;
        }
        if (ui.addAgentOpen) {
          ui.setAddAgentOpen(false);
          event.preventDefault();
          return;
        }
        if (ui.pathDialogOpen) {
          ui.setPathDialogOpen(false);
          event.preventDefault();
          return;
        }
        if (ui.commitOpen) {
          ui.setCommitOpen(false);
          event.preventDefault();
          return;
        }
        if (ui.discardOpen) {
          ui.setDiscardOpen(false);
          event.preventDefault();
          return;
        }
        if (ui.mergeOpen) {
          ui.setMergeOpen(false);
          event.preventDefault();
          return;
        }
        return;
      }

      if (!isModKey(event) || !event.shiftKey) return;
      const key = event.key.toLowerCase();
      const code = event.code;
      const typing = isTypingTarget(event.target);

      if (key === "o" && !typing) {
        event.preventDefault();
        void openProject();
        return;
      }
      if ((key === "`" || code === "Backquote") && !typing) {
        event.preventDefault();
        void addTerminal();
        return;
      }
      if (key === "a") {
        event.preventDefault();
        const project = useProjectStore.getState().project;
        if (project) useUiStore.getState().setAddAgentOpen(true);
        return;
      }
      if (key === "g") {
        event.preventDefault();
        if (useProjectStore.getState().project) useLayoutStore.getState().toggleGitPanel();
        return;
      }
      if (key === "b") {
        event.preventDefault();
        const ui = useUiStore.getState();
        ui.setBrowserOpen(!ui.browserOpen);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

async function openProject(): Promise<void> {
  const result = await useProjectStore.getState().openFromDialog();
  if (result === "failed") useUiStore.getState().setPathDialogOpen(true);
}

async function addTerminal(): Promise<void> {
  const project = useProjectStore.getState().project;
  if (!project) return;
  const session = await useTerminalStore.getState().createSession({
    cwd: project.path,
    cols: 80,
    rows: 24,
    title: "Terminal",
  });
  useLayoutStore.getState().addLeaf(session.id);
}
