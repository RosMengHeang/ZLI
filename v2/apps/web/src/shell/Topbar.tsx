import type { DevServerProjection, ProjectProjection, WorktreeProjection } from "@zli-v2/contracts";
import type { ReactNode } from "react";

import { DevServerChip } from "../devservers/DevServers.js";
import type { ShortcutId } from "../settings/appSettings.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { Kbd } from "../ui/Kbd.js";
import { ariaShortcut, shortcutText } from "../ui/shortcuts.js";
import { useShortcuts } from "./keybindings.js";

export type SidePane = "files" | "browser" | "mobile" | "review";

export const sidePaneLabel: Record<SidePane, string> = {
  files: "Files",
  browser: "Browser",
  mobile: "Mobile",
  review: "Changes",
};

const sidePaneIcon: Record<SidePane, IconName> = {
  files: "folderTree",
  browser: "globe",
  mobile: "smartphone",
  review: "diff",
};

export const sidePaneShortcut = {
  files: "toggleFiles",
  browser: "toggleBrowser",
  mobile: "toggleMobile",
  review: "toggleChanges",
} as const satisfies Record<SidePane, ShortcutId>;

export function Topbar({
  sidebarOpen,
  project,
  worktree,
  hasProjects,
  drawerOpen,
  sidePane,
  onShowSidebar,
  onNewAgent,
  onOpenIssues,
  onToggleDrawer,
  onToggleSidePane,
  onOpenPalette,
  devServers = [],
  onOpenDevServer,
  updateNotice,
  mobileAvailable = false,
}: {
  sidebarOpen: boolean;
  project: ProjectProjection | undefined;
  worktree: WorktreeProjection | undefined;
  hasProjects: boolean;
  drawerOpen: boolean;
  sidePane: SidePane | undefined;
  onShowSidebar(): void;
  onNewAgent(): void;
  /** Opens the issue list for the project in view. */
  onOpenIssues?(): void;
  onToggleDrawer(): void;
  onToggleSidePane(pane: SidePane): void;
  onOpenPalette(): void;
  /** Servers the selected worktree's terminals are running, newest first. */
  devServers?: readonly DevServerProjection[];
  onOpenDevServer?(url: string): void;
  /** The update pill, shown before the panel toggles. */
  updateNotice?: ReactNode;
  /** The Mobile panel exists only in the desktop app, which runs the emulators and simulators. */
  mobileAvailable?: boolean;
}) {
  const panes: readonly SidePane[] = mobileAvailable
    ? ["files", "browser", "mobile", "review"]
    : ["files", "browser", "review"];
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
        {worktree && onOpenDevServer ? <DevServerChip devServers={devServers} onOpen={onOpenDevServer} /> : null}
      </div>
      <span className="topbar-spacer" />
      {updateNotice}
      {sidebarOpen || !hasProjects ? null : (
        <Button variant="ghost" size="sm" icon="plus" shortcut={shortcuts.newAgent} onClick={onNewAgent}>
          New agent
        </Button>
      )}
      {hasProjects && onOpenIssues ? (
        <IconButton label="Issues" tooltip="Start from an issue" icon="issue" onClick={onOpenIssues} />
      ) : null}
      <fieldset className="topbar-tools" aria-label="Panels">
        <ToolToggle
          label="Terminal"
          icon="panelBottom"
          shortcut={shortcuts.toggleDrawer}
          active={drawerOpen}
          onClick={onToggleDrawer}
        />
        <span className="toolbar-divider" aria-hidden="true" />
        {panes.map((pane) => (
          <ToolToggle
            key={pane}
            label={sidePaneLabel[pane]}
            icon={sidePaneIcon[pane]}
            shortcut={shortcuts[sidePaneShortcut[pane]]}
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

/** Shows or hides a panel. Icon only; the label is the accessible name and the tooltip names the action. */
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
      className={`btn btn-ghost btn-icon tool-toggle${active ? " is-active" : ""}`}
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-tooltip={`${active ? "Hide" : "Show"} ${label.toLowerCase()}`}
      data-shortcut={shortcut ? shortcutText(shortcut) : undefined}
      aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
      onClick={onClick}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}
