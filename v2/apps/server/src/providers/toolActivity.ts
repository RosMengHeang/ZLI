import { posix, win32 } from "node:path";

import { MCP_CATALOG, type ThreadActivityConnector, type ThreadActivityKind } from "@zli-v2/contracts";

/** A provider-neutral view of one tool call, as parsed from a CLI's structured stream. */
export type ToolCallUpdate = {
  callId: string;
  name: string;
  input?: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  output?: string;
  /** Line counts the CLI reported itself, preferred over counting from the input. */
  lines?: LineCounts;
};

export type LineCounts = { added: number; removed: number };

export type ProviderActivity = {
  activityId: string;
  kind: ThreadActivityKind;
  title: string;
  detail?: string;
  status: "running" | "completed" | "failed";
  files?: string[];
  lines?: LineCounts;
  command?: string;
  connector?: ThreadActivityConnector;
};

const MAX_TITLE = 500;
const MAX_DETAIL = 4_000;
const MAX_COMMAND = 2_000;

const EXACT_KINDS: Readonly<Record<string, ThreadActivityKind>> = {
  shell: "command",
  bash: "command",
  execute: "command",
  exec: "command",
  runterminalcmd: "command",
  terminal: "command",
  commandexecution: "command",
  localshell: "command",
  powershell: "command",
  runcommand: "command",
  read: "file-read",
  readfile: "file-read",
  view: "file-read",
  cat: "file-read",
  edit: "file-edit",
  editfile: "file-edit",
  write: "file-edit",
  writefile: "file-edit",
  applypatch: "file-edit",
  create: "file-edit",
  createfile: "file-edit",
  multiedit: "file-edit",
  strreplace: "file-edit",
  strreplacebasededittool: "file-edit",
  searchreplace: "file-edit",
  notebookedit: "file-edit",
  filechange: "file-edit",
  delete: "file-edit",
  deletefile: "file-edit",
  grep: "search",
  glob: "search",
  search: "search",
  ls: "search",
  find: "search",
  list: "search",
  listdir: "search",
  codebasesearch: "search",
  filesearch: "search",
  globfilesearch: "search",
  semanticsearch: "search",
  semsearch: "search",
  ripgrep: "search",
  web: "web",
  websearch: "web",
  webfetch: "web",
  fetch: "web",
  fetchurl: "web",
  browse: "web",
};

const LIST_NAMES = new Set(["ls", "list", "listdir"]);

/** Converts one tool-call update into the projected activity shape. Never throws on unknown input. */
export function toolActivity(update: ToolCallUpdate, cwd?: string): ProviderActivity {
  const input = update.input ?? {};
  const kind = classifyTool(update.name, input);
  const files =
    kind === "file-read" || kind === "file-edit" ? toolPaths(input).map((path) => displayPath(path, cwd)) : [];
  const connector = toolConnector(update);
  const title =
    (connector?.reason === "request"
      ? clip(`Ask to connect ${connectorTitle(connector.server)}`, MAX_TITLE)
      : undefined) ||
    clip(toolTitle(kind, update.name, input, files, cwd), MAX_TITLE) ||
    humanName(update.name) ||
    "Tool call";
  const showDetail = update.status === "failed" || (kind !== "file-read" && kind !== "file-edit");
  const detail = showDetail ? tail(update.output) : undefined;
  const command = kind === "command" ? commandText(input) : undefined;
  const lines = kind === "file-edit" && update.status !== "failed" ? (update.lines ?? editLines(input)) : undefined;
  return {
    activityId: update.callId,
    kind,
    title,
    status: update.status,
    ...(detail ? { detail } : {}),
    ...(files.length > 0 ? { files: [...new Set(files)].slice(0, 100) } : {}),
    ...(lines && (lines.added > 0 || lines.removed > 0) ? { lines } : {}),
    ...(command && command !== title ? { command: clip(command, MAX_COMMAND) } : {}),
    ...(connector ? { connector } : {}),
  };
}

/** connect_service from the built-in zli server, bare (Cursor), as zli.connect_service (Codex), or mcp__zli__ (Claude). */
const CONNECT_TOOL_NAMES = new Set(["connectservice", "zliconnectservice", "mcpzliconnectservice"]);
const SIGN_IN_MARKER = /([A-Za-z0-9_-]{1,64}) needs you to sign in\. Open ZLI Settings/u;

/**
 * The connector a call is about: a server that failed because it needs a sign-in (the ZLI bridge
 * says so in its error), or the service the agent asked for with connect_service.
 */
