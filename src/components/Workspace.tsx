import { IconGlobe, IconPlus, TaxzyMark } from "./AppIcons";
import { PaneTreeView } from "./PaneTreeView";
import { ProviderIcon } from "./ProviderIcon";
import { APP_SHORTCUTS } from "../lib/platform";
import { newId } from "../lib/ids";
import { isTauriRuntime } from "../tauri/invoke";
import { useLayoutStore } from "../stores/layoutStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useUiStore } from "../stores/uiStore";
import { PROVIDER_CATALOG } from "../types";
import { Button } from "./ui/button";
import { visiblePaneTree } from "../stores/paneTree";
import { useSessionStore } from "../stores/sessionStore";

function seedPreviewPanes(count = 3) {
  const addLeaf = useLayoutStore.getState().addLeaf;
  const registerSession = useTerminalStore.getState().registerSession;
  for (let index = 0; index < count; index += 1) {
    const id = newId();
    registerSession({
      id,
      cwd: "",
      status: "error",
      title: `Pane ${index + 1}`,
      error: "Preview pane. Launch terminals from the Taxzy desktop app.",
    });
    addLeaf(id);
  }
}

export function Workspace() {
  const project = useProjectStore((s) => s.project);
  const paneTree = useLayoutStore((s) => s.paneTree);
  const focusedPaneId = useLayoutStore((s) => s.focusedPaneId);
  const setAddAgentOpen = useUiStore((s) => s.setAddAgentOpen);
  const setBrowserOpen = useUiStore((s) => s.setBrowserOpen);
  const restoreError = useSessionStore((s) => s.error);
  const preview = !isTauriRuntime();
  const visibleTree = visiblePaneTree(paneTree, focusedPaneId);

  if (!project && !paneTree) {
    return (
      <div className="empty-panel">
        <div className="max-w-md px-6 text-center">
          <TaxzyMark className="mx-auto h-10 w-10" />
          <div className="mt-4 text-xl font-semibold tracking-tight text-paper">Open a repository</div>
          <p className="mt-2 text-[13px] leading-6 text-mute">
            Choose a Git project to launch terminals and coding agents. Worktrees, diffs, and review stay
            scoped to that folder.
          </p>
          <div className="mt-5 flex justify-center gap-1.5" aria-label="Supported providers">
            {PROVIDER_CATALOG.map((item) => (
              <ProviderIcon key={item.id} provider={item.id} size="md" />
            ))}
          </div>
          {preview ? (
            <Button type="button" variant="secondary" size="sm" className="mt-5" onClick={() => seedPreviewPanes(3)}>
              Preview 3-pane layout
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-ink">
      {restoreError ? <div className="shrink-0 border-b border-line bg-panel px-3 py-2 text-[11px] text-danger">{restoreError}</div> : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {!visibleTree ? (
          <div className="empty-panel rounded-[var(--tile-radius)]">
            <div className="max-w-md px-6 text-center">
              <TaxzyMark className="mx-auto h-10 w-10" />
              <div className="mt-4 text-xl font-semibold tracking-tight text-paper">Your workspace is ready</div>
              <p className="mt-2 text-[13px] leading-6 text-mute">
                Launch an agent to give it a pane, or open a terminal and work beside the team.
              </p>
              <div className="mt-5 flex justify-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setAddAgentOpen(true)}
                  title={`Add agent (${APP_SHORTCUTS.addAgent})`}
                >
                  <IconPlus />
                  Add agent
                </Button>
                <Button type="button" variant="secondary" size="sm" onClick={() => setBrowserOpen(true)}>
                  <IconGlobe />
                  Open browser
                </Button>
                {preview ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => seedPreviewPanes(3)}>
                    Preview layout
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="h-full min-h-0 min-w-0 overflow-hidden">
            <PaneTreeView node={visibleTree} allowCompression />
          </div>
        )}
      </div>
    </div>
  );
}
