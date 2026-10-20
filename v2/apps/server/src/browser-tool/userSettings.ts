import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ListedProviderKind } from "@zli-v2/contracts";

import {
  BROWSER_MCP_SERVER,
  type BrowserToolConfig,
  isPlainObject,
  mcpServerSpec,
  writeFileAtomic,
} from "./browserTool.js";

/** Agents whose CLIs have no per-launch MCP flag, so the server is registered in their user settings. */
export type UserSettingsProvider = Extract<ListedProviderKind, "cursor-agent" | "droid" | "kimi" | "gemini" | "qwen">;

export type UserSettingsTarget = {
  provider: UserSettingsProvider;
  path: string;
  /** Fields ZLI owns in the server entry. Fields the user added, such as `disabled`, are kept. */
  entry: Record<string, unknown>;
};

export type UserSettingsOutcome = {
  provider: UserSettingsProvider;
  path: string;
  status: "created" | "updated" | "unchanged" | "skipped-absent" | "skipped-invalid" | "failed";
  message?: string;
};

export type UserSettingsOptions = {
  home: string;
  env?: NodeJS.ProcessEnv;
  /** Whether the provider's CLI was discovered. Settings for absent CLIs are written only if their dir exists. */
  isInstalled: (provider: UserSettingsProvider) => Promise<boolean>;
  log?: (level: "info" | "warn", message: string, context: Record<string, unknown>) => void;
};

export function userSettingsTargets(
  config: BrowserToolConfig,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): UserSettingsTarget[] {
  // A global entry cannot name one worktree; the tool falls back to matching its cwd.
  const spec = mcpServerSpec(config);
  const stdio = { command: spec.command, args: spec.args, env: spec.env };
  const kimiHome = env.KIMI_CODE_HOME?.trim() || join(home, ".kimi-code");
  return [
    { provider: "cursor-agent", path: join(home, ".cursor", "mcp.json"), entry: stdio },
    { provider: "droid", path: join(home, ".factory", "mcp.json"), entry: { type: "stdio", ...stdio } },
    { provider: "kimi", path: join(kimiHome, "mcp.json"), entry: stdio },
    { provider: "gemini", path: join(home, ".gemini", "settings.json"), entry: stdio },
    { provider: "qwen", path: join(home, ".qwen", "settings.json"), entry: stdio },
  ];
}

/**
 * Adds or refreshes the zli-browser entry in each agent's user MCP settings. Every other key and server
 * is preserved, files that are not plain JSON (for example JSONC with comments) are left alone, and no
 * failure escapes: startup must not depend on a user's config files.
 */
export async function registerBrowserToolInUserSettings(
  config: BrowserToolConfig,
  options: UserSettingsOptions,
): Promise<UserSettingsOutcome[]> {
  const outcomes: UserSettingsOutcome[] = [];
  for (const target of userSettingsTargets(config, options.home, options.env)) {
    const outcome = await registerTarget(target, options).catch(
      (error: unknown): UserSettingsOutcome => ({
        provider: target.provider,
        path: target.path,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    outcomes.push(outcome);
    if (outcome.status === "skipped-invalid" || outcome.status === "failed") {
      options.log?.("warn", "Browser tool was not registered in agent settings.", { ...outcome });
    } else if (outcome.status === "created" || outcome.status === "updated") {
      options.log?.("info", "Browser tool registered in agent settings.", { ...outcome });
    }
  }
  return outcomes;
}

async function registerTarget(target: UserSettingsTarget, options: UserSettingsOptions): Promise<UserSettingsOutcome> {
  const base = { provider: target.provider, path: target.path };
  const installed = await options.isInstalled(target.provider).catch(() => false);
  if (!installed && !(await isDirectory(dirname(target.path)))) return { ...base, status: "skipped-absent" };

  let text: string | undefined;
  try {
    text = await readFile(target.path, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  let root: Record<string, unknown> = {};
  if (text !== undefined && text.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/u, ""));
    } catch {
      return { ...base, status: "skipped-invalid", message: "The file is not plain JSON." };
    }
    if (!isPlainObject(parsed))
      return { ...base, status: "skipped-invalid", message: "The file is not a JSON object." };
    root = parsed;
  }
  const servers = root.mcpServers ?? {};
  if (!isPlainObject(servers)) {
    return { ...base, status: "skipped-invalid", message: "mcpServers is not a JSON object." };
  }

  const name = BROWSER_MCP_SERVER;
  const existing = servers[name];
  const next = { ...(isPlainObject(existing) ? existing : {}), ...target.entry };
  if (isPlainObject(existing) && sameJson(existing, next)) return { ...base, status: "unchanged" };

  const updated = { ...root, mcpServers: { ...servers, [name]: next } };
  await writeFileAtomic(target.path, `${JSON.stringify(updated, null, indentOf(text))}\n`);
  return { ...base, status: existing === undefined ? "created" : "updated" };
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length && keys.every((key) => key in right && sameJson(left[key], right[key]))
    );
  }
  return left === right;
}

/** Keeps the file's existing indentation so a rewrite does not reformat the user's whole file. */
function indentOf(text: string | undefined): string | number {
  const match = text?.match(/^[{[][^\S\r\n]*\r?\n([ \t]+)\S/u);
  return match?.[1] ?? 2;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