export function toolConnector(update: ToolCallUpdate): ThreadActivityConnector | undefined {
  if (CONNECT_TOOL_NAMES.has(normalizeName(update.name))) {
    const service = update.input?.service;
    if (update.status === "failed" || typeof service !== "string" || !service.trim()) return undefined;
    const name = service.trim().slice(0, 100);
    return { server: catalogEntry(name)?.id ?? name, reason: "request" };
  }
  if (update.status !== "failed" || !update.output) return undefined;
  const server = SIGN_IN_MARKER.exec(update.output)?.[1];
  return server ? { server, reason: "sign-in" } : undefined;
}

function catalogEntry(name: string) {
  const key = name.toLowerCase();
  return MCP_CATALOG.find((entry) => entry.id === key || entry.title.toLowerCase() === key);
}

function connectorTitle(server: string): string {
  return catalogEntry(server)?.title ?? server;
}

const OLD_TEXT_KEYS = ["old_string", "old_str", "oldString", "old_text", "oldText"];
const NEW_TEXT_KEYS = ["new_string", "new_str", "newString", "new_text", "newText"];
const CONTENT_KEYS = ["content", "contents", "file_text", "fileText", "text"];
const PATCH_KEYS = ["patch", "diff", "input"];

/**
 * Lines an edit adds and removes, worked out from the tool input: a replacement pair, a list of
 * them, a whole new file, or a patch. Undefined when the input carries none of those.
 */
export function editLines(input: Record<string, unknown>): LineCounts | undefined {
  const edits = input.edits;
  if (Array.isArray(edits)) {
    let total: LineCounts | undefined;
    for (const edit of edits) {
      if (!edit || typeof edit !== "object" || Array.isArray(edit)) continue;
      const counts = replacementLines(edit as Record<string, unknown>);
      if (counts)
        total = { added: (total?.added ?? 0) + counts.added, removed: (total?.removed ?? 0) + counts.removed };
    }
    if (total) return total;
  }
  const replacement = replacementLines(input);
  if (replacement) return replacement;
  const patch = rawString(input, PATCH_KEYS);
  if (patch && /^(?:\*\*\* |@@|\+\+\+ |--- )/mu.test(patch)) return patchLines(patch);
  const content = rawString(input, CONTENT_KEYS);
  if (content !== undefined) return { added: lineCount(content), removed: 0 };
  return undefined;
}

function replacementLines(input: Record<string, unknown>): LineCounts | undefined {
  const before = rawString(input, OLD_TEXT_KEYS);
  const after = rawString(input, NEW_TEXT_KEYS);
  if (before === undefined && after === undefined) return undefined;
  return diffLineCounts(before ?? "", after ?? "");
}

/** Counts changed lines after dropping the lines both sides share at the start and the end. */
export function diffLineCounts(before: string, after: string): LineCounts {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return { added: endB - start, removed: endA - start };
}

