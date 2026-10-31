import type { Dirent } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  type McpServerConfig,
  PLUGIN_CATALOG,
  type PluginContributions,
  type PluginDirectoryResult,
  type PluginExportResult,
  type PluginInstallPreview,
  type PluginListResult,
  PluginOrigin,
  type PluginSummary,
} from "@zli-v2/contracts";

import { isPlainObject, writeFileAtomic } from "../browser-tool/browserTool.js";
import {
  downloadGithubFiles,
  GithubRateLimitError,
  type GithubSkillSource,
  isCommitSha,
  latestGithubCommit,
  parseGithubSkillSource,
  sourceKey,
} from "../skills/githubSource.js";
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
import { exportPlugin, type PluginExportRequest, type PluginExportSources } from "./exportPlugin.js";
import { PluginDirectory } from "./pluginDirectory.js";

type StoredPlugin = {
  enabled: boolean;
  source: string;
  installedAt: string;
  descriptor: PluginDescriptor;
  config: Record<string, string>;
  /** For GitHub plugins: the newest commit that touched the plugin's folder when it was installed. */
  commit?: string;
  /** The branch, tag, or commit the source asked for. */
  ref?: string;
  origin?: PluginOrigin;
};

type InstallMeta = Pick<StoredPlugin, "commit" | "ref" | "origin">;

type StoredFile = { version: 1; plugins: Record<string, StoredPlugin> };

