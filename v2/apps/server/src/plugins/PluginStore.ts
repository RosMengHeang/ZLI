import type { Dirent } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  McpServerConfig,
  PluginContributions,
  PluginInstallPreview,
  PluginListResult,
  PluginSummary,
} from "@zli-v2/contracts";

import { isPlainObject, writeFileAtomic } from "../browser-tool/browserTool.js";
import { downloadGithubFiles, type GithubSkillSource, parseGithubSkillSource, sourceKey } from "../skills/githubSource.js";
import { isNotFound, replaceFolder, SkillError, writeSkillFiles } from "../skills/skillFolders.js";
import {
  componentsOf,
  MAX_PLUGIN_BYTES,
  MAX_PLUGIN_FILE_BYTES,
  MAX_PLUGIN_FILES,
  type PluginDescriptor,
  PluginError,
  type PluginPackage,
  type PluginScan,
  scanPlugins,
} from "./pluginPackage.js";
import { type PluginContext, pluginServerConfig, substitute } from "./pluginRuntime.js";

type StoredPlugin = {
  enabled: boolean;
  source: string;
  installedAt: string;
  descriptor: PluginDescriptor;
  config: Record<string, string>;
};

type StoredFile = { version: 1; plugins: Record<string, StoredPlugin> };

type ParsedSource = { kind: "github"; source: GithubSkillSource } | { kind: "local"; path: string };

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_CACHED_PREVIEWS = 3;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);
const MAX_DEPTH = 20;

export type PluginStoreOptions = {
  /** Installed plugins, one folder each. */
  pluginsDir: string;
  /** Data folders plugins keep across updates. */
  dataDir: string;
  /** Which plugins are on, where they came from, and their settings. Settings can be secrets, so it is private. */
  statePath: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  githubToken?: string | undefined;
  now?: () => number;
  /** Names in the person's own MCP list, which win over plugin servers. */
  userServerNames?: () => readonly string[];
  /** Names of the person's own skills, which win over plugin skills. */
  userSkillNames?: () => Promise<readonly string[]>;
  /** Runs after a change so agent settings and skill folders pick it up. */
  onChange?: () => Promise<void>;
};

/**
 * Plugins bundle skills, MCP servers, prompts, and actions. ZLI reads its own `zli-plugin.json` and the
 * Claude Code and Codex plugin formats, keeps each plugin in its own folder, and hands the parts to every
 * agent through the same paths as the person's own skills and servers.
 */
export class PluginStore {
  private plugins: Record<string, StoredPlugin> = {};
  private problem: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly previews = new Map<string, { at: number; scan: PluginScan; label: string }>();

