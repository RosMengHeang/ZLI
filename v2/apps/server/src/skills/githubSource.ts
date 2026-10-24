import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";

import { SKILL_FILE, skillNameProblem } from "@zli-v2/contracts";

import { MAX_SKILL_BYTES, MAX_SKILL_FILE_BYTES, MAX_SKILL_FILES, SkillError } from "./skillFolders.js";
import { parseSkillMarkdown } from "./skillMarkdown.js";
import { TarReader } from "./tar.js";

export type GithubSkillSource = { owner: string; repo: string; ref?: string; path: string };

export type RemoteSkill = {
  name: string;
  description: string;
  path: string;
  bytes: number;
  files: Array<{ path: string; data: Uint8Array }>;
  problem?: string;
};

/** Unpacked bytes read from one download, which also bounds a compression bomb. */
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
/** Bytes kept in memory across all skills in one download. */
const MAX_KEPT_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPO = /^[A-Za-z0-9._-]{1,100}$/u;

/**
 * Reads `https://github.com/<owner>/<repo>/tree/<ref>/<path>` (also `blob/` links to a SKILL.md), or
 * `owner/repo` with an optional `/path`. A ref is one path segment; branch names with slashes are not
 * told apart from folders.
 */
export function parseGithubSkillSource(text: string): GithubSkillSource | { problem: string } {
  let rest = text.trim().split(/[?#]/u)[0] ?? "";
  rest = rest.replace(/^https?:\/\//iu, "").replace(/^www\./iu, "");
  if (/^github\.com\//iu.test(rest)) rest = rest.slice("github.com/".length);
  else if (/^[^/]+\.[a-z]{2,}\//iu.test(rest) || text.includes("://")) {
    return { problem: "Only github.com links are supported." };
  }
  let segments: string[];
  try {
    segments = rest.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return { problem: "The link is not a valid address." };
  }
  const [owner = "", rawRepo = "", ...more] = segments;
  const repo = rawRepo.replace(/\.git$/u, "");
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") {
    return { problem: "Use a GitHub link or the form owner/repo." };
  }
  let ref: string | undefined;
  let path = more;
  if (more[0] === "tree" || more[0] === "blob") {
    ref = more[1];
    path = more.slice(2);
    if (!ref) return { problem: "The link names no branch or tag." };
    if (more[0] === "blob") path = path.slice(0, -1);
  }
  if (path.at(-1) === SKILL_FILE) path = path.slice(0, -1);
  if (ref !== undefined && (/[\s~^:?*[\\]/u.test(ref) || ref.includes(".."))) {
    return { problem: "The branch or tag name is not valid." };
  }
  if (path.some((segment) => segment === "." || segment === ".." || unsafeSegment(segment))) {
    return { problem: "The folder in the link is not valid." };
  }
  return { owner, repo, ...(ref ? { ref } : {}), path: path.join("/") };
}

export function sourceKey(source: GithubSkillSource): string {
  return `${source.owner}/${source.repo}@${source.ref ?? ""}:${source.path}`.toLowerCase();
}

export type GithubDownload = {
  files: Map<string, Uint8Array>;
  links: Set<string>;
  oversized: Set<string>;
};

/**
 * Downloads the repository tarball from GitHub and returns each folder under `source.path` that holds
 * a SKILL.md. A folder inside another skill belongs to that skill. Links and unsafe names are left out.
 */
export async function fetchGithubSkills(
  source: GithubSkillSource,
  options: { fetch?: typeof fetch; token?: string | undefined } = {},
): Promise<RemoteSkill[]> {
  const download = await downloadGithubFiles(source, options);
  return skillsFromFiles(download.files, { links: download.links, oversized: download.oversized, repo: source.repo });
}

/**
 * Downloads the repository tarball and keeps the regular files under `source.path`, keyed by their path
 * from the repository root. Links are reported, never kept.
 */
export async function downloadGithubFiles(
  source: GithubSkillSource,
  options: {
    fetch?: typeof fetch;
    token?: string | undefined;
    maxFileBytes?: number;
    maxKeptBytes?: number;
  } = {},
): Promise<GithubDownload> {
  const maxFileBytes = options.maxFileBytes ?? MAX_SKILL_FILE_BYTES * 4;
  const maxKeptBytes = options.maxKeptBytes ?? MAX_KEPT_BYTES;  const fetchImpl = options.fetch ?? fetch;
  const ref = source.ref ? `/${source.ref.split("/").map(encodeURIComponent).join("/")}` : "";
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/tarball${ref}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ZLI",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SkillError(`GitHub could not be reached. ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 404) {
    throw new SkillError(
      "GitHub has no repository, branch, or tag at that address. Private repositories need GH_TOKEN set before ZLI starts.",
    );
  }
  if (response.status === 403 || response.status === 429) {
    throw new SkillError("GitHub refused the download, likely a rate limit. Try again later or set GH_TOKEN.");
  }
  if (!response.ok || !response.body) throw new SkillError(`GitHub answered ${response.status}.`);

  const files = new Map<string, Uint8Array>();
  const links = new Set<string>();
  const oversized = new Set<string>();
  let kept = 0;
  let unpacked = 0;
  const inScope = (path: string): string | undefined => {
    const relativePath = path.split("/").slice(1).join("/").replace(/\/$/u, "");
    if (!relativePath) return undefined;
    if (!source.path) return relativePath;
    return relativePath === source.path || relativePath.startsWith(`${source.path}/`) ? relativePath : undefined;
  };
  const reader = new TarReader({
    keep: (path, size) => {
      const relativePath = inScope(path);
      if (relativePath === undefined) return false;
      if (size > maxFileBytes) {
        oversized.add(relativePath);
        return false;
      }
      kept += size;
      if (kept > maxKeptBytes) throw new SkillError("The folder is too large to install. Link to a smaller folder.");
      return true;
    },
    onEntry: (entry) => {
      const relativePath = inScope(entry.path);
      if (relativePath === undefined) return;
      if (entry.type === "link") links.add(relativePath);
      else if (entry.type === "file" && entry.data) files.set(relativePath, entry.data);
    },
  });
  const gunzip = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>).pipe(createGunzip());
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      unpacked += chunk.length;
      if (unpacked > MAX_UNPACKED_BYTES) throw new SkillError("The repository is too large to download.");
      reader.push(chunk);
      if (reader.done) break;
    }
  } catch (error) {
    if (error instanceof SkillError) throw error;
    throw new SkillError(`The download could not be read. ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    gunzip.destroy();
  }
  return { files, links, oversized };
}

/** Groups downloaded files into skills. Exported for tests. */
export function skillsFromFiles(
  files: ReadonlyMap<string, Uint8Array>,
  extra: { links?: ReadonlySet<string>; oversized?: ReadonlySet<string>; repo: string },
): RemoteSkill[] {
  const dirs = [...files.keys()]
    .filter((path) => path === SKILL_FILE || path.endsWith(`/${SKILL_FILE}`))
    .map((path) => path.slice(0, -SKILL_FILE.length).replace(/\/$/u, ""))
    .sort((left, right) => depth(left) - depth(right) || left.localeCompare(right));
  const roots: string[] = [];
  for (const dir of dirs) if (!roots.some((root) => within(dir, root))) roots.push(dir);

  const seen = new Set<string>();
  return roots.map((dir) => {
    const members = [...files.entries()].filter(([path]) => within(path, dir) && path !== dir);
    const local = members.map(([path, data]) => ({ path: dir ? path.slice(dir.length + 1) : path, data }));
    const bytes = local.reduce((total, file) => total + file.data.byteLength, 0);
    const skillMd = local.find((file) => file.path === SKILL_FILE);
    const parsed = parseSkillMarkdown(Buffer.from(skillMd?.data ?? new Uint8Array()).toString("utf8"));
    const folder = dir.split("/").at(-1) || extra.repo.toLowerCase();
    const name = parsed.name ?? folder;
    const hasLinks = [...(extra.links ?? [])].some((path) => within(path, dir));
    const hasOversized = [...(extra.oversized ?? [])].some((path) => within(path, dir));
    let problem: string | undefined;
    const nameProblem = skillNameProblem(name);
    if (!parsed.hasFrontmatter) problem = "SKILL.md has no frontmatter with a name and description.";
    else if (nameProblem) problem = `The name ${name} does not fit the skill naming rule. ${nameProblem}`;
    else if (!parsed.description) problem = "SKILL.md has no description.";
    else if (seen.has(name)) problem = "Another folder in this repository uses the same name.";
    else if (local.some((file) => file.path.split("/").some((part) => unsafeSegment(part) || part === ".."))) {
      problem = "It has file names that are not safe to copy.";
    } else if (hasOversized || local.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) {
      problem = "It is too large to install.";
    } else if (hasLinks) problem = "It contains symbolic links, which ZLI does not install.";
    seen.add(name);
    return {
      name,
      description: parsed.description ?? "",
      path: dir || ".",
      bytes,
      files: local,
      ...(problem ? { problem } : {}),
    };
  });
}

/** Characters Windows cannot hold in a file name, and control characters. */
export function unsafeSegment(segment: string): boolean {
  return [...segment].some((char) => char.charCodeAt(0) < 32 || '\\:*?"<>|'.includes(char));
}

function depth(path: string): number {
  return path ? path.split("/").length : 0;
}

function within(path: string, dir: string): boolean {
  return dir === "" || path === dir || path.startsWith(`${dir}/`);
}
