import { Group, Panel, Separator } from "react-resizable-panels";
import { IconGlobe, IconPlus, TaxzyMark } from "./AppIcons";
import { PaneTreeView } from "./PaneTreeView";
import { ProviderIcon } from "./ProviderIcon";
import { TaxChatPanel } from "./TaxChatPanel";
import { APP_SHORTCUTS } from "../lib/platform";
import { newId } from "../lib/ids";
import { isTauriRuntime } from "../tauri/invoke";
import { useLayoutStore } from "../stores/layoutStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useUiStore } from "../stores/uiStore";
import { PROVIDER_CATALOG } from "../types";
import { taxChatShellLayout } from "../lib/chromePresentation";

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
  const setAddAgentOpen = useUiStore((s) => s.setAddAgentOpen);
  const setBrowserOpen = useUiStore((s) => s.setBrowserOpen);
  const browserOpen = useUiStore((s) => s.browserOpen);
  const taxChatOpen = useUiStore((s) => s.taxChatOpen);
  const preview = !isTauriRuntime();
  const taxChatLayout = taxChatShellLayout();

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
            <button type="button" className="btn btn-quiet mt-5 h-8 px-3.5" onClick={() => seedPreviewPanes(3)}>
              Preview 3-pane layout
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-ink">
      <div className="min-h-0 flex-1 overflow-hidden p-3">
        {!paneTree ? (
          <div className="empty-panel rounded-[var(--tile-radius)]">
            <div className="max-w-md px-6 text-center">
              <TaxzyMark className="mx-auto h-10 w-10" />
              <div className="mt-4 text-xl font-semibold tracking-tight text-paper">Your workspace is ready</div>
              <p className="mt-2 text-[13px] leading-6 text-mute">
                Launch an agent to give it a pane, or open a terminal and work beside the team.
              </p>
              <div className="mt-5 flex justify-center gap-2">
                <button
                  type="button"
                  className="btn btn-primary h-8 px-3.5"
                  onClick={() => setAddAgentOpen(true)}
                  title={`Add agent (${APP_SHORTCUTS.addAgent})`}
                >
                  <IconPlus />
                  Add agent
                </button>
                <button type="button" className="btn btn-quiet h-8 px-3.5" onClick={() => setBrowserOpen(true)}>
                  <IconGlobe />
                  Open browser
                </button>
                {preview ? (
                  <button type="button" className="btn btn-ghost h-8 px-3.5" onClick={() => seedPreviewPanes(3)}>
                    Preview layout
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : taxChatOpen ? (
          <Group orientation="horizontal" className="h-full min-h-0 min-w-0 w-full">
            <Panel
              id="taxchat-terminals"
              defaultSize="62%"
              minSize={taxChatLayout.terminalMinSize}
              className="min-h-0 min-w-0"
            >
              <div className="h-full min-h-0 min-w-0 overflow-hidden">
                <PaneTreeView node={paneTree} allowCompression />
              </div>
            </Panel>
            <Separator className="pane-handle pane-handle-h" />
            <Panel
              id="taxchat"
              defaultSize={taxChatLayout.defaultSize}
              minSize={taxChatLayout.minSize}
              maxSize={taxChatLayout.maxSize}
              className="min-h-0 min-w-0"
            >
              <div className="workspace-tile h-full min-h-0 min-w-0">
                <TaxChatPanel />
              </div>
            </Panel>
          </Group>
        ) : (
          <div className="h-full min-h-0 min-w-0 overflow-hidden">
            <PaneTreeView node={paneTree} allowCompression={browserOpen} />
          </div>
        )}
      </div>
    </div>
  );
}
