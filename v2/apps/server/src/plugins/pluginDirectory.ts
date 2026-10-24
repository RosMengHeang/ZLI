import type { PluginDirectoryEntry, PluginDirectoryResult } from "@zli-v2/contracts";

import { isPlainObject } from "../browser-tool/browserTool.js";
import { parseGithubSkillSource } from "../skills/githubSource.js";
import { cleanPath } from "./pluginPackage.js";

/** Anthropic's official Claude Code plugin directory. */
export const PLUGIN_DIRECTORY_URL =
  "https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json";
/** Where relative sources in the directory live. */
const DIRECTORY_ROOT = { owner: "anthropics", repo: "claude-plugins-official", ref: "main" };
const DIRECTORY_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_DESCRIPTION = 500;
const MAX_ENTRIES = 2_000;

export const DIRECTORY_UNREACHABLE = "ZLI could not reach the plugin directory. Check your connection and try again.";
const DIRECTORY_INVALID = "The plugin directory could not be read. Try again later.";
const OUTSIDE_GITHUB = "Hosted outside GitHub, so ZLI cannot install it yet.";
const UNKNOWN_SOURCE = "ZLI cannot install this kind of source yet.";
const LSP_ONLY = "It only adds a language server, which ZLI does not use.";

const UPPERCASE_WORDS = new Set(["ai", "api", "aws", "cli", "db", "gp", "lp", "lsp", "mcp", "pr", "sdk", "sql", "ui"]);

/** Turns the directory's marketplace.json into entries, with an install source ZLI accepts where it can. */
export function directoryEntries(catalog: unknown): PluginDirectoryEntry[] {
  if (!isPlainObject(catalog) || !Array.isArray(catalog.plugins)) return [];
  const entries: PluginDirectoryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of catalog.plugins.slice(0, MAX_ENTRIES)) {
    if (!isPlainObject(raw)) continue;
    const name = text(raw.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const author = isPlainObject(raw.author) ? text(raw.author.name) : undefined;
    const category = text(raw.category);
    const homepage = text(raw.homepage);
    const lspOnly =
      raw.lspServers !== undefined &&
      raw.skills === undefined &&
      raw.commands === undefined &&
      raw.mcpServers === undefined;
    const resolved = lspOnly ? { unsupported: LSP_ONLY } : directorySource(raw.source);
    entries.push({
      name,
      title: text(raw.displayName) ?? titleFromName(name),
      description: shorten(text(raw.description) ?? ""),
      ...(author ? { publisher: author } : {}),
      ...(category ? { category } : {}),
      ...(homepage && /^https?:\/\//iu.test(homepage) ? { homepage } : {}),
      ...resolved,
    });
  }
  return entries;
}

/**
 * A GitHub link for one directory source. A commit id wins over a branch or tag, so the person gets the
 * version the directory lists.
 */
export function directorySource(source: unknown): { source: string } | { unsupported: string } {
  if (typeof source === "string") {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(source)) {
      const repo = githubRepo(source);
      return repo ? githubLink(repo.owner, repo.repo, undefined, "") : { unsupported: OUTSIDE_GITHUB };
    }
    const path = cleanPath(source);
    if (!path) return { unsupported: UNKNOWN_SOURCE };
    return githubLink(DIRECTORY_ROOT.owner, DIRECTORY_ROOT.repo, DIRECTORY_ROOT.ref, path);
  }
  if (!isPlainObject(source)) return { unsupported: UNKNOWN_SOURCE };
  const kind = text(source.source);
  const ref = text(source.sha) ?? text(source.ref);
  const rawPath = text(source.path);
  const path = rawPath === undefined ? "" : cleanPath(rawPath);
  if (path === undefined) return { unsupported: UNKNOWN_SOURCE };
  if (kind === "github") {
    const match = /^([\w.-]+)\/([\w.-]+)$/u.exec(text(source.repo) ?? "");
    if (!match?.[1] || !match[2]) return { unsupported: UNKNOWN_SOURCE };
    return githubLink(match[1], match[2].replace(/\.git$/u, ""), ref, path);
  }
  if (kind === "url" || kind === "git-subdir" || kind === "git") {
    const url = text(source.url);
    if (!url) return { unsupported: UNKNOWN_SOURCE };
    const repo = githubRepo(url);
    return repo ? githubLink(repo.owner, repo.repo, ref, path) : { unsupported: OUTSIDE_GITHUB };
  }
  return { unsupported: UNKNOWN_SOURCE };
}

function githubRepo(url: string): { owner: string; repo: string } | undefined {
  const match = /^(?:https?|git):\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/iu.exec(url.trim());
  return match?.[1] && match[2] ? { owner: match[1], repo: match[2] } : undefined;
}

/** The link, after checking it reads back as the same repository, ref, and folder. */
function githubLink(
  owner: string,
  repo: string,
  ref: string | undefined,
  path: string,
): { source: string } | { unsupported: string } {
  const link = `https://github.com/${owner}/${repo}/tree/${ref ?? "HEAD"}${path ? `/${path}` : ""}`;
  const parsed = parseGithubSkillSource(link);
  if ("problem" in parsed || parsed.ref !== (ref ?? "HEAD") || parsed.path !== path) {
    return { unsupported: UNKNOWN_SOURCE };
  }
  return { source: link };
}

/** Keeps Anthropic's directory for an hour, and the last good copy when a later fetch fails. */
export class PluginDirectory {
  private cache: { at: number; result: PluginDirectoryResult } | undefined;
  private pending: Promise<PluginDirectoryResult> | undefined;

  constructor(private readonly options: { fetch?: typeof fetch; now?: () => number; url?: string } = {}) {}

  get(): Promise<PluginDirectoryResult> {
    const now = this.now();
    if (this.cache && now - this.cache.at < DIRECTORY_TTL_MS) return Promise.resolve(this.cache.result);
    this.pending ??= this.load().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** Install sources from the last copy fetched, without fetching. */
  knownSources(): string[] {
    return (this.cache?.result.entries ?? []).flatMap((entry) => (entry.source ? [entry.source] : []));
  }

  private async load(): Promise<PluginDirectoryResult> {
    const now = this.now();
    const failed = (problem: string): PluginDirectoryResult => ({
      entries: this.cache?.result.entries ?? [],
      fetchedAt: this.cache?.result.fetchedAt ?? new Date(now).toISOString(),
      problem,
    });
    let body: unknown;
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.url ?? PLUGIN_DIRECTORY_URL, {
        headers: { Accept: "application/json", "User-Agent": "ZLI" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return failed(DIRECTORY_UNREACHABLE);
      body = JSON.parse((await response.text()).replace(/^\uFEFF/u, ""));
    } catch (error) {
      return failed(error instanceof SyntaxError ? DIRECTORY_INVALID : DIRECTORY_UNREACHABLE);
    }
    if (!isPlainObject(body) || !Array.isArray(body.plugins)) return failed(DIRECTORY_INVALID);
    const result: PluginDirectoryResult = { entries: directoryEntries(body), fetchedAt: new Date(now).toISOString() };
    this.cache = { at: now, result };
    return result;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

function titleFromName(name: string): string {
  return name
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((word) =>
      UPPERCASE_WORDS.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

function shorten(value: string): string {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…` : flat;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
