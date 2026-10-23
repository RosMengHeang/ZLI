import type { DevServerProjection, ProjectProjection, WorktreeProjection } from "@zli-v2/contracts";

import { DevServerChip } from "../devservers/DevServers.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { Kbd } from "../ui/Kbd.js";
import { ariaShortcut, shortcutText } from "../ui/shortcuts.js";
import { useShortcuts } from "./keybindings.js";

export type SidePane = "files" | "browser" | "review";

export const sidePaneLabel: Record<SidePane, string> = { files: "Files", browser: "Browser", review: "Changes" };

const sidePaneIcon: Record<SidePane, IconName> = { files: "folderTree", browser: "globe", review: "diff" };

export function Topbar({
  sidebarOpen,
  project,
  worktree,
  hasProjects,
  agentCount,
  drawerOpen,
  sidePane,
  onShowSidebar,
  onNewAgent,
  onToggleDrawer,
  onToggleSidePane,
  onOpenPalette,
  devServers = [],
  onOpenDevServer,
}: {
  sidebarOpen: boolean;
  project: ProjectProjection | undefined;
  worktree: WorktreeProjection | undefined;
  hasProjects: boolean;
  agentCount: number;
  drawerOpen: boolean;
  sidePane: SidePane | undefined;
  onShowSidebar(): void;
  onNewAgent(): void;
  onToggleDrawer(): void;
  onToggleSidePane(pane: SidePane): void;
  onOpenPalette(): void;
  /** Servers the selected worktree's terminals are running, newest first. */
  devServers?: readonly DevServerProjection[];
  onOpenDevServer?(url: string): void;
}) {
  const shortcuts = useShortcuts();
  return (
    <header className="topbar">
      {sidebarOpen ? null : (
        <IconButton label="Show sidebar" icon="panelLeft" shortcut={shortcuts.toggleSidebar} onClick={onShowSidebar} />
      )}
      <div className="topbar-context">
        {worktree ? (
          <>
            {project ? <span className="topbar-project">{project.name}</span> : null}
            {project ? (
              <span className="topbar-separator" aria-hidden="true">
                /
              </span>
            ) : null}
            <span className="topbar-branch" title={worktree.path}>
              <Icon name="branch" size={12} />
              <span>{worktree.branch}</span>
            </span>
          </>
        ) : (
          <span className="topbar-project is-empty">{hasProjects ? "No worktree selected" : "No project open"}</span>
        )}
        {agentCount > 0 ? (
          <span className="topbar-count">
            {agentCount} {agentCount === 1 ? "agent" : "agents"}
          </span>
        ) : null}
        {worktree && onOpenDevServer ? <DevServerChip devServers={devServers} onOpen={onOpenDevServer} /> : null}
      </div>
      <span className="topbar-spacer" />
      {sidebarOpen || !hasProjects ? null : (
        <Button variant="ghost" size="sm" icon="plus" shortcut={shortcuts.newAgent} onClick={onNewAgent}>
          New agent
        </Button>
      )}
      <fieldset className="topbar-tools" aria-label="Panels">
        <ToolToggle
          label="Terminal"
          icon="panelBottom"
          shortcut={shortcuts.toggleDrawer}
          active={drawerOpen}
          onClick={onToggleDrawer}
        />
        <span className="toolbar-divider" aria-hidden="true" />
        {(["files", "browser", "review"] as const).map((pane) => (
          <ToolToggle
            key={pane}
            label={sidePaneLabel[pane]}
            icon={sidePaneIcon[pane]}
            active={sidePane === pane}
            onClick={() => onToggleSidePane(pane)}
          />
        ))}
      </fieldset>
      <button
        className="command-trigger"
        type="button"
        onClick={onOpenPalette}
        aria-label="Open command palette"
        aria-keyshortcuts={ariaShortcut(shortcuts.palette)}
      >
        <Icon name="search" size={13} />
        <span className="command-trigger-label">Search</span>
        <Kbd shortcut={shortcuts.palette} />
      </button>
    </header>
  );
}

/** Shows or hides a panel. The label stays the accessible name when narrow windows hide it. */
function ToolToggle({
  label,
  icon,
  shortcut,
  active,
  onClick,
}: {
  label: string;
  icon: IconName;
  shortcut?: string;
  active: boolean;
  onClick(): void;
}) {
  return (
    <button
      className={`btn btn-ghost btn-sm tool-toggle${active ? " is-active" : ""}`}
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-tooltip={`${active ? "Hide" : "Show"} ${label.toLowerCase()}`}
      data-shortcut={shortcut ? shortcutText(shortcut) : undefined}
      aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
      onClick={onClick}
    >
      <Icon name={icon} size={14} />
      <span className="tool-toggle-label">{label}</span>
    </button>
  );
}
