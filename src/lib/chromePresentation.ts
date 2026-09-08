export type ToolbarDensity = "compact" | "comfortable";
export type PrimaryDestination = "workspace" | "agents" | "changes" | "browser";
export type BaseDestination = Extract<PrimaryDestination, "workspace" | "agents">;
export type ShellRegion = keyof typeof SHELL_LIMITS;

export interface NavigationTarget {
  baseDestination: BaseDestination;
  browserOpen: boolean;
  gitPanelOpen: boolean;
  selectedAgentId: string | null;
}

export const SHELL_LIMITS = {
  sidebar: { default: "228px", min: "196px", max: "300px" },
  browser: { default: "34%", min: "360px", max: "50%" },
  git: { default: "34%", min: "220px", max: "68%" },
} as const;

export interface BrowserViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NativeBrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function browserShellLayout() {
  return {
    side: "right" as const,
    defaultSize: SHELL_LIMITS.browser.default,
    minSize: SHELL_LIMITS.browser.min,
    maxSize: SHELL_LIMITS.browser.max,
  };
}

export function nativeBrowserBounds(rect: BrowserViewportRect): NativeBrowserBounds {
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

export function toolbarDensityForWidth(width: number): ToolbarDensity {
  return width < 1100 ? "compact" : "comfortable";
}

const PRIMARY_DESTINATIONS: ReadonlyArray<{ id: PrimaryDestination; label: string }> = [
  { id: "workspace", label: "Workspace" },
  { id: "agents", label: "Agents" },
  { id: "changes", label: "Changes" },
  { id: "browser", label: "Browser" },
];

export function sidebarNavigationItems(current: PrimaryDestination) {
  return PRIMARY_DESTINATIONS.map((item) => ({ ...item, current: item.id === current }));
}

export function currentSidebarDestination(
  baseDestination: BaseDestination,
  browserOpen: boolean,
  gitPanelOpen: boolean,
): PrimaryDestination {
  if (gitPanelOpen) return "changes";
  if (browserOpen) return "browser";
  return baseDestination;
}

export function navigationTargetForDestination(
  destination: PrimaryDestination,
  agentIds: readonly string[],
  selectedAgentId: string | null = null,
  baseDestination: BaseDestination = "workspace",
): NavigationTarget {
  const nextSelectedAgentId =
    destination === "agents"
      ? agentIds.includes(selectedAgentId ?? "")
        ? selectedAgentId
        : (agentIds[0] ?? null)
      : selectedAgentId;

  return {
    baseDestination:
      destination === "workspace" || destination === "agents" ? destination : baseDestination,
    browserOpen: destination === "browser",
    gitPanelOpen: destination === "changes",
    selectedAgentId: nextSelectedAgentId,
  };
}

export function aggregateRunningStatus(runningCount: number) {
  return runningCount > 0
    ? { label: `${runningCount} running`, presentedStatus: "running" as const }
    : { label: "Idle", presentedStatus: "stopped" as const };
}

export function defaultShellSize(region: ShellRegion, storedPercentage: number | undefined): string {
  return storedPercentage === undefined ? SHELL_LIMITS[region].default : `${storedPercentage}%`;
}