/** Counts +/- lines in a unified diff or an apply_patch envelope, skipping file headers. */
export function patchLines(patch: string): LineCounts {
  let added = 0;
  let removed = 0;
  for (const line of patch.split(/\r?\n/u)) {
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("*** ")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function splitLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function lineCount(value: string): number {
  return splitLines(value).length;
}

function rawString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function classifyTool(name: string, input: Record<string, unknown> = {}): ThreadActivityKind {
  const normalized = normalizeName(name);
  const exact = EXACT_KINDS[normalized];
  if (exact) return exact;
  const tokens = nameTokens(name);
  const has = (...words: string[]) => words.some((word) => tokens.includes(word));
  if (has("todo", "todos")) return "tool";
  if (has("web", "fetch", "url", "browser", "browse")) return "web";
  if (has("shell", "bash", "terminal", "command", "powershell")) return "command";
  if (has("grep", "glob", "search", "find", "ripgrep")) return "search";
  const hasPath = toolPaths(input).length > 0;
  if (hasPath && has("edit", "write", "patch", "replace", "create", "delete")) return "file-edit";
  if (hasPath && has("read", "view", "open")) return "file-read";
  return "tool";
}

function toolTitle(
  kind: ThreadActivityKind,
  name: string,
  input: Record<string, unknown>,
  files: readonly string[],
  cwd: string | undefined,
): string {
  switch (kind) {
    case "command": {
      // Claude's description and Droid's summary say what a command is for in plain words.
      const description = firstString(input, ["description", "summary"]);
      return (description ? firstLine(description) : undefined) ?? commandText(input) ?? humanName(name);
    }
    case "file-read":
      return files[0] ? `Read ${filesLabel(files)}` : "Read file";
    case "file-edit":
      return files[0] ? `Edit ${filesLabel(files)}` : "Edit files";
    case "search": {
      const pattern = searchPattern(input);
      const path = firstString(input, ["path", "directory_path", "directory", "dir", "target_directory", "folder"]);
      if (LIST_NAMES.has(normalizeName(name)) || (!pattern && path)) {
        return path ? `List ${displayPath(path, cwd)}` : "List files";
      }
      return pattern ? `Search ${pattern}` : "Search";
    }
    case "web": {
      const url = firstString(input, ["url", "uri", "href"]);
      if (url) return `Fetch ${url}`;
      const query = firstString(input, ["query", "q", "search_term", "searchTerm"]);
      return query ? `Web search ${query}` : humanName(name);
    }
    default: {
      const label = humanName(name);
      const description = firstString(input, ["description", "title", "prompt"]);
      return description ? `${label}: ${firstLine(description)}` : label;
    }
  }
}

function filesLabel(files: readonly string[]): string {
  const [first] = files;
  if (!first) return "";
  return files.length > 1 ? `${first} and ${files.length - 1} more` : first;
}

/** Path-like fields across Claude, Cursor, Droid, and Codex tool inputs. */
export function toolPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of [
    "file_path",
    "filePath",
    "path",
    "target_file",
    "targetFile",
    "notebook_path",
    "file",
    "filename",
  ]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) paths.push(value.trim());
  }
  for (const key of ["paths", "files", "file_paths"]) {
    const value = input[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.trim()) paths.push(item.trim());
      else if (item && typeof item === "object" && !Array.isArray(item)) {
        const nested = (item as Record<string, unknown>).path ?? (item as Record<string, unknown>).file_path;
        if (typeof nested === "string" && nested.trim()) paths.push(nested.trim());
      }
    }
  }
  const patch = firstString(input, ["patch", "input"]);
  if (patch?.includes("*** ")) paths.push(...patchPaths(patch));
  return [...new Set(paths)];
}

/** File headers from the apply_patch envelope format. */
function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\r?\n/u)) {
    const match = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/u.exec(line.trim());
    if (match?.[1]) paths.push(match[1].trim());
  }
  return paths;
}

function commandText(input: Record<string, unknown>): string | undefined {
  const raw = input.command ?? input.cmd ?? input.commandLine ?? input.script;
  const value = Array.isArray(raw)
    ? raw.filter((part): part is string => typeof part === "string").join(" ")
    : typeof raw === "string"
      ? raw
      : undefined;
  if (!value?.trim()) return undefined;
  return firstLine(unwrapShell(value.trim()));
}

/** `bash -lc "npm test"` reads better as `npm test`. */
function unwrapShell(command: string): string {
  const match = /^(?:\S*[\\/])?(?:bash|zsh|sh)(?:\.exe)? -l?c (['"])([\s\S]*)\1$/u.exec(command);
  return match?.[2]?.trim() || command;
}

function searchPattern(input: Record<string, unknown>): string | undefined {
  const direct = firstString(input, ["pattern", "query", "regex", "glob_pattern", "globPattern", "search_term", "q"]);
  if (direct) return firstLine(direct);
  const patterns = input.patterns;
  if (Array.isArray(patterns)) {
    const joined = patterns.filter((part): part is string => typeof part === "string").join(", ");
    return joined || undefined;
  }
  return undefined;
}

export function displayPath(path: string, cwd: string | undefined): string {
  if (!cwd) return path;
  const api = /^[A-Za-z]:[\\/]|^\\\\/u.test(path) ? win32 : path.startsWith("/") ? posix : undefined;
  if (!api?.isAbsolute(cwd)) return path;
  try {
    const relative = api.relative(cwd, path);
    if (!relative || relative.startsWith("..") || api.isAbsolute(relative)) return path;
    return relative.split(api.sep).join("/");
  } catch {
    return path;
  }
}

function humanName(name: string): string {
  const trimmed = name.trim();
  return trimmed.replace(/ToolCall$/u, "") || trimmed;
}

function normalizeName(name: string): string {
  return name
    .replace(/ToolCall$/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstLine(value: string): string {
  return (
    value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function clip(value: string, max: number): string {
  const line = firstLine(value);
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function tail(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+$/u, "");
  if (!trimmed) return undefined;
  return trimmed.length > MAX_DETAIL ? trimmed.slice(-MAX_DETAIL) : trimmed;
}
