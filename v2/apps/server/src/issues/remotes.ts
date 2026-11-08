import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { IssueListUnavailable } from "@zli-v2/contracts";

import type { ProcessRunner } from "../review/PullRequestService.js";

const GIT_TIMEOUT_MS = 60_000;

/** github.com and gitlab.com answer on these names too. */
const GITHUB_HOSTS = new Set(["github.com", "www.github.com", "ssh.github.com"]);
const GITLAB_HOSTS = new Set(["gitlab.com", "www.gitlab.com", "altssh.gitlab.com"]);

export type Forge = "github" | "gitlab";

/** Where a project's issues live, as its Git remotes tell it. */
export type ProjectRemotes =
  | { unavailable: IssueListUnavailable }
  | {
      unavailable?: undefined;
      /** Origin's forge first. */
      sources: Forge[];
      /** The host of the first remote on each forge. */
      hosts: Partial<Record<Forge, string>>;
      /** Origin's host, or the first remote's. */
      host?: string;
    };

/** Hosts each CLI is signed in to, beyond github.com and gitlab.com. */
export type KnownHosts = { github(): Promise<readonly string[]>; gitlab(): Promise<readonly string[]> };

export const CLI_HOSTS: KnownHosts = { github: () => readGhHosts(), gitlab: () => readGlabHosts() };

type GitRemote = { name: string; host?: string };

/** Reads the remotes without running gh or glab, so a project hosted elsewhere never shows a CLI problem. */
export async function readProjectRemotes(
  runner: ProcessRunner,
  cwd: string,
  known: KnownHosts = CLI_HOSTS,
): Promise<ProjectRemotes> {
  const result = await runner("git", ["remote", "-v"], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (result.code !== 0) {
    return { unavailable: { code: /not a git repository/iu.test(result.stderr) ? "not_repo" : "no_remote" } };
  }
  const remotes = parseRemotes(result.stdout);
  if (remotes.length === 0) return { unavailable: { code: "no_remote" } };
  const ordered = [
    ...remotes.filter((remote) => remote.name === "origin"),
    ...remotes.filter((remote) => remote.name !== "origin"),
  ];
  const host = ordered[0]?.host;
  const needsConfig = ordered.some((remote) => remote.host?.includes(".") && !wellKnownForge(remote.host));
  const [github, gitlab] = needsConfig
    ? await Promise.all([known.github(), known.gitlab()]).then((lists) =>
        lists.map((list) => new Set(list.map((entry) => entry.toLowerCase()))),
      )
    : [new Set<string>(), new Set<string>()];
  const sources: Forge[] = [];
  const hosts: Partial<Record<Forge, string>> = {};
  for (const remote of ordered) {
    const forge = remote.host ? forgeOf(remote.host, github ?? new Set(), gitlab ?? new Set()) : undefined;
    if (!forge || !remote.host) continue;
    if (!sources.includes(forge)) sources.push(forge);
    hosts[forge] ??= remote.host;
  }
  // Local paths and SSH aliases, which gh resolves through the SSH config, have no host ZLI can judge,
  // so gh decides for them when no other remote names a forge.
  if (sources.length === 0 && ordered.some((remote) => !remote.host?.includes("."))) sources.push("github");
  if (sources.length === 0) return { unavailable: { code: "other_host", ...(host ? { host } : {}) } };
  return { sources, hosts, ...(host ? { host } : {}) };
}

function wellKnownForge(host: string): boolean {
  return GITHUB_HOSTS.has(host) || host.endsWith(".ghe.com") || GITLAB_HOSTS.has(host);
}

function forgeOf(host: string, github: ReadonlySet<string>, gitlab: ReadonlySet<string>): Forge | undefined {
  if (!host.includes(".")) return undefined;
  if (GITHUB_HOSTS.has(host) || host.endsWith(".ghe.com") || github.has(host)) return "github";
  // A self-hosted GitLab glab is not signed in to yet is still GitLab when its name says so, so the
  // person is told to sign in rather than that ZLI cannot read it.
  if (GITLAB_HOSTS.has(host) || gitlab.has(host) || host.startsWith("gitlab.")) return "gitlab";
  return undefined;
}

/** Reads `git remote -v`, one entry per fetch and push URL. */
function parseRemotes(stdout: string): GitRemote[] {
  return stdout.split(/\r?\n/u).flatMap((line) => {
    const match = /^(\S+)\s+(.+?)(?:\s+\((?:fetch|push)\))?$/u.exec(line.trim());
    if (!match?.[1] || !match[2]) return [];
    const host = remoteHost(match[2]);
    return [{ name: match[1], ...(host ? { host } : {}) }];
  });
}

/** The host of a Git remote URL, or undefined for a local path. */
export function remoteHost(url: string): string | undefined {
  const value = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(value)?.[1];
  if (scheme) {
    if (scheme.toLowerCase() === "file") return undefined;
    try {
      return new URL(value).hostname.toLowerCase() || undefined;
    } catch {
      return undefined;
    }
  }
  // Git reads user@host:path as SSH when the colon comes before any slash; one letter is a Windows drive.
  const host = /^(?:[^@/\\]+@)?([^:/\\]+):/u.exec(value)?.[1];
  return host && host.length > 1 ? host.toLowerCase() : undefined;
}

const YAML_KEY = /^["']?([^\s"'#:][^"':]*)["']?:\s*$/u;

/** Hosts the GitHub CLI is signed in to, from GH_HOST and its hosts.yml. */
export async function readGhHosts(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const hosts = env.GH_HOST ? [env.GH_HOST] : [];
  try {
    const text = await readFile(join(ghConfigDir(env), "hosts.yml"), "utf8");
    for (const line of text.split(/\r?\n/u)) {
      const key = YAML_KEY.exec(line)?.[1];
      if (key) hosts.push(key);
    }
  } catch {
    // Without a hosts file gh knows only github.com.
  }
  return hosts;
}

function ghConfigDir(env: NodeJS.ProcessEnv): string {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "gh");
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "GitHub CLI");
  return join(homedir(), ".config", "gh");
}

/** Hosts the GitLab CLI is signed in to, from GITLAB_HOST, GL_HOST, and the hosts in its config.yml. */
export async function readGlabHosts(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  // These may be a URL such as https://gitlab.example.com as well as a bare host.
  const hosts = [env.GITLAB_HOST, env.GL_HOST].flatMap((value) =>
    value?.trim() ? [remoteHost(value) ?? value.trim()] : [],
  );
  try {
    const text = await readFile(join(glabConfigDir(env), "config.yml"), "utf8");
    let inHosts = false;
    let indent: number | undefined;
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const depth = line.length - line.trimStart().length;
      if (depth === 0) {
        inHosts = /^hosts:\s*$/u.test(trimmed);
        indent = undefined;
        continue;
      }
      if (!inHosts) continue;
      indent ??= depth;
      const key = depth === indent ? YAML_KEY.exec(trimmed)?.[1] : undefined;
      if (key) hosts.push(key);
    }
  } catch {
    // Without a config file glab knows only gitlab.com.
  }
  return hosts;
}

function glabConfigDir(env: NodeJS.ProcessEnv): string {
  if (env.GLAB_CONFIG_DIR) return env.GLAB_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "glab-cli");
  return join(homedir(), ".config", "glab-cli");
}
