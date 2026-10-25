import {
  PLUGIN_MANIFESTS,
  PLUGIN_MARKETPLACES,
  type PluginComponents,
  type PluginConfigOption,
  type PluginFormat,
  skillNameProblem,
} from "@zli-v2/contracts";

import { isPlainObject } from "../browser-tool/browserTool.js";
import { skillsFromFiles, unsafeSegment } from "../skills/githubSource.js";
import { parseSkillMarkdown } from "../skills/skillMarkdown.js";

export const MAX_PLUGIN_FILES = 2_000;
export const MAX_PLUGIN_BYTES = 50 * 1024 * 1024;
export const MAX_PLUGIN_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PROMPT_TEXT = 20_000;
const MAX_ACTION_COMMAND = 4_000;

export class PluginError extends Error {}

export type PluginSkill = { name: string; dir: string };
export type PluginMcpEntry = { name: string; raw: Record<string, unknown> };
export type PluginPromptDef = { name: string; description: string; prompt: string };
export type PluginActionDef = { name: string; description: string; command: string };

/** What a plugin brings, read once at install time and stored with it. Paths are relative to its folder. */
export type PluginDescriptor = {
  name: string;
  displayName: string;
  description: string;
  version?: string;
  format: PluginFormat;
  skills: PluginSkill[];
  mcpServers: PluginMcpEntry[];
  prompts: PluginPromptDef[];
  actions: PluginActionDef[];
  config: PluginConfigOption[];
  ignored: string[];
  /** Parts that were left out, such as a skill without a description. */
  warnings: string[];
};

export type PluginFile = { path: string; data: Uint8Array };

export type PluginPackage = {
  /** The plugin folder relative to the source root, "" for the root itself. */
  root: string;
  descriptor: PluginDescriptor;
  files: PluginFile[];
  bytes: number;
  problem?: string;
};

export type PluginScan = {
  candidates: PluginPackage[];
  marketplace?: string;
  elsewhere: Array<{ name: string; description: string; source: string }>;
};

const decoder = new TextDecoder();

/**
 * Finds the plugins in a set of files keyed by their path from the source root: folders with a ZLI,
 * Claude Code, or Codex manifest, folders a marketplace file lists, or, failing both, the root itself
 * when it holds plugin parts.
 */
export function scanPlugins(
  files: ReadonlyMap<string, Uint8Array>,
  options: { links?: ReadonlySet<string>; fallbackName: string },
): PluginScan {
  const roots = new Map<string, { format: PluginFormat; name?: string; description?: string }>();
  for (const manifest of PLUGIN_MANIFESTS) {
    for (const path of files.keys()) {
      if (path !== manifest.path && !path.endsWith(`/${manifest.path}`)) continue;
      const root = path.slice(0, path.length - manifest.path.length).replace(/\/$/u, "");
      if (!roots.has(root)) roots.set(root, { format: manifest.format });
    }
  }

  const elsewhere: PluginScan["elsewhere"] = [];
  let marketplace: string | undefined;
  for (const path of PLUGIN_MARKETPLACES) {
    const catalog = readJson(files, path);
    if (!isPlainObject(catalog) || !Array.isArray(catalog.plugins)) continue;
    marketplace =
      stringField(catalog, "name") ??
      stringField(isPlainObject(catalog.interface) ? catalog.interface : {}, "displayName");
    const base = cleanPath(stringField(isPlainObject(catalog.metadata) ? catalog.metadata : {}, "pluginRoot") ?? "");
    for (const entry of catalog.plugins) {
      if (!isPlainObject(entry)) continue;
      const name = stringField(entry, "name");
      if (!name) continue;
      const description = stringField(entry, "description") ?? "";
      const local = localEntryPath(entry.source);
      if (local !== undefined) {
        const root = cleanPath(joinPath(base ?? "", local) ?? "");
        if (root === undefined || !hasFilesUnder(files, root)) continue;
        const known = roots.get(root);
        roots.set(root, { ...(known ?? { format: "folder" }), name, description });
        continue;
      }
      const remote = remoteEntrySource(entry.source);
      if (remote) elsewhere.push({ name, description, source: remote });
    }
    break;
  }

  if (roots.size === 0 && hasPluginParts(files, "")) roots.set("", { format: "folder" });

  const candidates = [...roots]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([root, hint]) => readPlugin(files, root, hint, options));
  return { candidates, ...(marketplace ? { marketplace } : {}), elsewhere };
}