  constructor(private readonly options: PluginStoreOptions) {}

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.options.statePath, "utf8");
    } catch (error) {
      if (!isNotFound(error)) this.problem = "ZLI's plugin settings could not be read.";
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/u, ""));
    } catch {
      this.problem = "ZLI's plugin settings are not valid JSON.";
      return;
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.plugins)) {
      this.problem = "ZLI's plugin settings are not valid.";
      return;
    }
    const plugins: Record<string, StoredPlugin> = {};
    for (const [name, value] of Object.entries(parsed.plugins)) {
      const plugin = storedPlugin(value);
      if (plugin && plugin.descriptor.name === name) plugins[name] = plugin;
    }
    this.plugins = plugins;
  }

  async list(): Promise<PluginListResult> {
    const resolved = this.resolve();
    const librarySkills = new Set(await (this.options.userSkillNames?.() ?? Promise.resolve([])));
    const plugins = Object.entries(this.plugins)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, plugin]): PluginSummary => {
        const { descriptor } = plugin;
        const problems = [...(resolved.problems.get(name) ?? [])];
        if (plugin.enabled) {
          for (const skill of descriptor.skills) {
            if (librarySkills.has(skill.name)) {
              problems.push(`Skill ${skill.name} is not copied to agents: one of your own skills has that name.`);
            }
          }
        }
        problems.push(...descriptor.warnings);
        return {
          name,
          displayName: descriptor.displayName,
          description: descriptor.description,
          ...(descriptor.version ? { version: descriptor.version } : {}),
          format: descriptor.format,
          enabled: plugin.enabled,
          path: this.folder(name),
          source: plugin.source,
          installedAt: plugin.installedAt,
          components: componentsOf(descriptor),
          config: descriptor.config,
          configured: Object.keys(plugin.config).filter((key) => plugin.config[key] !== ""),
          problems,
        };
      });
    return { plugins, pluginsPath: this.options.pluginsDir, ...(this.problem ? { problem: this.problem } : {}) };
  }

  /** MCP servers from enabled plugins whose names are free. `taken` holds lowercase names already used. */
  mcpServers(taken: ReadonlySet<string>): McpServerConfig[] {
    return this.resolve(taken).servers;
  }

  /** Skills from enabled plugins, the first plugin in name order winning a shared name. */
  skills(): Array<{ name: string; path: string }> {
    return this.resolve().skills;
  }

  contributions(): PluginContributions {
    const result: PluginContributions = { prompts: [], actions: [] };
    for (const [name, plugin] of this.enabledPlugins()) {
      const context = this.context(name, plugin);
      for (const prompt of plugin.descriptor.prompts) {
        result.prompts.push({
          plugin: name,
          name: prompt.name,
          description: prompt.description,
          prompt: substitute(prompt.prompt, context).value,
        });
      }
      for (const action of plugin.descriptor.actions) {
        result.actions.push({
          plugin: name,
          name: action.name,
          description: action.description,
          command: substitute(action.command, context).value,
        });
      }
    }
    return result;
  }

  async previewInstall(text: string): Promise<PluginInstallPreview> {
    const { scan, label } = await this.scan(parseSource(text), true);
    return {
      label,
      ...(scan.marketplace ? { marketplace: scan.marketplace } : {}),
      candidates: scan.candidates.map((candidate) => ({
        name: candidate.descriptor.name,
        displayName: candidate.descriptor.displayName,
        description: candidate.descriptor.description,
        ...(candidate.descriptor.version ? { version: candidate.descriptor.version } : {}),
        format: candidate.descriptor.format,
        path: candidate.root || ".",
        components: componentsOf(candidate.descriptor),
        config: candidate.descriptor.config,
        files: candidate.files.length,
        bytes: candidate.bytes,
        exists: candidate.descriptor.name in this.plugins,
        ...(candidate.problem ? { problem: candidate.problem } : {}),
      })),
      elsewhere: scan.elsewhere,
    };
  }

  install(
    text: string,
    names: readonly string[],
    config: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
  ): Promise<string[]> {
    return this.serialize(async () => {
      const source = parseSource(text);
      const { scan } = await this.scan(source, true);
      const chosen = names.map((name) => {
        const candidate = scan.candidates.find((entry) => entry.descriptor.name === name);
        if (!candidate) throw new PluginError(`${name} is not in that source.`);
        if (candidate.problem) throw new PluginError(`${name}: ${candidate.problem}`);
        return candidate;
      });
      for (const candidate of chosen) {
        await this.place(candidate, sourceFor(source, candidate.root), config[candidate.descriptor.name] ?? {});
      }
      await this.afterChange();
      return chosen.map((candidate) => candidate.descriptor.name);
    });
  }

  update(name: string): Promise<void> {
    return this.serialize(async () => {
      const plugin = this.require(name);
      const source = parseSource(plugin.source);
      const { scan } = await this.scan(source, false);
      const candidate =
        scan.candidates.find((entry) => entry.descriptor.name === name) ??
        (scan.candidates.length === 1 ? scan.candidates[0] : undefined);
      if (!candidate) throw new PluginError(`${plugin.source} no longer has the plugin ${name}.`);
      if (candidate.problem) throw new PluginError(candidate.problem);
      if (candidate.descriptor.name !== name) {
        throw new PluginError(`${plugin.source} now holds ${candidate.descriptor.name}. Install it as a new plugin.`);
      }
      await this.place(candidate, plugin.source, {});
      await this.afterChange();
    });
  }

  setEnabled(name: string, enabled: boolean): Promise<void> {
    return this.serialize(async () => {
      this.require(name).enabled = enabled;
      await this.afterChange();
    });
  }

  configure(name: string, values: Readonly<Record<string, string>>): Promise<void> {
    return this.serialize(async () => {
      const plugin = this.require(name);
      plugin.config = mergeConfig(plugin.descriptor, plugin.config, values);
      await this.afterChange();
    });
  }

  remove(name: string): Promise<void> {
    return this.serialize(async () => {
      this.require(name);
      delete this.plugins[name];
      await this.write();
      await rm(this.folder(name), { recursive: true, force: true });
      await rm(join(this.options.dataDir, name), { recursive: true, force: true });
      await this.options.onChange?.().catch(() => undefined);
    });
  }

  async waitForIdle(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  private folder(name: string): string {
    return join(this.options.pluginsDir, name);
  }

  private context(name: string, plugin: StoredPlugin): PluginContext {
    return {
      root: this.folder(name),
      data: join(this.options.dataDir, name),
      config: effectiveConfig(plugin.descriptor, plugin.config),
      env: this.options.env ?? process.env,
    };
  }

  private enabledPlugins(): Array<[string, StoredPlugin]> {
    return Object.entries(this.plugins)
      .filter(([, plugin]) => plugin.enabled)
      .sort(([left], [right]) => left.localeCompare(right));
  }

  /** Which plugin parts reach agents, and why the others do not. */
  private resolve(taken?: ReadonlySet<string>) {
    const userNames = taken ?? new Set((this.options.userServerNames?.() ?? []).map((name) => name.toLowerCase()));
    const servers: McpServerConfig[] = [];
    const skills: Array<{ name: string; path: string }> = [];
    const problems = new Map<string, string[]>();
    const serverOwner = new Map<string, string>();
    const skillOwner = new Map<string, string>();
    for (const [name, plugin] of this.enabledPlugins()) {
      const lines: string[] = [];
      const context = this.context(name, plugin);
      const titles = new Map(plugin.descriptor.config.map((option) => [option.key, option.title]));
      for (const option of plugin.descriptor.config) {
        if (option.required && !context.config[option.key]) lines.push(`Add ${option.title} in the plugin's settings.`);
      }
      for (const entry of plugin.descriptor.mcpServers) {
        const key = entry.name.toLowerCase();
        if (userNames.has(key)) {
          lines.push(`MCP server ${entry.name} is not added: your MCP list already has that name.`);
          continue;
        }
        const owner = serverOwner.get(key);
        if (owner) {
          lines.push(`MCP server ${entry.name} is not added: the plugin ${owner} already adds it.`);
          continue;
        }
        const resolved = pluginServerConfig(entry, context);
        if ("problem" in resolved) {
          lines.push(resolved.problem);
          continue;
        }
        const needed = resolved.missing.filter((key) => plugin.descriptor.config.some((option) => option.key === key));
        if (needed.length > 0) {
          lines.push(`MCP server ${entry.name} needs ${needed.map((key) => titles.get(key) ?? key).join(", ")}.`);
          continue;
        }
        serverOwner.set(key, name);
        servers.push(resolved.server);
      }
      for (const skill of plugin.descriptor.skills) {
        const owner = skillOwner.get(skill.name);
        if (owner) {
          lines.push(`Skill ${skill.name} is not copied: the plugin ${owner} has one with that name.`);
          continue;
        }
        skillOwner.set(skill.name, name);
        skills.push({ name: skill.name, path: join(context.root, ...skill.dir.split("/").filter(Boolean)) });
      }
      if (lines.length > 0) problems.set(name, lines);
    }
    return { servers, skills, problems };
  }

  private async place(candidate: PluginPackage, source: string, values: Readonly<Record<string, string>>) {
    const name = candidate.descriptor.name;
    const previous = this.plugins[name];
    await replaceFolder(this.folder(name), (temp) => writeSkillFiles(temp, candidate.files));
    await mkdir(join(this.options.dataDir, name), { recursive: true });
    this.plugins[name] = {
      enabled: previous?.enabled ?? true,
      source,
      installedAt: new Date((this.options.now ?? Date.now)()).toISOString(),
      descriptor: candidate.descriptor,
      config: mergeConfig(candidate.descriptor, previous?.config ?? {}, values),
    };
  }

  private async scan(source: ParsedSource, useCache: boolean): Promise<{ scan: PluginScan; label: string }> {
    const key = source.kind === "github" ? `gh:${sourceKey(source.source)}` : `local:${source.path}`;
    const now = (this.options.now ?? Date.now)();
    for (const [entry, value] of this.previews) if (now - value.at > PREVIEW_TTL_MS) this.previews.delete(entry);
    const cached = useCache && source.kind === "github" ? this.previews.get(key) : undefined;
    if (cached) return cached;
    let result: { scan: PluginScan; label: string };
    if (source.kind === "github") {
      const { owner, repo, path } = source.source;
      const download = await downloadGithubFiles(source.source, {
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        token: this.options.githubToken,
        maxFileBytes: MAX_PLUGIN_FILE_BYTES,
      });
      const files = new Map<string, Uint8Array>();
      for (const [file, data] of download.files) {
        const local = path ? (file.startsWith(`${path}/`) ? file.slice(path.length + 1) : undefined) : file;
        if (local) files.set(local, data);
      }
      const links = new Set([...download.links].map((link) => (path ? link.slice(path.length + 1) : link)));
      result = {
        scan: scanPlugins(files, { links, fallbackName: (path.split("/").at(-1) || repo).toLowerCase() }),
        label: `${owner}/${repo}${path ? `/${path}` : ""}`,
      };
    } else {
      const { files, links } = await readLocalFolder(source.path);
      result = {
        scan: scanPlugins(files, { links, fallbackName: basename(source.path).toLowerCase() }),
        label: source.path,
      };
    }
    if (result.scan.candidates.length === 0 && result.scan.elsewhere.length === 0) {
      throw new PluginError(
        "No plugin was found there. A plugin has a zli-plugin.json, .claude-plugin/plugin.json, or .codex-plugin/plugin.json, or a skills, commands, or .mcp.json folder.",
      );
    }
    if (source.kind === "github") {
      this.previews.set(key, { at: now, ...result });
      while (this.previews.size > MAX_CACHED_PREVIEWS) {
        const oldest = this.previews.keys().next().value;
        if (oldest === undefined) break;
        this.previews.delete(oldest);
      }
    }
    return result;
  }

  private require(name: string): StoredPlugin {
    const plugin = this.plugins[name];
    if (!plugin) throw new PluginError(`There is no plugin named ${name}.`);
    return plugin;
  }

  private async afterChange(): Promise<void> {
    await this.write();
    this.problem = undefined;
    await this.options.onChange?.().catch(() => undefined);
  }

  private async write(): Promise<void> {
    const file: StoredFile = { version: 1, plugins: this.plugins };
    await writeFileAtomic(this.options.statePath, `${JSON.stringify(file, null, 2)}\n`);
    await chmod(this.options.statePath, 0o600).catch(() => undefined);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(work);
    this.queue = run;
    return run;
  }
}

