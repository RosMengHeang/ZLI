import { readFile as readFileDefault } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

import {
  type McpImportApp,
  type McpImportCandidate,
  type McpImportResult,
  MCP_SERVER_NAME_PATTERN,
  McpServerConfig,
  RESERVED_MCP_SERVER_NAMES,
} from "@zli-v2/contracts";

export type ImportSource = {
  app: McpImportApp;
  appLabel: string;
  path: string;
  /** The key that holds the servers: VS Code uses `servers`, the rest `mcpServers`. */
  key: "mcpServers" | "servers";
};

export type ImportEnvironment = {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => Promise<string>;
};

export type ImportScanOptions = ImportEnvironment & {
  /** Names of servers ZLI already has, the person's and plugins'. */
  existing: readonly string[];
  /** Server names ZLI copied into each settings file, keyed by path. These are not offered back. */
  owned?: Readonly<Record<string, readonly string[]>>;
};

type Found = Omit<McpImportCandidate, "exists">;

/** Settings files other apps keep their MCP servers in, for this computer. */
export function importSources(environment: Omit<ImportEnvironment, "readFile"> = {}): ImportSource[] {
  const platform = environment.platform ?? process.platform;
  const home = environment.home ?? homedir();
  const env = environment.env ?? process.env;
  const path = platform === "win32" ? win32 : posix;
  const appData = env.APPDATA?.trim() || path.join(home, "AppData", "Roaming");
  const appSupport =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : platform === "win32"
        ? appData
        : env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  return [
    {
      app: "claude-desktop",
      appLabel: "Claude Desktop",
      path: path.join(appSupport, "Claude", "claude_desktop_config.json"),
      key: "mcpServers",
    },
    { app: "claude-code", appLabel: "Claude Code", path: path.join(home, ".claude.json"), key: "mcpServers" },
    { app: "cursor", appLabel: "Cursor", path: path.join(home, ".cursor", "mcp.json"), key: "mcpServers" },
    { app: "vscode", appLabel: "VS Code", path: path.join(appSupport, "Code", "User", "mcp.json"), key: "servers" },
    {
      app: "windsurf",
      appLabel: "Windsurf",
      path: path.join(home, ".codeium", "windsurf", "mcp_config.json"),
      key: "mcpServers",
    },
  ];
}

/** Reads one app's settings file contents into servers ZLI can save, and problems worth telling the person. */
export function parseImportFile(
  source: ImportSource,
  text: string,
  skip: ReadonlySet<string> = new Set(),
): { found: Found[]; problems: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text.replace(/^\uFEFF/u, "")));
  } catch {
    return { found: [], problems: [`ZLI could not read ${source.path}: it is not plain JSON.`] };
  }
  if (!isPlainObject(parsed))
    return { found: [], problems: [`ZLI could not read ${source.path}: it is not plain JSON.`] };
  const servers = parsed[source.key];
  if (servers === undefined) return { found: [], problems: [] };
  if (!isPlainObject(servers)) {
    return { found: [], problems: [`ZLI could not read the servers in ${source.path}.`] };
  }
  const found: Found[] = [];
  const problems: string[] = [];
  for (const [rawName, entry] of Object.entries(servers)) {
    if (skip.has(rawName.toLowerCase())) continue;
    const result = importEntry(source, rawName, entry);
    if (!result) continue;
    if ("problem" in result) problems.push(result.problem);
    else found.push(result);
  }
  return { found, problems };
}

