import type { McpTool, ToolResult } from "../../browser-tool/mcp.js";

/**
 * What each mobile dev feature adds to zli-mobile: its tools, an optional formatter for its results, and a sentence
 * for the server's instructions. The command line runs every tool as zli-mobile <tool_name> --json '<args>'.
 */
export type MobileDevToolModule = {
  readonly tools: readonly McpTool[];
  /** Returns undefined for results it does not format, so the next formatter or the JSON default applies. */
  readonly format: ((action: string, result: unknown) => ToolResult | undefined) | undefined;
  /** Joined onto the server's instructions. Empty adds nothing. */
  readonly instructions: string;
};
