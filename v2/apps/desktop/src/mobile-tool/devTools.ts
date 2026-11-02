import type { McpTool, ToolResult } from "../browser-tool/mcp.js";
import { buildTools } from "./dev/build.js";
import { conditionsTools } from "./dev/conditions.js";
import { crashTools } from "./dev/crash.js";
import { doctorTools } from "./dev/doctor.js";
import { packagesTools } from "./dev/packages.js";
import { proposeTools } from "./dev/propose.js";
import type { MobileDevToolModule } from "./dev/types.js";
import { workspaceTools } from "./dev/workspace.js";

const MODULES: readonly MobileDevToolModule[] = [
  proposeTools,
  workspaceTools,
  doctorTools,
  packagesTools,
  crashTools,
  buildTools,
  conditionsTools,
];

/** The tools the mobile dev features add to zli-mobile, after the device tools. */
export const MOBILE_DEV_MCP_TOOLS: readonly McpTool[] = MODULES.flatMap((module) => module.tools);

export const MOBILE_DEV_INSTRUCTIONS = MODULES.map((module) => module.instructions.trim())
  .filter(Boolean)
  .join(" ");

export function formatMobileDevResult(action: string, result: unknown): ToolResult | undefined {
  for (const module of MODULES) {
    const formatted = module.format?.(action, result);
    if (formatted) return formatted;
  }
  return undefined;
}
