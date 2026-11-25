import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Chromium's HTTP cache for the app and every browser tab. Without a limit Chromium sizes it from free disk
 * space, which reached 200 MB and more on a developer machine within weeks.
 */
export const DISK_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * Compiled JavaScript that Chromium keeps per profile. It has no size switch, and every app update and every
 * dev-server reload in a browser tab adds new entries, so a folder past this size is cleared at launch.
 */
export const CODE_CACHE_LIMIT_BYTES = 96 * 1024 * 1024;

const BUILD_MARKER = "zli-code-cache-build.txt";

export type CacheTrimResult = { cleared: string[]; reason: "build" | "size" | "none" };

/**
 * Clears Chromium's code caches under the profile folder when the app build changed (old entries are never
 * read again) or when one has grown past CODE_CACHE_LIMIT_BYTES. It is synchronous because it must finish
 * before Chromium opens the profile, which happens while the app gets ready. The cache rebuilds itself.
 */
export function trimCodeCaches(sessionData: string, buildId: string): CacheTrimResult {
  const folders = codeCacheFolders(sessionData);
  const marker = join(sessionData, BUILD_MARKER);
  const lastBuild = readText(marker);
  const cleared: string[] = [];
  let reason: CacheTrimResult["reason"] = "none";
  if (lastBuild !== undefined && lastBuild.trim() !== buildId) {
    for (const folder of folders) if (removeFolder(folder)) cleared.push(folder);
    reason = "build";
  } else {
    for (const folder of folders) {
      if (folderBytes(folder) <= CODE_CACHE_LIMIT_BYTES) continue;
      if (removeFolder(folder)) cleared.push(folder);
      reason = "size";
    }
  }
  try {
    writeFileSync(marker, buildId, "utf8");
  } catch {
    // A profile folder that does not exist yet gets the marker on the next launch.
  }
  return { cleared, reason };
}

/** The app profile's code cache and the one in each browser-tab partition. */
function codeCacheFolders(sessionData: string): string[] {
  const folders = [join(sessionData, "Code Cache")];
  const partitions = join(sessionData, "Partitions");
  for (const name of listFolder(partitions)) folders.push(join(partitions, name, "Code Cache"));
  return folders;
}

function removeFolder(folder: string): boolean {
  if (!exists(folder)) return false;
  try {
    rmSync(folder, { recursive: true, force: true });
    return true;
  } catch {
    // Another copy of the app may hold it open; the next launch tries again.
    return false;
  }
}

export function folderBytes(path: string): number {
  let info: ReturnType<typeof statSync> | undefined;
  try {
    info = statSync(path);
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of listFolder(path)) total += folderBytes(join(path, name));
  return total;
}

function listFolder(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