function readPlugin(
  allFiles: ReadonlyMap<string, Uint8Array>,
  root: string,
  hint: { format: PluginFormat; name?: string; description?: string },
  options: { links?: ReadonlySet<string>; fallbackName: string },
): PluginPackage {
  const files = new Map<string, Uint8Array>();
  for (const [path, data] of allFiles) {
    const local = relativeTo(path, root);
    if (local !== undefined) files.set(local, data);
  }
  const manifestPath = PLUGIN_MANIFESTS.find((entry) => entry.format === hint.format)?.path;
  const rawManifest = manifestPath ? readJson(files, manifestPath) : {};
  const warnings: string[] = [];
  let problem: string | undefined;
  if (manifestPath && !isPlainObject(rawManifest)) problem = `${manifestPath} is not a valid JSON object.`;
  const manifest: Record<string, unknown> = isPlainObject(rawManifest) ? rawManifest : {};
  const ui = isPlainObject(manifest.interface) ? manifest.interface : {};
  const folderName = root.split("/").at(-1) || options.fallbackName;
  const name = (stringField(manifest, "name") ?? hint.name ?? folderName).trim();
  const nameProblem = skillNameProblem(name);
  if (!problem && nameProblem) problem = `The plugin name ${name} does not fit the naming rule. ${nameProblem}`;

  const descriptor: PluginDescriptor = {
    name,
    displayName: stringField(manifest, "displayName") ?? stringField(ui, "displayName") ?? name,
    description: stringField(manifest, "description") ?? stringField(ui, "shortDescription") ?? hint.description ?? "",
    ...versionOf(manifest),
    format: hint.format,
    skills: readSkills(files, manifest, warnings),
    mcpServers: readMcpServers(files, manifest, warnings),
    prompts: readPrompts(files, manifest, warnings),
    actions: readActions(manifest, warnings),
    config: readConfig(manifest),
    ignored: ignoredParts(files, manifest),
    warnings,
  };

  const list = [...files].map(([path, data]) => ({ path, data }));
  const bytes = list.reduce((total, file) => total + file.data.byteLength, 0);
  if (!problem && list.some((file) => file.path.split("/").some((part) => part === ".." || unsafeSegment(part)))) {
    problem = "It has file names that are not safe to copy.";
  }
  if (!problem && (list.length > MAX_PLUGIN_FILES || bytes > MAX_PLUGIN_BYTES)) problem = "It is too large to install.";
  if (!problem && list.length > 0 && countParts(descriptor) === 0) {
    problem = "It has no skills, MCP servers, prompts, or actions that ZLI can use.";
  }
  if ([...(options.links ?? [])].some((path) => relativeTo(path, root) !== undefined)) {
    warnings.push("Symbolic links in the plugin were left out.");
  }
  return { root, descriptor, files: list, bytes, ...(problem ? { problem } : {}) };
}

export function countParts(descriptor: Pick<PluginDescriptor, "skills" | "mcpServers" | "prompts" | "actions">) {
  return (
    descriptor.skills.length + descriptor.mcpServers.length + descriptor.prompts.length + descriptor.actions.length
  );
}

export function componentsOf(descriptor: PluginDescriptor): PluginComponents {
  return {
    skills: descriptor.skills.map((skill) => skill.name),
    mcpServers: descriptor.mcpServers.map((server) => server.name),
    prompts: descriptor.prompts.map(({ name, description }) => ({ name, description })),
    actions: descriptor.actions.map(({ name, description, command }) => ({ name, description, command })),
    ignored: [...descriptor.ignored],
  };
}

function readSkills(files: Map<string, Uint8Array>, manifest: Record<string, unknown>, warnings: string[]) {
  const dirs = unique(["skills", ...pathList(manifest.skills)]);
  const skills: PluginSkill[] = [];
  for (const dir of dirs) {
    const scoped = new Map<string, Uint8Array>();
    for (const [path, data] of files) {
      const local = dir === "" ? path : relativeTo(path, dir);
      if (local !== undefined) scoped.set(local, data);
    }
    for (const skill of skillsFromFiles(scoped, { repo: "plugin" })) {
      if (skill.problem) {
        warnings.push(`Skill ${skill.name} was left out. ${skill.problem}`);
        continue;
      }
      if (skills.some((entry) => entry.name === skill.name)) continue;
      skills.push({ name: skill.name, dir: joinPath(dir, skill.path === "." ? "" : skill.path) ?? dir });
    }
  }
  return skills;
}

