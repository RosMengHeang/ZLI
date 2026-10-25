import type { McpStatus } from "./mcpServers.js";

/** A small colored dot. Its label is the tooltip and the accessible name. */
export function McpStatusDot({ status }: { status: McpStatus }) {
  return (
    <span
      className={`mcp-status-dot is-${status.tone}`}
      role="img"
      aria-label={status.label}
      data-tooltip={status.label}
    />
  );
}
