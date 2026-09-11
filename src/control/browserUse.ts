import type { ControlMethod } from "./protocol.ts";

export const BROWSER_USE_TOOLS = [
  "browser_status",
  "browser_open",
  "browser_navigate",
  "browser_wait",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_press",
  "browser_console",
  "browser_errors",
  "browser_screenshot",
] as const;

export type BrowserUseTool = (typeof BROWSER_USE_TOOLS)[number];

export interface BrowserUseRequest {
  tool: BrowserUseTool;
  arguments: Record<string, unknown>;
}

export function isBrowserUseTool(value: string): value is BrowserUseTool {
  return (BROWSER_USE_TOOLS as readonly string[]).includes(value);
}

export function browserUseControlMethod(tool: BrowserUseTool): ControlMethod {
  return tool.replace("browser_", "browser.") as ControlMethod;
}