function readMcpServers(files: Map<string, Uint8Array>, manifest: Record<string, unknown>, warnings: string[]) {
  const servers = new Map<string, Record<string, unknown>>();
  const addFrom = (value: unknown, label: string) => {
    const map = isPlainObject(value) && isPlainObject(value.mcpServers) ? value.mcpServers : value;
    if (!isPlainObject(map)) {
      warnings.push(`${label} does not hold MCP servers ZLI can read.`);
      return;
    }
    for (const [name, raw] of Object.entries(map)) {
      if (isPlainObject(raw)) servers.set(name, raw);
    }
  };
  if (files.has(".mcp.json")) addFrom(readJson(files, ".mcp.json"), ".mcp.json");
  const declared = manifest.mcpServers;
  for (const item of Array.isArray(declared) ? declared : declared === undefined ? [] : [declared]) {
    if (typeof item === "string") {
      const path = cleanPath(item);
      if (!path || path === ".mcp.json") continue;
      if (/\.(mcpb|dxt)$/iu.test(path)) {
        warnings.push(`${path} is an MCP bundle, which ZLI does not install.`);
        continue;
      }
      addFrom(readJson(files, path), path);
    } else if (isPlainObject(item)) {
      addFrom(item, "plugin.json");
    }
  }
  return [...servers].map(([name, raw]) => ({ name, raw }));
}

function readPrompts(files: Map<string, Uint8Array>, manifest: Record<string, unknown>, warnings: string[]) {
  const prompts: PluginPromptDef[] = [];
  const add = (name: string, text: string, description?: string) => {
    if (prompts.some((entry) => entry.name === name)) return;
    const parsed = parseSkillMarkdown(text);
    const prompt = parsed.body.trim();
    if (!prompt) return;
    if (prompt.length > MAX_PROMPT_TEXT) {
      warnings.push(`Prompt ${name} was left out because it is too long.`);
      return;
    }
    prompts.push({ name, description: description ?? parsed.description ?? "", prompt });
  };
  const declared = manifest.commands;
  if (isPlainObject(declared)) {
    for (const [name, entry] of Object.entries(declared)) {
      if (!isPlainObject(entry)) continue;
      const description = stringField(entry, "description");
      const content = stringField(entry, "content");
      const source = stringField(entry, "source");
      const text = content ?? (source ? textOf(files, cleanPath(source)) : undefined);
      if (text) add(name, text, description);
    }
    return prompts;
  }
  const paths = declared === undefined ? ["commands"] : pathList(declared);
  for (const path of paths) {
    if (path.endsWith(".md") && files.has(path)) {
      add(baseName(path), textOf(files, path) ?? "");
      continue;
    }
    const inside = [...files.keys()]
      .filter((file) => file.endsWith(".md") && relativeTo(file, path) !== undefined)
      .sort((left, right) => left.localeCompare(right));
    for (const file of inside) {
      const local = relativeTo(file, path) ?? file;
      add(local.slice(0, -3).split("/").join(":"), textOf(files, file) ?? "");
    }
  }
  return prompts;
}

function readActions(manifest: Record<string, unknown>, warnings: string[]): PluginActionDef[] {
  const actions: PluginActionDef[] = [];
  if (!Array.isArray(manifest.actions)) return actions;
  for (const entry of manifest.actions) {
    if (!isPlainObject(entry)) continue;
    const name = stringField(entry, "name");
    const command = typeof entry.command === "string" ? entry.command.trim() : undefined;
    if (!name || !command) continue;
    if (command.length > MAX_ACTION_COMMAND || /[\0\r\n]/u.test(command)) {
      warnings.push(`Action ${name} was left out. Its command must be one line.`);
      continue;
    }
    if (actions.some((action) => action.name === name)) continue;
    actions.push({ name: name.slice(0, 120), description: stringField(entry, "description") ?? "", command });
  }
  return actions;
}

