import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { type ListedProviderKind, RESERVED_MCP_SERVER_NAMES } from "@zli-v2/contracts";

import { isHttpSpec, isPlainObject, type McpServerSpec, writeFileAtomic } from "./browserTool.js";

/** Agents that read MCP servers from a JSON settings file rather than a launch flag. */
export type SettingsFileProvider = Extract<ListedProviderKind, "cursor-agent" | "droid" | "kimi" | "gemini" | "qwen">;

/**
 * The project-level MCP file each of these CLIs reads from the folder it starts in, relative to that folder:
 * - Cursor: https://cursor.com/docs/mcp
 * - Droid: https://docs.factory.ai/cli/configuration/mcp
 * - Kimi Code: https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html
 * - Gemini: https://geminicli.com/docs/tools/mcp-server/
 * - Qwen Code: https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/
 */
export const PROJECT_MCP_FILES: Readonly<Record<SettingsFileProvider, string>> = {
  "cursor-agent": ".cursor/mcp.json",
  droid: ".factory/mcp.json",
  kimi: ".kimi-code/mcp.json",
  gemini: ".gemini/settings.json",
  qwen: ".qwen/settings.json",
};

export function projectMcpFile(provider: ListedProviderKind): string | undefined {
  return (PROJECT_MCP_FILES as Partial<Record<ListedProviderKind, string>>)[provider];
}

/** A whole project MCP file holding `specs`, in the provider's format. */
export function projectMcpFileContents(provider: SettingsFileProvider, specs: readonly McpServerSpec[]): string {
  const mcpServers = Object.fromEntries(specs.map((spec) => [spec.name, mcpSettingsEntry(provider, spec)]));
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

/**
 * The user-level MCP files older ZLI versions wrote its servers into. ZLI now only removes its own
 * entries from them.
 */
export function userMcpSettingsFiles(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Array<{ provider: SettingsFileProvider; path: string }> {
  const kimiHome = env.KIMI_CODE_HOME?.trim() || join(home, ".kimi-code");
  return [
    { provider: "cursor-agent", path: join(home, ".cursor", "mcp.json") },
    { provider: "droid", path: join(home, ".factory", "mcp.json") },
    { provider: "kimi", path: join(kimiHome, "mcp.json") },
    { provider: "gemini", path: join(home, ".gemini", "settings.json") },
    { provider: "qwen", path: join(home, ".qwen", "settings.json") },
  ];
}

export type SettingsFileStatus = "created" | "updated" | "unchanged" | "skipped-invalid" | "failed";

/**
 * Keys that say how to reach a server. ZLI replaces all of them together, so an entry switched between a
 * command and a URL does not keep the old transport's keys.
 */
const TRANSPORT_KEYS = ["type", "transport", "command", "args", "env", "url", "httpUrl", "headers"];

/** The server entry in one agent's settings format. */
export function mcpSettingsEntry(provider: SettingsFileProvider, spec: McpServerSpec): Record<string, unknown> {
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

/**
 * Takes ZLI's servers back out of the person's own agent settings: the built-in `zli` servers and every
 * name in `owned`, which records the servers ZLI copied there. Every other key and server is kept, files
 * that are not plain JSON are left alone, and no failure escapes. Returns what ZLI still owns, which is
 * only names in files it could not change.
 */
export async function removeZliFromUserSettings(
  owned: Readonly<Record<string, readonly string[]>>,
  options: {
    home: string;
    env?: NodeJS.ProcessEnv;
    log?: (level: "info" | "warn", message: string, context: Record<string, unknown>) => void;
  },
): Promise<Record<string, string[]>> {
  const paths = new Set([
    ...userMcpSettingsFiles(options.home, options.env).map((file) => file.path),
    ...Object.keys(owned),
  ]);
  const remaining: Record<string, string[]> = {};
  for (const path of paths) {
    const names = [...new Set([...RESERVED_MCP_SERVER_NAMES, ...(owned[path] ?? [])])];
    const { status, message } = await applySafely(path, { set: {}, remove: names });
    if (status === "updated") {
      options.log?.("info", "Removed ZLI's MCP servers from an agent's own settings.", { path });
    } else if (status === "skipped-invalid" || status === "failed") {
      const left = owned[path];
      if (left && left.length > 0) remaining[path] = [...left];
      options.log?.("warn", "Could not remove ZLI's MCP servers from an agent's own settings.", {
        path,
        status,
        ...(message ? { message } : {}),
      });
    }
  }
  return remaining;
}

type ServerChanges = { set: Record<string, Record<string, unknown>>; remove: readonly string[] };
type ChangeResult = { status: SettingsFileStatus; message?: string; created: string[] };

async function applySafely(path: string, changes: ServerChanges): Promise<ChangeResult> {
  try {
    return await applyChanges(path, changes);
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error), created: [] };
  }
}

async function applyChanges(path: string, changes: ServerChanges): Promise<ChangeResult> {
  const nothing = Object.keys(changes.set).length === 0 && changes.remove.length === 0;
  if (nothing) return { status: "unchanged", created: [] };

  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (text === undefined && Object.keys(changes.set).length === 0) return { status: "unchanged", created: [] };

  let root: Record<string, unknown> = {};
  if (text !== undefined && text.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/u, ""));
    } catch {
      return { status: "skipped-invalid", message: "The file is not plain JSON.", created: [] };
    }
    if (!isPlainObject(parsed))
      return { status: "skipped-invalid", message: "The file is not a JSON object.", created: [] };
    root = parsed;
  }
  const servers = root.mcpServers ?? {};
  if (!isPlainObject(servers)) {
    return { status: "skipped-invalid", message: "mcpServers is not a JSON object.", created: [] };
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
  if (!changed) return { status: "unchanged", created: [] };

  await writeFileAtomic(path, `${JSON.stringify({ ...root, mcpServers: next }, null, indentOf(text))}\n`);
  const allNew = changes.remove.length === 0 && created.length === Object.keys(changes.set).length;
  return { status: allNew ? "created" : "updated", created };
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
  const settingsProvider = provider as SettingsFileProvider;
  const wanted = new Set(specs.map((spec) => spec.name));
  const set = Object.fromEntries(specs.map((spec) => [spec.name, mcpSettingsEntry(settingsProvider, spec)]));
  const remove = owned.filter((name) => !wanted.has(name));
  const { status, created } = await applySafely(path, { set, remove });
  if (status === "skipped-invalid" || status === "failed") return [...owned];
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

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
