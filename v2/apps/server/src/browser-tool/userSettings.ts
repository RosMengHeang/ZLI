import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ListedProviderKind } from "@zli-v2/contracts";

import {
  AGENT_MCP_SERVER,
  agentMcpServerSpec,
  BROWSER_MCP_SERVER,
  type BrowserToolConfig,
  isHttpSpec,
  isPlainObject,
  type McpServerSpec,
  MOBILE_MCP_SERVER,
  mcpServerSpec,
  mobileMcpServerSpec,
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

/** Server names ZLI added, keyed by settings file path. */
export type UserSettingsOwnership = Record<string, readonly string[]>;

export function userSettingsFiles(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ provider: UserSettingsProvider; path: string }> {
  const kimiHome = env.KIMI_CODE_HOME?.trim() || join(home, ".kimi-code");
  return [
    { provider: "cursor-agent", path: join(home, ".cursor", "mcp.json") },
    { provider: "droid", path: join(home, ".factory", "mcp.json") },
    { provider: "kimi", path: join(kimiHome, "mcp.json") },
    { provider: "gemini", path: join(home, ".gemini", "settings.json") },
    { provider: "qwen", path: join(home, ".qwen", "settings.json") },
  ];
}

/**
 * Keys that say how to reach a server. ZLI replaces all of them together, so an entry switched between a
 * command and a URL does not keep the old transport's keys.
 */
const TRANSPORT_KEYS = ["type", "transport", "command", "args", "env", "url", "httpUrl", "headers"];

/** The server entry in one agent's settings format. */
export function userSettingsEntry(provider: UserSettingsProvider, spec: McpServerSpec): Record<string, unknown> {
  if (isHttpSpec(spec)) {
    const headers = Object.keys(spec.headers).length > 0 ? { headers: { ...spec.headers } } : {};
    switch (provider) {
      case "droid":
        return { type: "http", url: spec.url, ...headers };
      case "gemini":
      case "qwen":
        return { httpUrl: spec.url, ...headers };
      case "cursor-agent":
      case "kimi":
        return { url: spec.url, ...headers };
    }
  }
  const stdio = { command: spec.command, args: [...spec.args], env: { ...spec.env } };
  return provider === "droid" ? { type: "stdio", ...stdio } : stdio;
}

export function userSettingsTargets(
  config: BrowserToolConfig,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): UserSettingsTarget[] {
  // A global entry cannot name one worktree; the tool falls back to matching its cwd.
  const spec = mcpServerSpec(config);
  return userSettingsFiles(home, env).map((file) => ({ ...file, entry: userSettingsEntry(file.provider, spec) }));
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
  const agentSpec = agentMcpServerSpec(config);
  const mobileSpec = mobileMcpServerSpec(config);
  const agentEntry = (provider: UserSettingsProvider): Record<string, unknown> => ({
    ...(agentSpec ? { [AGENT_MCP_SERVER]: userSettingsEntry(provider, agentSpec) } : {}),
    ...(mobileSpec ? { [MOBILE_MCP_SERVER]: userSettingsEntry(provider, mobileSpec) } : {}),
  });
  for (const target of userSettingsTargets(config, options.home, options.env)) {
    const { outcome } = await applySafely(
      target.provider,
      target.path,
      { set: { [BROWSER_MCP_SERVER]: target.entry, ...agentEntry(target.provider) }, remove: [] },
      options,
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

/**
 * Makes each agent's user settings hold exactly the enabled servers from ZLI's list. A server is removed
 * later only if ZLI added it, so an entry the person already had under the same name survives a delete.
 * Returns the names ZLI now owns per file; persist it and pass it back on the next sync.
 */
export async function syncUserMcpServers(
  specs: readonly McpServerSpec[],
  owned: UserSettingsOwnership,
  options: UserSettingsOptions,
): Promise<{ outcomes: UserSettingsOutcome[]; owned: Record<string, string[]> }> {
  const wanted = new Set(specs.map((spec) => spec.name));
  const outcomes: UserSettingsOutcome[] = [];
  const nextOwned: Record<string, string[]> = {};
  for (const file of userSettingsFiles(options.home, options.env)) {
    const previous = owned[file.path] ?? [];
    const set = Object.fromEntries(specs.map((spec) => [spec.name, userSettingsEntry(file.provider, spec)]));
    const remove = previous.filter((name) => !wanted.has(name));
    const { outcome, created } = await applySafely(file.provider, file.path, { set, remove }, options);
    outcomes.push(outcome);
    const succeeded = outcome.status === "created" || outcome.status === "updated" || outcome.status === "unchanged";
    const names = succeeded
      ? [...new Set([...previous.filter((name) => wanted.has(name)), ...created])]
      : [...previous];
    if (names.length > 0) nextOwned[file.path] = names;
    if (outcome.status === "skipped-invalid" || outcome.status === "failed") {
      options.log?.("warn", "MCP servers were not copied to agent settings.", { ...outcome });
    }
  }
  return { outcomes, owned: nextOwned };
}

type ServerChanges = { set: Record<string, Record<string, unknown>>; remove: readonly string[] };

async function applySafely(
  provider: UserSettingsProvider,
  path: string,
  changes: ServerChanges,
  options: UserSettingsOptions,
): Promise<{ outcome: UserSettingsOutcome; created: string[] }> {
  try {
    return await applyChanges(provider, path, changes, options);
  } catch (error) {
    return {
      outcome: { provider, path, status: "failed", message: error instanceof Error ? error.message : String(error) },
      created: [],
    };
  }
}

async function applyChanges(
  provider: UserSettingsProvider,
  path: string,
  changes: ServerChanges,
  options: UserSettingsOptions,
): Promise<{ outcome: UserSettingsOutcome; created: string[] }> {
  const base = { provider, path };
  const nothing = Object.keys(changes.set).length === 0 && changes.remove.length === 0;
  if (nothing) return { outcome: { ...base, status: "unchanged" }, created: [] };
  const installed = await options.isInstalled(provider).catch(() => false);
  if (!installed && !(await isDirectory(dirname(path)))) {
    return { outcome: { ...base, status: "skipped-absent" }, created: [] };
  }

  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (text === undefined && Object.keys(changes.set).length === 0) {
    return { outcome: { ...base, status: "unchanged" }, created: [] };
  }

  let root: Record<string, unknown> = {};
  if (text !== undefined && text.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/u, ""));
    } catch {
      return { outcome: { ...base, status: "skipped-invalid", message: "The file is not plain JSON." }, created: [] };
    }
    if (!isPlainObject(parsed)) {
      return {
        outcome: { ...base, status: "skipped-invalid", message: "The file is not a JSON object." },
        created: [],
      };
    }
    root = parsed;
  }
  const servers = root.mcpServers ?? {};
  if (!isPlainObject(servers)) {
    return {
      outcome: { ...base, status: "skipped-invalid", message: "mcpServers is not a JSON object." },
      created: [],
    };
  }

  const next: Record<string, unknown> = { ...servers };
  const created: string[] = [];
  let changed = false;
  for (const name of changes.remove) {
    if (!(name in next)) continue;
    delete next[name];
    changed = true;
  }
  for (const [name, entry] of Object.entries(changes.set)) {
    const existing = next[name];
    const kept = isPlainObject(existing)
      ? Object.fromEntries(Object.entries(existing).filter(([key]) => !TRANSPORT_KEYS.includes(key)))
      : {};
    const merged = { ...kept, ...entry };
    if (isPlainObject(existing) && sameJson(existing, merged)) continue;
    if (existing === undefined) created.push(name);
    next[name] = merged;
    changed = true;
  }
  if (!changed) return { outcome: { ...base, status: "unchanged" }, created: [] };

  await writeFileAtomic(path, `${JSON.stringify({ ...root, mcpServers: next }, null, indentOf(text))}\n`);
  const allNew = changes.remove.length === 0 && created.length === Object.keys(changes.set).length;
  return { outcome: { ...base, status: allNew ? "created" : "updated" }, created };
}

/** The MCP settings file each CLI reads when its config directory variable points at `dir`. */
export function accountSettingsFile(provider: ListedProviderKind, dir: string): string | undefined {
  switch (provider) {
    case "cursor-agent":
    case "kimi":
      return join(dir, "mcp.json");
    case "gemini":
      // GEMINI_CLI_HOME stands in for the home directory, so the settings stay under .gemini.
      return join(dir, ".gemini", "settings.json");
    case "qwen":
      return join(dir, "settings.json");
    default:
      return undefined;
  }
}

/**
 * Brings the MCP servers in a sign-in account's own settings file in line with `specs`. The person may add
 * servers there too, so only names in `owned` are ever removed. Returns the names ZLI owns afterwards, or
 * undefined when the provider reads MCP servers some other way.
 */
export async function syncAccountMcpServers(
  provider: ListedProviderKind,
  dir: string,
  specs: readonly McpServerSpec[],
  owned: readonly string[],
): Promise<string[] | undefined> {
  const path = accountSettingsFile(provider, dir);
  if (!path) return undefined;
  const settingsProvider = provider as UserSettingsProvider;
  const wanted = new Set(specs.map((spec) => spec.name));
  const set = Object.fromEntries(specs.map((spec) => [spec.name, userSettingsEntry(settingsProvider, spec)]));
  const remove = owned.filter((name) => !wanted.has(name));
  const { outcome, created } = await applySafely(
    settingsProvider,
    path,
    { set, remove },
    {
      home: dir,
      isInstalled: async () => true,
    },
  );
  if (outcome.status === "skipped-invalid" || outcome.status === "failed") return [...owned];
  return [...new Set([...owned.filter((name) => wanted.has(name)), ...created])];
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