export function isPluginError(error: unknown): boolean {
  return error instanceof PluginError || error instanceof SkillError;
}

function parseSource(text: string): ParsedSource {
  const trimmed = text.trim();
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(1)) : trimmed;
  if (isAbsolute(expanded)) return { kind: "local", path: resolve(expanded) };
  const source = parseGithubSkillSource(trimmed);
  if ("problem" in source) {
    throw new PluginError(`${source.problem} A folder on this computer needs its full path.`);
  }
  return { kind: "github", source };
}

/** Where `update` reads the plugin again: its own folder in the source. */
function sourceFor(source: ParsedSource, root: string): string {
  if (source.kind === "local") return root ? join(source.path, ...root.split("/")) : source.path;
  const { owner, repo, ref, path } = source.source;
  const folder = [path, root].filter(Boolean).join("/");
  return `https://github.com/${owner}/${repo}${ref || folder ? `/tree/${ref ?? "HEAD"}${folder ? `/${folder}` : ""}` : ""}`;
}

function effectiveConfig(descriptor: PluginDescriptor, saved: Readonly<Record<string, string>>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const option of descriptor.config) {
    const value = saved[option.key] || option.default;
    if (value !== undefined && value !== "") values[option.key] = value;
  }
  return values;
}

/** Saved values updated with the new ones. Blank new values keep what was saved; unknown keys are dropped. */
function mergeConfig(
  descriptor: PluginDescriptor,
  saved: Readonly<Record<string, string>>,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const option of descriptor.config) {
    const value = values[option.key]?.trim() ? values[option.key] : saved[option.key];
    if (value !== undefined && value !== "") next[option.key] = value;
  }
  return next;
}

