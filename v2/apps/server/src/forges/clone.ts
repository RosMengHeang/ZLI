import { mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { ForgeKind } from "@zli-v2/contracts";

import { type ProcessRunner, redactSecrets, runProcess } from "../review/PullRequestService.js";
import { readTeaHosts, remoteHost } from "./remotes.js";

const CLONE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_HOSTS: Record<ForgeKind, string> = { github: "github.com", gitlab: "gitlab.com", gitea: "codeberg.org" };

/** Thrown with a message the person can act on. */
export class CloneError extends Error {}

/** What to clone and the folder name it gets. */
export type CloneTarget = { url: string; name: string };

/** The repository path in a forge page link, without the page part: /o/r/tree/main → o/r. */
function repositoryPath(host: string, path: string): string | undefined {
  const parts = path
    .replace(/\.git$/u, "")
    .split("/")
    .filter(Boolean);
  // GitLab puts its pages after /-/ and allows groups and subgroups before the project.
  const dash = parts.indexOf("-");
  if (dash > 0) return parts.slice(0, dash).join("/");
  if (host.startsWith("gitlab.") || host === "gitlab.com") return parts.length >= 2 ? parts.join("/") : undefined;
  return parts.length >= 2 ? parts.slice(0, 2).join("/") : undefined;
}

/**
 * Reads what the person pasted: a clone URL (https or SSH), a link copied from a forge page, or owner/repo with
 * a forge picked. Answers with the URL git clones and the folder name.
 */
export async function cloneTarget(
  source: string,
  forge: ForgeKind | undefined,
  teaHosts: () => Promise<readonly string[]> = readTeaHosts,
): Promise<CloneTarget> {
  const value = source.trim();
  if (!value || /\s/u.test(value) || value.startsWith("-"))
    throw new CloneError("Paste a repository URL or owner/repo.");
  const nameOf = (path: string) =>
    path
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.git$/u, "") ?? "";

  // SSH: git@host:owner/repo.git, kept as it is so git uses the person's key.
  const ssh = /^[\w.-]+@([\w.-]+):(.+)$/u.exec(value);
  if (ssh?.[2]) return { url: value, name: nameOf(ssh[2]) };

  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new CloneError("That link isn't a valid URL.");
    }
    if (url.protocol === "ssh:" || url.protocol === "git:") return { url: value, name: nameOf(url.pathname) };
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new CloneError("Clone over https or SSH.");
    const host = remoteHost(value) ?? url.hostname;
    const path = repositoryPath(host, url.pathname);
    if (!path) throw new CloneError("That link doesn't point to a repository.");
    return { url: `${url.protocol}//${url.host}/${path}.git`, name: nameOf(path) };
  }

  if (/^[\w.-]+\/[\w./-]+$/u.test(value)) {
    if (!forge) throw new CloneError("Pick the forge owner/repo is on, or paste the full URL.");
    const host = forge === "gitea" ? ((await teaHosts())[0] ?? DEFAULT_HOSTS.gitea) : DEFAULT_HOSTS[forge];
    const path = value.replace(/\.git$/u, "");
    return { url: `https://${host}/${path}.git`, name: nameOf(path) };
  }
  throw new CloneError("Paste a repository URL or owner/repo.");
}

/** Clones into parent/name and answers with the new folder. The folder must not exist yet, or be empty. */
export async function cloneRepository(
  request: { source: string; forge?: ForgeKind | undefined; parent: string; name?: string | undefined },
  runner: ProcessRunner = runProcess,
  teaHosts?: () => Promise<readonly string[]>,
): Promise<{ path: string }> {
  if (!isAbsolute(request.parent)) throw new CloneError("Choose the folder to clone into.");
  const target = await cloneTarget(request.source, request.forge, teaHosts);
  // Windows silently drops trailing dots and spaces, so the folder would not be where ZLI looks for it.
  const name = (request.name?.trim() || target.name).replace(/[\\/:*?"<>|]/gu, "-").replace(/[. ]+$/u, "");
  if (!name || name === "." || name === "..") throw new CloneError("Give the folder a name.");
  const path = join(request.parent, name);
  const existing = await readdir(path).catch(() => undefined);
  if (existing && existing.length > 0)
    throw new CloneError(`${path} already exists and isn't empty. Pick another name.`);
  await mkdir(request.parent, { recursive: true });
  const cloned = await runner("git", ["clone", "--", target.url, path], {
    cwd: request.parent,
    timeoutMs: CLONE_TIMEOUT_MS,
  });
  if (cloned.code !== 0) {
    const said = redactSecrets(cloned.stderr.trim()).split(/\r?\n/u).slice(-3).join(" ");
    throw new CloneError(`git couldn't clone ${target.url}${said ? `: ${said}` : "."}`);
  }
  return { path };
}