type ParsedSource = { kind: "github"; source: GithubSkillSource } | { kind: "local"; path: string };

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_CACHED_PREVIEWS = 3;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);
const MAX_DEPTH = 20;
const UPDATE_CHECK_TTL_MS = 30 * 60 * 1000;
const UPDATE_CHECK_LIMITED = "GitHub limited update checks. Try again later.";
const CATALOG_KEYS = PLUGIN_CATALOG.flatMap((entry) => {
  const key = matchKey(entry.source);
  return key ? [key] : [];
});

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
  /** Agent skills folders where a same-named skill the person already had kept a plugin skill out. */
  skillConflicts?: (name: string) => readonly string[];
  /** Runs after a change so the agents ZLI starts pick it up. */
  onChange?: () => Promise<void>;
  /** The person's skills and MCP servers, for exporting them as a plugin. */
  exportSources?: PluginExportSources;
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
  /** The newest commit GitHub reported for each plugin's folder, and when. */
  private readonly updateChecks = new Map<string, { at: number; latest: string }>();
  /** Newer sources Anthropic's directory lists for pinned plugins installed from it, by plugin name. */
  private readonly directoryMoves = new Map<string, string>();
  private readonly pluginDirectory: PluginDirectory;

  constructor(private readonly options: PluginStoreOptions) {
    this.pluginDirectory = new PluginDirectory({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

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
              continue;
            }
            for (const path of this.options.skillConflicts?.(skill.name) ?? []) {
              problems.push(`Skill ${skill.name} is not copied to ${path}: a skill with that name is already there.`);
            }
          }
        }
        problems.push(...descriptor.warnings);
        const github = githubSourceOf(plugin.source);
        const pinned = github ? isCommitSha(github.ref) : false;
        const check = this.updateChecks.get(name);
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
          origin: this.originOf(plugin),
          sourceKind: github ? "github" : "local",
          ...(plugin.commit ? { commit: plugin.commit } : {}),
          ...(pinned ? { pinned } : {}),
          ...(github && check
            ? {
                ...(plugin.commit ? { updateAvailable: !pinned && check.latest !== plugin.commit } : {}),
                checkedAt: new Date(check.at).toISOString(),
              }
            : {}),
          ...(this.directoryMoves.has(name) ? { updateAvailable: true } : {}),
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

  /**
   * `origin` is the list the person picked the plugin from. A claim to come from Anthropic's directory is
   * kept only when the directory lists the source.
   */
  install(
    text: string,
    names: readonly string[],
    config: Readonly<Record<string, Readonly<Record<string, string>>>> = {},
    origin?: PluginOrigin,
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
      if (origin === "anthropic-directory") await this.pluginDirectory.get();
      const placed = await Promise.all(
        chosen.map(async (candidate) => {
          const stored = sourceFor(source, candidate.root);
          return {
            candidate,
            stored,
            meta: { ...(await this.commitOf(source, candidate.root)), origin: this.matchOrigin(stored) },
          };
        }),
      );
      for (const { candidate, stored, meta } of placed) {
        await this.place(candidate, stored, config[candidate.descriptor.name] ?? {}, meta);
      }
      await this.afterChange();
      return chosen.map((candidate) => candidate.descriptor.name);
    });
  }

  update(name: string): Promise<void> {
    return this.serialize(async () => {
      const plugin = this.require(name);
      const moved = this.directoryMoves.get(name);
      const text = moved ?? plugin.source;
      const source = parseSource(text);
      const { scan } = await this.scan(source, false);
      const candidate =
        scan.candidates.find((entry) => entry.descriptor.name === name) ??
        (scan.candidates.length === 1 ? scan.candidates[0] : undefined);
      if (!candidate) throw new PluginError(`${text} no longer has the plugin ${name}.`);
      if (candidate.problem) throw new PluginError(candidate.problem);
      if (candidate.descriptor.name !== name) {
        throw new PluginError(`${text} now holds ${candidate.descriptor.name}. Install it as a new plugin.`);
      }
      const origin = moved ? "anthropic-directory" : plugin.origin;
      const meta = {
        ...(await this.commitOf(source, candidate.root)),
        ...(origin ? { origin } : {}),
      };
      await this.place(candidate, moved ? sourceFor(source, candidate.root) : plugin.source, {}, meta);
      await this.afterChange();
    });
  }

  /**
   * Asks GitHub for the newest commit in each GitHub plugin's folder, at most once every 30 minutes per
   * plugin. Plugins installed from a fixed commit are never asked about, but those from Anthropic's
   * directory are compared with the commit the directory lists now.
   */
  async checkUpdates(): Promise<PluginListResult> {
    const now = (this.options.now ?? Date.now)();
    let limited = false;
    await Promise.all(
      Object.entries(this.plugins).map(async ([name, plugin]) => {
        const source = githubSourceOf(plugin.source);
        if (!source) return;
        const cached = this.updateChecks.get(name);
        if (cached && now - cached.at < UPDATE_CHECK_TTL_MS) return;
        if (isCommitSha(source.ref)) {
          this.updateChecks.set(name, { at: now, latest: plugin.commit ?? (source.ref ?? "").toLowerCase() });
          return;
        }
        try {
          const latest = await latestGithubCommit(source, this.githubOptions());
          if (latest && this.plugins[name] === plugin) this.updateChecks.set(name, { at: now, latest });
        } catch (error) {
          if (!(error instanceof GithubRateLimitError)) throw error;
          limited = true;
        }
      }),
    );
    await this.checkDirectoryMoves();
    const list = await this.list();
    return limited && !list.problem ? { ...list, problem: UPDATE_CHECK_LIMITED } : list;
  }

  private async checkDirectoryMoves(): Promise<void> {
    const pinned = Object.entries(this.plugins).filter(([, plugin]) => {
      const source = githubSourceOf(plugin.source);
      return source !== undefined && isCommitSha(source.ref) && this.originOf(plugin) === "anthropic-directory";
    });
    if (pinned.length === 0) return;
    const { entries } = await this.pluginDirectory.get();
    if (entries.length === 0) return;
    for (const [name, plugin] of pinned) {
      const listed = entries.find((entry) => entry.name === name)?.source;
      if (listed && listed.toLowerCase() !== plugin.source.toLowerCase() && this.plugins[name] === plugin) {
        this.directoryMoves.set(name, listed);
      } else {
        this.directoryMoves.delete(name);
      }
    }
  }

  /** Anthropic's plugin directory, fetched at most once an hour. */
  directory(): Promise<PluginDirectoryResult> {
    return this.pluginDirectory.get();
  }

  exportPlugin(request: PluginExportRequest): Promise<PluginExportResult> {
    const sources = this.options.exportSources;
    if (!sources) return Promise.reject(new PluginError("Exporting plugins is not available here."));
    return exportPlugin(request, sources);
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
      this.updateChecks.delete(name);
      this.directoryMoves.delete(name);
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

  private async place(
    candidate: PluginPackage,
    source: string,
    values: Readonly<Record<string, string>>,
    meta: InstallMeta,
  ) {
    const name = candidate.descriptor.name;
    const previous = this.plugins[name];
    await replaceFolder(this.folder(name), (temp) => writeSkillFiles(temp, candidate.files));
    await mkdir(join(this.options.dataDir, name), { recursive: true });
    this.updateChecks.delete(name);
    this.directoryMoves.delete(name);
    this.plugins[name] = {
      enabled: previous?.enabled ?? true,
      source,
      installedAt: new Date((this.options.now ?? Date.now)()).toISOString(),
      descriptor: candidate.descriptor,
      config: mergeConfig(candidate.descriptor, previous?.config ?? {}, values),
      ...(meta.commit ? { commit: meta.commit } : {}),
      ...(meta.ref ? { ref: meta.ref } : {}),
      ...(meta.origin ? { origin: meta.origin } : {}),
    };
  }

  /** The commit a GitHub plugin's folder is at. Not finding it never stops an install. */
  private async commitOf(source: ParsedSource, root: string): Promise<Pick<StoredPlugin, "commit" | "ref">> {
    if (source.kind !== "github") return {};
    const { ref } = source.source;
    if (isCommitSha(ref)) return { commit: (ref ?? "").toLowerCase(), ...(ref ? { ref } : {}) };
    const path = [source.source.path, root].filter(Boolean).join("/");
    const commit = await latestGithubCommit({ ...source.source, path }, this.githubOptions()).catch(() => undefined);
    return { ...(commit ? { commit } : {}), ...(ref ? { ref } : {}) };
  }

  private githubOptions(): { fetch?: typeof fetch; token?: string | undefined } {
    return { ...(this.options.fetch ? { fetch: this.options.fetch } : {}), token: this.options.githubToken };
  }

  /** ZLI's own list wins, then Anthropic's directory, by owner, repository, and folder. */
  private matchOrigin(source: string): PluginOrigin {
    const key = matchKey(source);
    if (!key) return "other";
    if (CATALOG_KEYS.some((base) => within(key, base))) return "zli-catalog";
    const listed = this.pluginDirectory.knownSources().some((entry) => {
      const base = matchKey(entry);
      return base !== undefined && within(key, base);
    });
    return listed ? "anthropic-directory" : "other";
  }

  private originOf(plugin: StoredPlugin): PluginOrigin {
    const matched = this.matchOrigin(plugin.source);
    if (matched !== "other") return matched;
    return plugin.origin === "anthropic-directory" ? plugin.origin : "other";
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

function githubSourceOf(text: string): GithubSkillSource | undefined {
  try {
    const source = parseSource(text);
    return source.kind === "github" ? source.source : undefined;
  } catch {
    return undefined;
  }
}

/** owner/repo/folder in lowercase, ignoring the ref, for telling where a GitHub plugin came from. */
function matchKey(text: string): string | undefined {
  const source = githubSourceOf(text);
  return source ? `${source.owner}/${source.repo}${source.path ? `/${source.path}` : ""}`.toLowerCase() : undefined;
}

function within(key: string, base: string): boolean {
  return key === base || key.startsWith(`${base}/`);
}

/** Where `update` reads the plugin again: its own folder in the source. */
function sourceFor(source: ParsedSource, root: string): string {
  if (source.kind === "local") return root ? join(source.path, ...root.split("/")) : source.path;
  const { owner, repo, ref, path } = source.source;
  const folder = [path, root].filter(Boolean).join("/");
  return `https://github.com/${owner}/${repo}${ref || folder ? `/tree/${ref ?? "HEAD"}${folder ? `/${folder}` : ""}` : ""}`;
}

function effectiveConfig(
  descriptor: PluginDescriptor,
  saved: Readonly<Record<string, string>>,
): Record<string, string> {
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
  const origin = PluginOrigin.safeParse(value.origin);
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
    ...(typeof value.commit === "string" && isCommitSha(value.commit) ? { commit: value.commit } : {}),
    ...(typeof value.ref === "string" && value.ref ? { ref: value.ref } : {}),
    ...(origin.success ? { origin: origin.data } : {}),
  };
}