/** Regular files under `root`, keyed by their path from it. Links are reported, never followed. */
async function readLocalFolder(root: string): Promise<{ files: Map<string, Uint8Array>; links: Set<string> }> {
  try {
    const info = await lstat(root);
    if (!info.isDirectory()) throw new PluginError("That path is not a folder.");
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError("That folder does not exist.");
  }
  const files = new Map<string, Uint8Array>();
  const links = new Set<string>();
  let bytes = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const key = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        links.add(key);
      } else if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(path, depth + 1);
      } else if (entry.isFile()) {
        if (files.size >= MAX_PLUGIN_FILES) throw new PluginError("The folder has too many files to install.");
        const data = await readFile(path);
        if (data.byteLength > MAX_PLUGIN_FILE_BYTES) continue;
        bytes += data.byteLength;
        if (bytes > MAX_PLUGIN_BYTES) throw new PluginError("The folder is too large to install.");
        files.set(key, data);
      }
    }
  };
  await walk(root, 0);
  return { files, links };
}

function storedPlugin(value: unknown): StoredPlugin | undefined {
  if (!isPlainObject(value) || !isPlainObject(value.descriptor)) return undefined;
  const descriptor = value.descriptor as PluginDescriptor;
  if (typeof descriptor.name !== "string" || !Array.isArray(descriptor.skills)) return undefined;
  const config = isPlainObject(value.config)
    ? Object.fromEntries(
        Object.entries(value.config).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    : {};
  return {
    enabled: value.enabled !== false,
    source: typeof value.source === "string" ? value.source : "",
    installedAt: typeof value.installedAt === "string" ? value.installedAt : new Date(0).toISOString(),
    descriptor: {
      ...descriptor,
      mcpServers: Array.isArray(descriptor.mcpServers) ? descriptor.mcpServers : [],
      prompts: Array.isArray(descriptor.prompts) ? descriptor.prompts : [],
      actions: Array.isArray(descriptor.actions) ? descriptor.actions : [],
      config: Array.isArray(descriptor.config) ? descriptor.config : [],
      ignored: Array.isArray(descriptor.ignored) ? descriptor.ignored : [],
      warnings: Array.isArray(descriptor.warnings) ? descriptor.warnings : [],
    },
    config,
  };
}
