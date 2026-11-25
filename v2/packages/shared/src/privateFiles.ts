/**
 * ZLI's own files in its data folder (keys, settings, the database, saved sign-ins, the browser's key store), by
 * pattern under that folder. `*` stays within one folder level and `**` reaches any depth, as in Claude Code's
 * permission rules, so the buddy's home in a subfolder stays reachable.
 */
export const PRIVATE_FILE_PATTERNS = [
  // The key that opens the connected-apps key, and the sealed key itself. Named so that narrowing the wider
  // patterns below cannot leave them out.
  "secrets-key.bin",
  "connected-apps.json",
  "*.json",
  // A settings file mid-save, before it is renamed into place.
  "*.json.*.tmp",
  "*.bin",
  "runtime.sqlite*",
  "Local State",
  "mcp/**",
  "mcp-headers/**",
  "*.user-data/**",
] as const;

function slashed(path: string): string {
  return path
    .replace(/\\/gu, "/")
    .replace(/^\/\/\?\/(?:UNC\/)?/u, (prefix) => (prefix.endsWith("UNC/") ? "//" : ""))
    .replace(/^file:\/\/\/?/iu, "");
}

function absolute(path: string, cwd: string | undefined): string | undefined {
  const value = slashed(path.trim());
  if (/^[A-Za-z]:\//u.test(value) || value.startsWith("/")) return value;
  if (!cwd || value.length === 0) return undefined;
  return `${slashed(cwd).replace(/\/+$/u, "")}/${value}`;
}

/** Drops `.` and `..` segments, so `data/../ZLI/x` cannot slip past the folder check. */
function normalized(path: string): string {
  const lead = /^\/\/[^/]/u.test(path) ? "//" : path.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of path.slice(lead.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return lead + parts.join("/");
}

function patternRegex(pattern: string): RegExp {
  const source = pattern
    .split("**")
    .map((piece) => piece.replace(/[.+^${}()|[\]\\?]/gu, "\\$&").replace(/\*/gu, "[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`, "iu");
}

const PATTERN_REGEXES = PRIVATE_FILE_PATTERNS.map(patternRegex);

/**
 * True when `path` names one of ZLI's own files in `privateDir`. A relative path is read against `cwd`. Case is
 * ignored, since the data folder sits on a case-insensitive disk on Windows and macOS.
 */
export function isPrivateFile(privateDir: string, path: string, cwd?: string): boolean {
  const full = absolute(path, cwd);
  if (!full) return false;
  const root = normalized(slashed(privateDir)).toLowerCase();
  const target = normalized(full);
  if (!target.toLowerCase().startsWith(`${root}/`)) return false;
  const inside = target.slice(root.length + 1);
  return PATTERN_REGEXES.some((regex) => regex.test(inside));
}

/** Every string in a tool call's input, one level into arrays and objects: where agents put the paths they touch. */
export function inputStrings(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (depth > 3 || value === null || typeof value !== "object") return [];
  const items = Array.isArray(value) ? value : Object.values(value);
  return items.flatMap((item) => inputStrings(item, depth + 1));
}

/** True when any path-like string in a tool call's input names one of ZLI's own files in `privateDir`. */
export function touchesPrivateFile(privateDir: string, input: unknown, cwd?: string): boolean {
  return inputStrings(input).some((text) => isPrivateFile(privateDir, text, cwd));
}
