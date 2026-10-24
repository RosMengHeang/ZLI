import { MCP_SERVER_NAME_PATTERN, McpServerConfig, RESERVED_MCP_SERVER_NAMES } from "@zli-v2/contracts";

import { isPlainObject } from "../browser-tool/browserTool.js";
import type { PluginMcpEntry } from "./pluginPackage.js";

/** What `${...}` placeholders in a plugin's MCP servers, prompts, and actions expand to. */
export type PluginContext = {
  /** The installed plugin folder. */
  root: string;
  /** A folder the plugin may keep data in that survives updates. */
  data: string;
  config: Readonly<Record<string, string>>;
  env: NodeJS.ProcessEnv;
};

const ROOT_NAMES = new Set(["CLAUDE_PLUGIN_ROOT", "CODEX_PLUGIN_ROOT", "PLUGIN_ROOT", "ZLI_PLUGIN_ROOT"]);
const DATA_NAMES = new Set(["CLAUDE_PLUGIN_DATA", "ZLI_PLUGIN_DATA"]);

/**
 * Expands the placeholders Claude Code plugins use: the plugin folder, its data folder, `user_config.KEY`
 * settings, and environment variables with an optional `:-default`. `missing` lists settings without a value.
 */
export function substitute(text: string, context: PluginContext): { value: string; missing: string[] } {
  const missing: string[] = [];
  const value = text.replace(/\$\{([^}]{1,200})\}/gu, (match, inner: string) => {
    const name = inner.trim();
    if (ROOT_NAMES.has(name)) return context.root;
    if (DATA_NAMES.has(name)) return context.data;
    if (name.startsWith("user_config.")) {
      const key = name.slice("user_config.".length);
      const configured = context.config[key];
      if (configured === undefined || configured === "") missing.push(key);
      return configured ?? "";
    }
    const env = /^([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?$/su.exec(name);
    if (env?.[1]) return context.env[env[1]] ?? env[2] ?? "";
    return match;
  });
  return { value, missing };
}

/**
 * One plugin MCP server in the form ZLI's own list uses. Remote servers without an Authorization header
 * go through the sign-in bridge, since hosted servers in plugins usually expect the agent to log in.
 */
export function pluginServerConfig(
  entry: PluginMcpEntry,
  context: PluginContext,
): { server: McpServerConfig; missing: string[] } | { problem: string } {
  if (!MCP_SERVER_NAME_PATTERN.test(entry.name) || RESERVED_MCP_SERVER_NAMES.includes(entry.name.toLowerCase())) {
    return { problem: `MCP server ${entry.name} has a name agents cannot use.` };
  }
  const missing: string[] = [];
  const expand = (text: string) => {
    const result = substitute(text, context);
    missing.push(...result.missing);
    return result.value;
  };
  const raw = entry.raw;
  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : undefined;
  const candidate =
    typeof raw.url === "string" || type === "http" || type === "sse" || type === "streamable-http"
      ? (() => {
          const headers = stringRecord(raw.headers, expand);
          const hasAuth = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
          return {
            name: entry.name,
            enabled: true,
            transport: "http" as const,
            url: expand(typeof raw.url === "string" ? raw.url : ""),
            headers,
            oauth: type === "sse" || !hasAuth,
          };
        })()
      : {
          name: entry.name,
          enabled: true,
          transport: "stdio" as const,
          command: expand(typeof raw.command === "string" ? raw.command : ""),
          args: Array.isArray(raw.args) ? raw.args.filter((arg) => typeof arg === "string").map(expand) : [],
          env: stringRecord(raw.env, expand),
        };
  const parsed = McpServerConfig.safeParse(candidate);
  if (!parsed.success) {
    return { problem: `MCP server ${entry.name} cannot be used. ${parsed.error.issues[0]?.message ?? ""}`.trim() };
  }
  return { server: parsed.data, missing: [...new Set(missing)] };
}

function stringRecord(value: unknown, expand: (text: string) => string): Record<string, string> {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) =>
      typeof item === "string" || typeof item === "number" || typeof item === "boolean"
        ? [[key, expand(String(item))]]
        : [],
    ),
  );
}
