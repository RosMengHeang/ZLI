import type { DevServerProjection, ProjectProjection, WorktreeProjection } from "@zli-v2/contracts";
import { type ReactNode, useLayoutEffect, useRef } from "react";

import { DevServerChip } from "../devservers/DevServers.js";
import type { ShortcutId } from "../settings/appSettings.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon, type IconName } from "../ui/Icon.js";
import { ariaShortcut, shortcutText } from "../ui/shortcuts.js";
import { useShortcuts } from "./keybindings.js";

/**
 * The side panels. A pull request opens from its agent, so it is not in the picker; the picker itself is the
 * launcher, what the right panel shows before a panel is chosen.
 */
export type SidePane = "files" | "browser" | "mobile" | "review" | "huddle" | "pullRequest" | "sideChat" | "launcher";
export type ToolbarPane = Exclude<SidePane, "pullRequest" | "sideChat" | "launcher">;

export const sidePaneLabel: Record<SidePane, string> = {
  files: "Files",
  browser: "Browser",
  mobile: "Mobile",
  review: "Changes",
  huddle: "Huddle",
  pullRequest: "Pull request",
  sideChat: "Side chat",
  launcher: "Panels",
};

export const sidePaneIcon: Record<ToolbarPane, IconName> = {
  files: "folderTree",
  browser: "globe",
  mobile: "smartphone",
  review: "diff",
  huddle: "users",
};

/** What each panel is for, said under its name in the panel picker. */
export const sidePaneDetail: Record<ToolbarPane, string> = {
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
  sidebarButton = true,
  project,
  worktree,
  hasProjects,
  drawerOpen,
  sidePane,
  onShowSidebar,
  onNewAgent,
  onOpenIssues,
  onToggleDrawer,
  onTogglePanels,
  devServers = [],
  onOpenDevServer,
  updateNotice,
  showTerminal = true,
}: {
  sidebarOpen: boolean;
  /** Off when the layout puts Show sidebar and New agent somewhere else. */
  sidebarButton?: boolean;
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
  /** Opens the right panel on the panel picker, or closes whatever it shows. */
  onTogglePanels(): void;
  /** Servers the selected worktree's terminals are running, newest first. */
  devServers?: readonly DevServerProjection[];
  onOpenDevServer?(url: string): void;
  /** The update pill, shown before the panel toggles. */
  updateNotice?: ReactNode;
  /** Off when the person works in chat only, so the terminal stays out of the way. */
  showTerminal?: boolean;
}) {
  const shortcuts = useShortcuts();
  // In the columns layout the bar floats over the top-right corner; the headers under it keep its width clear.
  const bar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = bar.current;
    const shell = element?.closest<HTMLElement>(".app-shell");
    if (!element || !shell || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      shell.style.setProperty("--zli-topbar-width", `${element.offsetWidth}px`),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <header className="topbar" ref={bar}>
      {sidebarOpen || !sidebarButton ? null : (
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
          <span className="topbar-project is-empty">{hasProjects ? "" : "No project open"}</span>
        )}
        {worktree && onOpenDevServer ? <DevServerChip devServers={devServers} onOpen={onOpenDevServer} /> : null}
      </div>
      <span className="topbar-spacer" />
      {updateNotice}
      {sidebarOpen || !sidebarButton || !hasProjects ? null : (
        <Button variant="ghost" size="sm" icon="agentNew" shortcut={shortcuts.newAgent} onClick={onNewAgent}>
          <span className="topbar-new-agent-label">New agent</span>
        </Button>
      )}
      {hasProjects && onOpenIssues ? (
        <IconButton label="Issues" tooltip="Start from an issue" icon="issue" onClick={onOpenIssues} />
      ) : null}
      {/*
        The top bar keeps two switches: the terminal at the bottom and the panel on the right. The right one
        opens on a picker of every panel, each with a key, so nothing hides behind a menu.
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
        <ToolToggle
          label="Right panel"
          icon="panelRight"
          tooltip={sidePane ? `Hide ${sidePaneLabel[sidePane].toLowerCase()}` : "Open a panel"}
          active={sidePane !== undefined}
          onClick={onTogglePanels}
        />
      </fieldset>
    </header>
  );
}

/** Shows or hides a panel. Icon only; the label is the accessible name and the tooltip names the action. */
function ToolToggle({
  label,
  icon,
  shortcut,
  tooltip,
  active,
  onClick,
}: {
  label: string;
  icon: IconName;
  shortcut?: string;
  tooltip?: string;
  active: boolean;
  onClick(): void;
}) {
  return (
    <button
      className={`btn btn-ghost btn-icon tool-toggle${active ? " is-active" : ""}`}
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-tooltip={tooltip ?? `${active ? "Hide" : "Show"} ${label.toLowerCase()}`}
      data-shortcut={shortcut ? shortcutText(shortcut) : undefined}
      aria-keyshortcuts={shortcut ? ariaShortcut(shortcut) : undefined}
      onClick={onClick}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}
