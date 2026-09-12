import { useMemo, useState, type ReactNode } from "react";
import { IconAgents, IconFolder, IconGit, IconGlobe, IconTerminal } from "./AppIcons";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { filterCommandItems } from "../lib/commandPalette";
import { APP_SHORTCUTS } from "../lib/platform";
import { useAgentStore } from "../stores/agentStore";
import { useLayoutStore } from "../stores/layoutStore";
import { useProjectStore } from "../stores/projectStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useUiStore } from "../stores/uiStore";

interface CommandItem {
  id: string;
  label: string;
  keywords: string[];
  icon: ReactNode;
  run: () => void | Promise<void>;
}

export function CommandPalette() {
  const open = useUiStore((state) => state.commandPaletteOpen);
  const setOpen = useUiStore((state) => state.setCommandPaletteOpen);
  const project = useProjectStore((state) => state.project);
  const agentMap = useAgentStore((state) => state.agents);
  const agents = useMemo(() => Object.values(agentMap), [agentMap]);
  const [query, setQuery] = useState("");

  const items = useMemo<CommandItem[]>(() => {
    const commands: CommandItem[] = [
      {
        id: "open-project",
        label: "Open project",
        keywords: ["folder", "repository", "workspace"],
        icon: <IconFolder />,
        run: async () => {
          const result = await useProjectStore.getState().openFromDialog();
          if (result === "failed") useUiStore.getState().setPathDialogOpen(true);
        },
      },
    ];
    if (!project) return commands;
    commands.push(
      {
        id: "browser",
        label: "Open browser",
        keywords: ["preview", "web"],
        icon: <IconGlobe />,
        run: () => useUiStore.getState().setBrowserOpen(true),
      },
      {
        id: "add-agent",
        label: "Add agent",
        keywords: ["claude", "codex", "cursor"],
        icon: <IconAgents />,
        run: () => useUiStore.getState().setAddAgentOpen(true),
      },
      {
        id: "changes",
        label: "Review changes",
        keywords: ["git", "diff", "commit"],
        icon: <IconGit />,
        run: () => useLayoutStore.getState().toggleGitPanel(true),
      },
      {
        id: "terminal",
        label: "New terminal",
        keywords: ["shell", "console"],
        icon: <IconTerminal />,
        run: async () => {
          const session = await useTerminalStore.getState().createSession({ cwd: project.path, cols: 80, rows: 24, title: "Terminal" });
          useLayoutStore.getState().addLeaf(session.id);
        },
      },
    );
    for (const agent of agents) {
      commands.push({
        id: `focus-${agent.id}`,
        label: `Focus ${agent.name}`,
        keywords: [agent.provider, agent.branch],
        icon: <IconTerminal />,
        run: () => {
          const layout = useLayoutStore.getState();
          layout.focusTerminal(agent.terminalId);
          const pane = layout.leaves().find((leaf) => leaf.terminalId === agent.terminalId);
          if (pane && layout.focusedPaneId !== pane.id) layout.toggleFocusPane(pane.id);
        },
      });
    }
    return commands;
  }, [agents, project]);

  const visible = filterCommandItems(items, query);

  async function run(item: CommandItem) {
    setOpen(false);
    setQuery("");
    await item.run();
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (!nextOpen) setQuery(""); }}>
      <DialogContent showCloseButton={false} className="command-palette top-[18%] max-w-xl translate-y-0 gap-0 overflow-hidden border-line bg-panel p-0 shadow-xl">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">Search ZLI or run a command.</DialogDescription>
        <div className="border-b border-line px-3 py-2.5">
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search ZLI or run a command…"
            aria-label="Search ZLI or run a command"
            className="h-9 border-0 bg-transparent px-1 text-[13px] shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5" role="listbox" aria-label="Commands">
          {visible.length ? visible.map((item) => (
            <button key={item.id} type="button" className="command-palette-item" onClick={() => void run(item)} role="option">
              {item.icon}
              <span>{item.label}</span>
            </button>
          )) : <div className="px-3 py-8 text-center text-[12px] text-mute">No matching commands</div>}
        </div>
        <div className="flex justify-end border-t border-line px-3 py-2 text-[11px] text-mute">{APP_SHORTCUTS.commandPalette}</div>
      </DialogContent>
    </Dialog>
  );
}
