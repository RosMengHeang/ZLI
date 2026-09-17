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
  "browser_get_state",
  "browser_type",
  "browser_extract_content",
  "browser_list_tabs",
  "browser_go_back",
  "browser_scroll",
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
  const compatibleAliases: Partial<Record<BrowserUseTool, ControlMethod>> = {
    browser_get_state: "browser.snapshot",
    browser_type: "browser.fill",
    browser_extract_content: "browser.snapshot",
    browser_list_tabs: "browser.list",
  };
  const alias = compatibleAliases[tool];
  if (alias) return alias;
  return tool.replace("browser_", "browser.") as ControlMethod;
}
