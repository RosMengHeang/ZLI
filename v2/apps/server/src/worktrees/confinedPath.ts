import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Whether ZLI may write or remove `relPath` (forward slashes) inside `root`: no part of it that exists
 * is a link, and it resolves inside `root`. A linked folder on the way would send the write wherever the
 * link points, past what ZLI hides from git. Node reports Windows junctions as links too. A link that
 * appears after this check is not caught.
 */
export async function isConfined(root: string, relPath: string): Promise<boolean> {
  const parts = relPath.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0 || isAbsolute(relPath) || parts.some((part) => part === ".." || part.includes("\\"))) {
    return false;
  }
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return false;
  }
  let current = root;
  let deepest = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) return false;
      if (index < parts.length - 1 && !info.isDirectory()) return false;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") break;
      return false;
    }
    deepest = current;
  }
  let resolved: string;
  try {
    resolved = await realpath(deepest);
  } catch {
    return false;
  }
  const rel = relative(realRoot, resolved);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
