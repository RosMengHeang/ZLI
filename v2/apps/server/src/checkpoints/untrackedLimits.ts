import { opendir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { GitProcess } from "../git/GitProcess.js";

/** How big an untracked file or folder may be before turn snapshots leave it out. */
export type UntrackedLimits = { maxFileBytes: number; maxFolderFiles: number };

/**
 * Build output that is not in .gitignore (a Rust `target/`, a `dist/`) would otherwise be hashed into Git
 * on every agent turn, which once filled a drive with leftover objects.
 */
export const DEFAULT_UNTRACKED_LIMITS: UntrackedLimits = { maxFileBytes: 52_428_800, maxFolderFiles: 5_000 };

const LIST_TIMEOUT_MS = 20_000;

/**
 * Untracked, not ignored paths that are too big to snapshot: files over the size limit, and folders with more
 * files than the folder limit. Paths are relative to `cwd`, with forward slashes and no trailing slash.
 */
export async function oversizedUntracked(
  git: Pick<GitProcess, "run">,
  cwd: string,
  limits: UntrackedLimits,
): Promise<string[]> {
  const listed = await git.run(["ls-files", "--others", "--exclude-standard", "--directory", "-z"], {
    cwd,
    timeoutMs: LIST_TIMEOUT_MS,
  });
  const found: string[] = [];
  for (const entry of listed.stdout.split("\0")) {
    if (!entry) continue;
    try {
      if (entry.endsWith("/")) {
        const folder = entry.slice(0, -1);
        const scan = await scanFolder(join(cwd, folder), limits);
        if (scan.tooMany) found.push(folder);
        else for (const file of scan.bigFiles) found.push(`${folder}/${file}`);
      } else if ((await stat(join(cwd, entry))).size > limits.maxFileBytes) {
        found.push(entry);
      }
    } catch {
      // A path that vanished or cannot be read is left to git add, as before.
    }
  }
  return found.sort();
}

/** Counts files under `root` without following links, stopping once there are more than the folder limit. */
async function scanFolder(root: string, limits: UntrackedLimits): Promise<{ tooMany: boolean; bigFiles: string[] }> {
  const bigFiles: string[] = [];
  let count = 0;
  const pending: string[] = [""];
  while (pending.length > 0) {
    const relative = pending.pop() as string;
    for await (const item of await opendir(join(root, relative))) {
      const path = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!item.isFile()) continue;
      count += 1;
      if (count > limits.maxFolderFiles) return { tooMany: true, bigFiles: [] };
      if ((await stat(join(root, path))).size > limits.maxFileBytes) bigFiles.push(path);
    }
  }
  return { tooMany: false, bigFiles };
}

const TEMP_OBJECTS_MIN_AGE_MS = 600_000;

/**
 * Removes `tmp_objdir*` folders a killed `git add` left in a Git objects folder. Only folders older than
 * `minAgeMs` go, so a Git command still running elsewhere keeps its own. Returns how many went; never throws.
 */
export async function sweepTempObjects(
  objectsDir: string,
  now: number,
  minAgeMs = TEMP_OBJECTS_MIN_AGE_MS,
): Promise<number> {
  let removed = 0;
  try {
    for (const name of await readdir(objectsDir)) {
      if (!name.startsWith("tmp_objdir")) continue;
      try {
        const path = join(objectsDir, name);
        if (now - (await stat(path)).mtimeMs <= minAgeMs) continue;
        await rm(path, { recursive: true, force: true });
        removed += 1;
      } catch {
        // Another process may be removing it too.
      }
    }
  } catch {
    // No objects folder, or it cannot be read.
  }
  return removed;
}

/** Pathspecs that leave each path out of `git add`, read literally so names such as ":odd" stay names. */
export function excludePathspecs(paths: readonly string[]): string[] {
  return paths.map((path) => `:(exclude,literal)${path}`);
}
