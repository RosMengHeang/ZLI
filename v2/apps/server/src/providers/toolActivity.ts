import { posix, win32 } from "node:path";

import {
  MAX_ACTIVITY_INPUT,
  MAX_ACTIVITY_SOURCES,
  MCP_CATALOG,
  type ThreadActivityConnector,
  type ThreadActivityInput,
  type ThreadActivityKind,
  type ThreadActivitySource,
  type ThreadActivityTodo,
} from "@zli-v2/contracts";

/** A provider-neutral view of one tool call, as parsed from a CLI's structured stream. */
export type ToolCallUpdate = {
  callId: string;
  name: string;
  input?: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  output?: string;
  /** Line counts the CLI reported itself, preferred over counting from the input. */
  lines?: LineCounts;
  /** Pages the CLI reported in its own fields, listed before any found in the output. */
  sources?: ThreadActivitySource[];
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
  todos?: ThreadActivityTodo[];
  input?: ThreadActivityInput[];
  urls?: ThreadActivitySource[];
  /** Reasoning text that arrived since the last update of the same step. */
  text?: string;
  truncated?: boolean;
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
  // A call that writes the agent's todo list or plan is its plan, not a step to list.
  const todos = todoItems(update.name, input);
  if (todos) {
    const done = todos.filter((todo) => todo.status === "completed").length;
    return {
      activityId: update.callId,
      kind: "tool",
      title: `Plan: ${done} of ${todos.length} done`,
      status: update.status,
      todos,
    };
  }
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
  // Commands, reads, and edits already show their arguments as the command line, files, and line counts.
  const args = kind === "command" || kind === "file-read" || kind === "file-edit" ? [] : inputEntries(input);
  const urls = kind === "web" ? webSources(input, update.sources, update.output) : [];
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
    ...(args.length > 0 ? { input: args } : {}),
    ...(urls.length > 0 ? { urls } : {}),
  };
}

const MAX_INPUT_ENTRIES = 30;
const MAX_INPUT_KEY = 100;

/**
 * The call's arguments as key and text pairs, in the order the agent sent them. Values that are not
 * strings become JSON. All values together stay within MAX_ACTIVITY_INPUT characters, so a long
 * argument is cut and the ones after it may be left out.
 */
export function inputEntries(input: Record<string, unknown>): ThreadActivityInput[] {
  const entries: ThreadActivityInput[] = [];
  let budget = MAX_ACTIVITY_INPUT;
  for (const [key, raw] of Object.entries(input)) {
    if (entries.length >= MAX_INPUT_ENTRIES || budget <= 0) break;
    if (raw === undefined || raw === null || !key) continue;
    const text = typeof raw === "string" ? raw : jsonText(raw);
    if (text === undefined) continue;
    const value = text.length > budget ? `${text.slice(0, Math.max(0, budget - 1))}…` : text;
    budget -= value.length;
    entries.push({ key: key.slice(0, MAX_INPUT_KEY), value });
  }
  return entries;
}

function jsonText(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Pages a web step used: the URL it fetched, the ones the CLI reported, and for a search the ones in its output.
 * Claude's WebSearch prints them as `Links: [{"title", "url"}]`; other output is read for markdown
 * links and bare URLs.
 */
export function webSources(
  input: Record<string, unknown>,
  reported: readonly ThreadActivitySource[] | undefined,
  output: string | undefined,
): ThreadActivitySource[] {
  const found: ThreadActivitySource[] = [];
  const fetched = firstString(input, ["url", "uri", "href"]);
  if (fetched) found.push({ url: fetched });
  found.push(...(reported ?? []));
  // A fetched page's own links are its content, not sources, so only searches are read for them.
  if (output && !fetched) found.push(...outputSources(output));
  const seen = new Map<string, ThreadActivitySource>();
  for (const source of found) {
    const url = source.url.trim();
    if (!/^https?:\/\//iu.test(url) || url.length > 2_000) continue;
    const title = source.title?.trim().slice(0, 300);
    const known = seen.get(url);
    if (known) {
      if (!known.title && title) known.title = title;
      continue;
    }
    if (seen.size >= MAX_ACTIVITY_SOURCES) break;
    seen.set(url, { url, ...(title ? { title } : {}) });
  }
  return [...seen.values()];
}

function outputSources(output: string): ThreadActivitySource[] {
  const linked = linksJson(output);
  if (linked.length > 0) return linked;
  const sources: ThreadActivitySource[] = [];
  for (const match of output.matchAll(/\[([^\]\n]{1,300})\]\((https?:\/\/[^\s)]+)\)/giu)) {
    if (match[1] && match[2]) sources.push({ url: match[2], title: match[1].trim() });
  }
  for (const match of output.matchAll(/https?:\/\/[^\s<>"'`)\]]+/giu)) {
    sources.push({ url: match[0].replace(/[.,;:]+$/u, "") });
  }
  return sources;
}

function linksJson(output: string): ThreadActivitySource[] {
  const sources: ThreadActivitySource[] = [];
  for (const match of output.matchAll(/Links:\s*(\[[^\n]*\])/gu)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1] ?? "");
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.url !== "string") continue;
      sources.push({ url: record.url, ...(typeof record.title === "string" ? { title: record.title } : {}) });
    }
  }
  return sources;
}

const TODO_STATUS: Readonly<Record<string, ThreadActivityTodo["status"]>> = {
  pending: "pending",
  todo: "pending",
  notstarted: "pending",
  inprogress: "in_progress",
  active: "in_progress",
  running: "in_progress",
  completed: "completed",
  complete: "completed",
  done: "completed",
  cancelled: "completed",
};

/**
 * The plan in a todo-writing call: Claude's and Droid's TodoWrite ({ todos: [{ content, status }] }), Cursor's
 * todo_write, Codex's plan ({ todos: [{ step, status }] }), or a Droid list written as text lines such as
 * "1. [completed] Read the tests". Undefined for any other call.
 */
export function todoItems(name: string, input: Record<string, unknown>): ThreadActivityTodo[] | undefined {
  const tokens = nameTokens(name);
  if (!tokens.includes("todo") && !tokens.includes("todos") && !tokens.includes("plan")) return undefined;
  const raw = input.todos ?? input.plan ?? input.items;
  const entries: ThreadActivityTodo[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const text = [record.content, record.step, record.text, record.title, record.description].find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      if (!text) continue;
      const status =
        TODO_STATUS[
          String(record.status ?? "pending")
            .toLowerCase()
            .replace(/[^a-z]/gu, "")
        ] ?? "pending";
      entries.push({ text: clip(firstLine(text) ?? text, 500), status });
    }
  } else if (typeof raw === "string") {
    for (const line of raw.split(/\r?\n/u)) {
      const match = /^\s*(?:\d+[.)]|[-*])?\s*\[([a-z_ -]+)\]\s*(.+)$/iu.exec(line);
      if (!match?.[2]) continue;
      const status = TODO_STATUS[(match[1] ?? "").toLowerCase().replace(/[^a-z]/gu, "")] ?? "pending";
      entries.push({ text: clip(match[2].trim(), 500), status });
    }
  }
  return entries.length > 0 ? entries.slice(0, 100) : undefined;
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
