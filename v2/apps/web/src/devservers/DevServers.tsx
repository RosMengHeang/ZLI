import type { DevServerProjection } from "@zli-v2/contracts";

import type { PaletteCommand } from "../shell/CommandPalette.js";
import { Button } from "../ui/Button.js";
import "./devservers.css";

/** The address as people say it: host and port, plus the path when the server is mounted under one. */
export function devServerLabel(url: string): string {
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
}

/** The newest server in the topbar. Clicking it opens the server in the Browser panel. */
export function DevServerChip({
  devServers,
  onOpen,
}: {
  devServers: readonly DevServerProjection[];
  onOpen(url: string): void;
}) {
  const [newest, ...others] = devServers;
  if (!newest) return null;
  const label = devServerLabel(newest.url);
  return (
    <button
      type="button"
      className="devserver-chip"
      aria-label={`Open ${label} in the browser panel`}
      data-tooltip={
        others.length > 0
          ? `Open in the browser panel. Also running: ${others.map((entry) => devServerLabel(entry.url)).join(", ")}`
          : "Open in the browser panel"
      }
      onClick={() => onOpen(newest.url)}
    >
      <span className="status-dot status-terminal-running" aria-hidden="true" />
      <span className="devserver-chip-label">{label}</span>
      {others.length > 0 ? <span className="devserver-chip-more">+{others.length}</span> : null}
    </button>
  );
}

/**
 * Offers the newest server the current tab is not showing. With no tab open the pane's empty state
 * offers them instead, so this bar only appears over a page.
 */
export function DevServerBar({
  devServers,
  currentUrl,
  busy,
  onOpen,
}: {
  devServers: readonly DevServerProjection[];
  currentUrl: string | undefined;
  busy: boolean;
  onOpen(url: string): void;
}) {
  const currentOrigin = originOf(currentUrl);
  const offer = devServers.find((devServer) => originOf(devServer.url) !== currentOrigin);
  if (!offer) return null;
  const label = devServerLabel(offer.url);
  return (
    <div className="devserver-bar">
      <span className="status-dot status-terminal-running" aria-hidden="true" />
      <span className="devserver-bar-text">
        Dev server on <span className="devserver-bar-address">{label}</span>
      </span>
      <Button variant="ghost" size="sm" disabled={busy} aria-label={`Open ${label}`} onClick={() => onOpen(offer.url)}>
        Open
      </Button>
    </div>
  );
}

export function devServerCommands(
  devServers: readonly DevServerProjection[],
  open: (url: string) => void,
): PaletteCommand[] {
  return devServers.map((devServer) => ({
    label: `Open ${devServerLabel(devServer.url)} in the browser`,
    icon: "globe",
    group: "View",
    action: () => open(devServer.url),
  }));
}

export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