function importEntry(source: ImportSource, rawName: string, entry: unknown): Found | { problem: string } | undefined {
  const label = source.appLabel;
  const name = serverName(rawName);
  if (!name) return { problem: `ZLI could not import ${rawName} from ${label}: its name has no letters or digits.` };
  if (RESERVED_MCP_SERVER_NAMES.includes(name.toLowerCase())) return undefined;
  if (!isPlainObject(entry))
    return { problem: `${rawName} in ${label} is not set up in a way ZLI understands, so ZLI skipped it.` };
  if (source.app === "vscode" && JSON.stringify(entry).includes("${input:")) {
    return { problem: `${rawName} in VS Code asks for a value when it starts, so ZLI skipped it.` };
  }
  const enabled = entry.disabled !== true;
  const url = [entry.url, entry.serverUrl, entry.httpUrl].find((value) => typeof value === "string");
  let candidate: unknown;
  if (typeof entry.command === "string") {
    if (
      entry.args !== undefined &&
      !(Array.isArray(entry.args) && entry.args.every((arg) => typeof arg === "string"))
    ) {
      return { problem: `ZLI could not import ${rawName} from ${label}: its arguments are not all text.` };
    }
    candidate = {
      name,
      enabled,
      transport: "stdio",
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args : [],
      env: stringRecord(entry.env),
    };
  } else if (typeof url === "string") {
    const headers = stringRecord(entry.headers);
    const authorized = Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
    candidate = { name, enabled, transport: "http", url, headers, oauth: !authorized };
  } else {
    return { problem: `${rawName} in ${label} has no command or address, so ZLI skipped it.` };
  }
  const checked = McpServerConfig.safeParse(candidate);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    const where = issue?.path.join(".") ?? "";
    const detail = issue
      ? `${where && where !== "name" ? `${where}: ` : ""}${issue.message}`
      : "Its settings are not valid.";
    return { problem: `ZLI could not import ${rawName} from ${label}. ${sentence(detail)}` };
  }
  return {
    app: source.app,
    appLabel: label,
    path: source.path,
    server: checked.data,
    ...(name !== rawName
      ? { note: `Renamed from ${rawName}, since ZLI names use only letters, digits, - and _.` }
      : {}),
  };
}

/** Looks for servers in other apps' settings. Missing files are skipped quietly. */
export async function scanImportableServers(options: ImportScanOptions): Promise<McpImportResult> {
  const read = options.readFile ?? ((path: string) => readFileDefault(path, "utf8"));
  const existing = new Set(options.existing.map((name) => name.toLowerCase()));
  const platform = options.platform ?? process.platform;
  const found: McpImportCandidate[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const source of importSources(options)) {
    let text: string;
    try {
      text = await read(source.path);
    } catch (error) {
      if (isMissing(error)) continue;
      problems.push(`ZLI could not open ${source.path}. Check that you can read it, then try again.`);
      continue;
    }
    const skip = source.app === "cursor" ? ownedNames(options.owned, source.path, platform) : new Set<string>();
    const result = parseImportFile(source, text, skip);
    problems.push(...result.problems);
    for (const candidate of result.found) {
      const key = JSON.stringify(sortedKeys({ ...candidate.server, name: candidate.server.name.toLowerCase() }));
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ ...candidate, exists: existing.has(candidate.server.name.toLowerCase()) });
    }
  }
  return { found, problems };
}

function ownedNames(
  owned: Readonly<Record<string, readonly string[]>> | undefined,
  path: string,
  platform: NodeJS.Platform,
): Set<string> {
  const same = (left: string, right: string) =>
    platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  const names = new Set<string>();
  for (const [file, list] of Object.entries(owned ?? {})) {
    if (!same(file, path)) continue;
    for (const name of list) names.add(name.toLowerCase());
  }
  return names;
}

/** Other apps allow spaces and dots in names; ZLI's agents do not. */
function serverName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return MCP_SERVER_NAME_PATTERN.test(cleaned) ? cleaned : "";
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") record[key] = item;
    else if (typeof item === "number" || typeof item === "boolean") record[key] = String(item);
  }
  return record;
}

/** VS Code and some others allow comments and trailing commas in their JSON. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
    } else if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
    } else if (char === "," && closesNext(text, index + 1)) {
      // A trailing comma.
    } else {
      out += char;
    }
  }
  return out;
}

/** Whether the next thing after whitespace and comments closes an object or array. */
function closesNext(text: string, from: number): boolean {
  let index = from;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (/\s/u.test(char)) {
      index += 1;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
    } else {
      return char === "}" || char === "]";
    }
  }
  return false;
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedKeys(value[key])]),
  );
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  const code = isPlainObject(error) ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}
