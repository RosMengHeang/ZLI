import type { DevServerProjection, ProjectProjection, WorktreeProjection } from "@zli-v2/contracts";
import type { ReactNode } from "react";

import { DevServerChip } from "../devservers/DevServers.js";
import type { ShortcutId } from "../settings/appSettings.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { Kbd } from "../ui/Kbd.js";
import { MenuButton, type MenuItem } from "../ui/Menu.js";
import { ariaShortcut, shortcutText } from "../ui/shortcuts.js";
import { useShortcuts } from "./keybindings.js";

/** The side panels. A pull request opens from its agent, so it has no button in the top bar. */
export type SidePane = "files" | "browser" | "mobile" | "review" | "huddle" | "pullRequest";
type ToolbarPane = Exclude<SidePane, "pullRequest">;

export const sidePaneLabel: Record<SidePane, string> = {
  files: "Files",
  browser: "Browser",
  mobile: "Mobile",
  review: "Changes",
  huddle: "Huddle",
  pullRequest: "Pull request",
};

const sidePaneIcon: Record<ToolbarPane, IconName> = {
  files: "folderTree",
  browser: "globe",
  mobile: "smartphone",
  review: "diff",
  huddle: "users",
};

/** What each panel is for, said under its name in the Tools menu. */
const sidePaneDetail: Record<ToolbarPane, string> = {
  files: "Browse and open the worktree's files",
  browser: "A browser beside the chat, for the app you are building",
  mobile: "Phone emulators and simulators",
  review: "Review, stage, and commit the agent's changes",
  huddle: "Agents talking to each other in one thread",
};

export const sidePaneShortcut = {
  files: "toggleFiles",
  browser: "toggleBrowser",
  mobile: "toggleMobile",
  review: "toggleChanges",
  huddle: "toggleHuddle",
} as const satisfies Record<ToolbarPane, ShortcutId>;

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
  showTerminal = true,
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
  /** Off when the person works in chat only, so the terminal stays out of the way. */
  showTerminal?: boolean;
}) {
  const panes: readonly ToolbarPane[] = mobileAvailable
    ? ["files", "browser", "mobile", "review", "huddle"]
    : ["files", "browser", "review", "huddle"];
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
        <Button variant="ghost" size="sm" icon="agentNew" shortcut={shortcuts.newAgent} onClick={onNewAgent}>
          <span className="topbar-new-agent-label">New agent</span>
        </Button>
      )}
      {hasProjects && onOpenIssues ? (
        <IconButton label="Issues" tooltip="Start from an issue" icon="issue" onClick={onOpenIssues} />
      ) : null}
      {/*
        Every panel sits in one Tools menu, named and explained, rather than as a row of bare icons. The
        panel that is open keeps a button beside it, so closing it is one click.
      */}
      <fieldset className="topbar-tools" aria-label="Panels">
        {showTerminal ? (
          <ToolToggle
            label="Terminal"
            icon="terminal"
            shortcut={shortcuts.toggleDrawer}
            active={drawerOpen}
            onClick={onToggleDrawer}
          />
        ) : null}
        {sidePane && sidePane !== "pullRequest" ? (
          <ToolToggle
            label={sidePaneLabel[sidePane]}
            icon={sidePaneIcon[sidePane]}
            shortcut={shortcuts[sidePaneShortcut[sidePane]]}
            active
            onClick={() => onToggleSidePane(sidePane)}
          />
        ) : null}
        <MenuButton
          className="topbar-tools-menu"
          label="Tools"
          tooltip="Files, Changes, Browser, and more"
          icon="grid"
          size="sm"
          iconSize={14}
          items={() =>
            panes.map(
              (pane): MenuItem => ({
                id: pane,
                label: sidePaneLabel[pane],
                icon: sidePaneIcon[pane],
                title: sidePaneDetail[pane],
                shortcut: shortcuts[sidePaneShortcut[pane]],
                checked: sidePane === pane,
                run: () => onToggleSidePane(pane),
              }),
            )
          }
        >
          <span className="topbar-tools-label">Tools</span>
        </MenuButton>
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