function readConfig(manifest: Record<string, unknown>): PluginConfigOption[] {
  if (!isPlainObject(manifest.userConfig)) return [];
  return Object.entries(manifest.userConfig).flatMap(([key, value]): PluginConfigOption[] => {
    if (!isPlainObject(value) || !/^[A-Za-z0-9_.-]{1,100}$/u.test(key)) return [];
    const type = stringField(value, "type");
    const fallback = value.default;
    return [
      {
        key,
        title: stringField(value, "title") ?? key,
        ...(stringField(value, "description") ? { description: stringField(value, "description") } : {}),
        type: type === "number" || type === "boolean" || type === "directory" || type === "file" ? type : "string",
        sensitive: value.sensitive === true,
        required: value.required === true,
        ...(typeof fallback === "string" || typeof fallback === "number" || typeof fallback === "boolean"
          ? { default: String(fallback) }
          : {}),
      },
    ];
  });
}

function ignoredParts(files: Map<string, Uint8Array>, manifest: Record<string, unknown>): string[] {
  const parts: string[] = [];
  const has = (prefix: string) => [...files.keys()].some((path) => path === prefix || path.startsWith(`${prefix}/`));
  if (manifest.hooks !== undefined || has("hooks")) parts.push("hooks");
  if (manifest.agents !== undefined || has("agents")) parts.push("subagents");
  if (manifest.lspServers !== undefined || files.has(".lsp.json")) parts.push("LSP servers");
  if (manifest.outputStyles !== undefined || has("output-styles")) parts.push("output styles");
  if (manifest.apps !== undefined || files.has(".app.json")) parts.push("apps");
  return parts;
}

function hasPluginParts(files: ReadonlyMap<string, Uint8Array>, root: string): boolean {
  return [...files.keys()].some((path) => {
    const local = relativeTo(path, root);
    return (
      local !== undefined &&
      (local === ".mcp.json" || local.startsWith("commands/") || /^skills\/.+\/SKILL\.md$/u.test(local))
    );
  });
}

function hasFilesUnder(files: ReadonlyMap<string, Uint8Array>, root: string): boolean {
  return [...files.keys()].some((path) => relativeTo(path, root) !== undefined);
}

function localEntryPath(source: unknown): string | undefined {
  if (typeof source === "string") return /^[a-z][a-z0-9+.-]*:/iu.test(source) ? undefined : source;
  if (!isPlainObject(source)) return undefined;
  const kind = stringField(source, "source");
  if (kind === "local" || kind === "relative" || kind === "path") return stringField(source, "path");
  return undefined;
}

/** A source the person can paste into Install, for catalog entries that live in another repository. */
function remoteEntrySource(source: unknown): string | undefined {
  if (typeof source === "string") return /^https?:\/\//iu.test(source) ? source : undefined;
  if (!isPlainObject(source)) return undefined;
  const repo = stringField(source, "repo");
  const path = stringField(source, "path");
  if (repo && /^[\w.-]+\/[\w.-]+$/u.test(repo)) return path ? `${repo}/${cleanPath(path) ?? ""}` : repo;
  const url = stringField(source, "url");
  if (url && /^https:\/\/github\.com\//iu.test(url)) {
    const base = url.replace(/\.git$/u, "");
    return path ? `${base}/tree/HEAD/${cleanPath(path) ?? ""}` : base;
  }
  return url;
}

function textOf(files: ReadonlyMap<string, Uint8Array>, path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const data = files.get(path);
  return data ? decoder.decode(data) : undefined;
}

function readJson(files: ReadonlyMap<string, Uint8Array>, path: string): unknown {
  const text = textOf(files, path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch {
    return null;
  }
}

function versionOf(manifest: Record<string, unknown>): { version?: string } {
  const version = stringField(manifest, "version");
  return version ? { version } : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pathList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return items.flatMap((item) => {
    const path = typeof item === "string" ? cleanPath(item) : undefined;
    return path === undefined ? [] : [path];
  });
}

/** A path inside the plugin with forward slashes and no leading `./`, or undefined when it leaves it. */
export function cleanPath(path: string): string | undefined {
  const parts = path
    .trim()
    .replace(/\\/gu, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  if (path.trim().startsWith("/") || /^[A-Za-z]:/u.test(path.trim())) return undefined;
  if (parts.some((part) => part === "..")) return undefined;
  return parts.join("/");
}

function joinPath(left: string, right: string): string | undefined {
  return cleanPath([left, right].filter(Boolean).join("/"));
}

function relativeTo(path: string, dir: string): string | undefined {
  if (dir === "") return path;
  return path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : undefined;
}

function baseName(path: string): string {
  return (path.split("/").at(-1) ?? path).replace(/\.md$/u, "");
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
