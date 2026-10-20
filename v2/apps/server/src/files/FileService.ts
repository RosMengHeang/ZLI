import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  type FileChangeStatus,
  type FileListResult,
  type FileReadResult,
  type FileSearchMatch,
  type FileSearchResult,
  type FileWriteResult,
  MAX_EDITABLE_FILE_BYTES,
  MAX_LISTED_FILES,
  MAX_SEARCH_RESULTS,
  WorktreeFilePath,
} from "@zli-v2/contracts";

/** Sent as `expectedVersion` to create a file, and returned as a conflict version when the file is gone. */
export const NEW_FILE_VERSION = "new";
const DEFAULT_SEARCH_RESULTS = 500;
const SEARCH_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 30_000;
const MAX_LIST_OUTPUT_BYTES = 64 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const PREVIEW_CHARS = 200;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/iu;

/** A request the user can fix; the message is shown as is. */
export class FileServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileServiceError";
  }
}

export type FileSearchOptions = { caseSensitive?: boolean; regex?: boolean; maxResults?: number };
export type FileWriteInput = {
  path: string;
  content: string;
  expectedVersion: string;
  bom?: boolean;
  overwrite?: boolean;
};

export class FileService {
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: { searchTimeoutMs?: number } = {}) {}

  /** Every listed file, with its uncommitted state. Files deleted from disk stay listed as `deleted`. */
  async list(root: string): Promise<FileListResult> {
    const [listed, changes, prefix] = await Promise.all([
      runGitNullList(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
      runGitNullList(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", "."]),
      runGitNullList(root, ["rev-parse", "--show-prefix"]),
    ]);
    const statuses = parseStatus(changes.entries, prefix.entries[0]?.trim() ?? "");
    const paths = [...new Set([...listed.entries, ...statuses.keys()])].sort(comparePaths);
    return {
      files: paths.slice(0, MAX_LISTED_FILES).map((path) => {
        const status = statuses.get(path);
        return status ? { path, status } : { path };
      }),
      truncated: listed.truncated || changes.truncated || paths.length > MAX_LISTED_FILES,
    };
  }

  async read(root: string, path: string): Promise<FileReadResult> {
    const target = await resolveExisting(root, path);
    const info = await stat(target);
    if (info.isDirectory()) throw new FileServiceError(`That path is a folder: ${path}`);
    if (info.size > MAX_EDITABLE_FILE_BYTES) {
      const head = await readHead(target, BINARY_SNIFF_BYTES);
      return {
        path,
        size: info.size,
        // Hashing a huge file only to refuse editing it is wasted work; any save against this version conflicts.
        version: `large:${info.size}:${Math.trunc(info.mtimeMs)}`,
        binary: head.includes(0),
        tooLarge: true,
        bom: false,
        lineEnding: "lf",
      };
    }
    const bytes = await readFile(target);
    const base = { path, size: bytes.length, version: sha256(bytes), tooLarge: false };
    const bom = bytes.subarray(0, 3).equals(UTF8_BOM);
    const body = bom ? bytes.subarray(3) : bytes;
    const content = body.subarray(0, BINARY_SNIFF_BYTES).includes(0) ? undefined : decodeUtf8(body);
    if (content === undefined) return { ...base, binary: true, bom: false, lineEnding: "lf" };
    const firstBreak = content.indexOf("\n");
    return {
      ...base,
      content,
      binary: false,
      bom,
      lineEnding: firstBreak > 0 && content[firstBreak - 1] === "\r" ? "crlf" : "lf",
    };
  }

  async write(root: string, input: FileWriteInput): Promise<FileWriteResult> {
    const target = await resolveWritable(root, input.path);
    const key = process.platform === "win32" ? target.toLowerCase() : target;
    const previous = this.writeQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => writeChecked(target, input));
    this.writeQueues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.writeQueues.get(key) === next) this.writeQueues.delete(key);
    }
  }

  async search(root: string, query: string, options: FileSearchOptions = {}): Promise<FileSearchResult> {
    if (query.length === 0) return { matches: [], truncated: false };
    const maxResults = Math.min(Math.max(1, options.maxResults ?? DEFAULT_SEARCH_RESULTS), MAX_SEARCH_RESULTS);
    const args = [
      "-c",
      "core.quotepath=off",
      "grep",
      "--untracked",
      "-I",
      "-n",
      "--column",
      "--null",
      "--no-color",
      options.regex ? "-E" : "-F",
      ...(options.caseSensitive ? [] : ["-i"]),
      "-e",
      query,
    ];
    const matches: FileSearchMatch[] = [];
    let remainder = Buffer.alloc(0);
    let overflow = false;
    const consumeLine = (line: Buffer) => {
      const match = parseGrepLine(line);
      if (!match) return true;
      if (matches.length >= maxResults) {
        overflow = true;
        return false;
      }
      matches.push(match);
      return true;
    };
    const result = await runGit(root, args, {
      timeoutMs: this.options.searchTimeoutMs ?? SEARCH_TIMEOUT_MS,
      onStdout: (chunk) => {
        let buffer = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
        let newline = buffer.indexOf(0x0a);
        while (newline !== -1) {
          if (!consumeLine(buffer.subarray(0, newline))) return false;
          buffer = buffer.subarray(newline + 1);
          newline = buffer.indexOf(0x0a);
        }
        remainder = Buffer.from(buffer);
        return true;
      },
    });
    if (!result.stopped && !result.timedOut && remainder.length > 0) consumeLine(remainder);
    if (!result.stopped && !result.timedOut && result.code !== 0 && result.code !== 1) {
      throw new FileServiceError(searchFailure(result.stderr, options.regex === true));
    }
    return { matches, truncated: overflow || result.timedOut };
  }
}

async function writeChecked(target: string, input: FileWriteInput): Promise<FileWriteResult> {
  const bytes = Buffer.concat([input.bom ? UTF8_BOM : Buffer.alloc(0), Buffer.from(input.content, "utf8")]);
  if (bytes.length > MAX_EDITABLE_FILE_BYTES) {
    throw new FileServiceError(`File is too large to save: ${input.path} is over 2 MiB.`);
  }
  const current = await readCurrent(target, input.path);
  const currentVersion = current ? sha256(current.bytes) : NEW_FILE_VERSION;
  if (!input.overwrite && currentVersion !== input.expectedVersion) {
    return { status: "conflict", path: input.path, version: currentVersion };
  }
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(target)}.${randomBytes(6).toString("hex")}.zli-tmp`);
  await writeFile(temporary, bytes, { flag: "wx", ...(current ? { mode: current.mode & 0o7777 } : {}) });
  try {
    await renameWithRetry(temporary, target);
  } catch {
    // Windows refuses to replace a file another process holds open; an in-place write usually still works.
    await unlink(temporary).catch(() => undefined);
    await writeFile(target, bytes);
  }
  return { status: "saved", path: input.path, version: sha256(bytes), size: bytes.length };
}

async function readCurrent(target: string, path: string): Promise<{ bytes: Buffer; mode: number } | undefined> {
  try {
    const info = await stat(target);
    if (info.isDirectory()) throw new FileServiceError(`That path is a folder: ${path}`);
    return { bytes: await readFile(target), mode: info.mode };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt >= 4 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

function assertSafePath(path: string): string[] {
  if (!WorktreeFilePath.safeParse(path).success) throw new FileServiceError("That file is outside the worktree.");
  const parts = path.split("/");
  if (parts[0]?.toLowerCase() === ".git") throw new FileServiceError("Files inside .git cannot be opened here.");
  if (process.platform === "win32" && parts.some((part) => part.includes(":") || WINDOWS_DEVICE_NAME.test(part))) {
    throw new FileServiceError(`That file name is not allowed on Windows: ${path}`);
  }
  return parts;
}

async function realRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    throw new FileServiceError("Worktree folder is missing on disk.");
  }
}

function isInside(root: string, target: string): boolean {
  const inside = relative(root, target);
  return inside === "" || !(inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside));
}

/** Returns the real path of an existing file, following symlinks only when they stay inside the worktree. */
async function resolveExisting(root: string, path: string): Promise<string> {
  const parts = assertSafePath(path);
  const base = await realRoot(root);
  let target: string;
  try {
    target = await realpath(join(base, ...parts));
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      throw new FileServiceError(`File not found: ${path}`);
    }
    throw error;
  }
  if (!isInside(base, target)) throw new FileServiceError("That file is outside the worktree.");
  return target;
}

/** Like resolveExisting, but a missing file resolves through its nearest existing parent folder. */
async function resolveWritable(root: string, path: string): Promise<string> {
  const parts = assertSafePath(path);
  const base = await realRoot(root);
  const candidate = join(base, ...parts);
  try {
    await lstat(candidate);
    return await resolveExisting(root, path);
  } catch (error) {
    if (error instanceof FileServiceError) throw error;
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") throw error;
  }
  for (let depth = parts.length - 1; depth >= 0; depth -= 1) {
    const ancestor = join(base, ...parts.slice(0, depth));
    let real: string;
    try {
      real = await realpath(ancestor);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (!isInside(base, real)) throw new FileServiceError("That file is outside the worktree.");
    if (!(await stat(real)).isDirectory()) throw new FileServiceError(`A parent of ${path} is a file, not a folder.`);
    return join(real, ...parts.slice(depth));
  }
  throw new FileServiceError("That file is outside the worktree.");
}

async function readHead(target: string, length: number): Promise<Buffer> {
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseGrepLine(line: Buffer): FileSearchMatch | undefined {
  const first = line.indexOf(0);
  const second = first === -1 ? -1 : line.indexOf(0, first + 1);
  const third = second === -1 ? -1 : line.indexOf(0, second + 1);
  if (third === -1) return undefined;
  const path = line.subarray(0, first).toString("utf8");
  const lineNumber = Number(line.subarray(first + 1, second).toString());
  const byteColumn = Number(line.subarray(second + 1, third).toString());
  if (!Number.isInteger(lineNumber) || lineNumber < 1 || !Number.isInteger(byteColumn) || byteColumn < 1) {
    return undefined;
  }
  const bytes = line.subarray(third + 1);
  const text = bytes.toString("utf8").replace(/\r$/u, "");
  // git reports a byte offset; editors index by UTF-16 code unit.
  const column = bytes.subarray(0, byteColumn - 1).toString("utf8").length + 1;
  return { path, line: lineNumber, column, preview: previewAround(text, column - 1) };
}

function previewAround(text: string, index: number): string {
  if (text.length <= PREVIEW_CHARS) return text.trim();
  const start = Math.max(0, Math.min(index - 60, text.length - PREVIEW_CHARS));
  const slice = text.slice(start, start + PREVIEW_CHARS).trim();
  return `${start > 0 ? "…" : ""}${slice}${start + PREVIEW_CHARS < text.length ? "…" : ""}`;
}

function searchFailure(stderr: string, regex: boolean): string {
  const detail = stderr
    .split(/\r?\n/u)
    .map((line) => line.replace(/^fatal:\s*/u, "").trim())
    .find((line) => line.length > 0);
  if (regex && detail) return `Invalid search pattern: ${detail.slice(0, 200)}`;
  return `Search failed${detail ? `: ${detail.slice(0, 200)}` : "."}`;
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/**
 * Reads `git status --porcelain=v1 -z --no-renames` output. Status paths are relative to the repository
 * root, so `prefix` (from `git rev-parse --show-prefix`) maps them onto the worktree folder.
 */
export function parseStatus(entries: readonly string[], prefix: string): Map<string, FileChangeStatus> {
  const statuses = new Map<string, FileChangeStatus>();
  for (const entry of entries) {
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    let path = entry.slice(3);
    if (prefix) {
      if (!path.startsWith(prefix)) continue;
      path = path.slice(prefix.length);
    }
    if (!path || path.endsWith("/")) continue;
    statuses.set(path, statusFromCode(code));
  }
  return statuses;
}

function statusFromCode(code: string): FileChangeStatus {
  if (code === "??") return "untracked";
  if (CONFLICT_CODES.has(code)) return "conflicted";
  if (code.includes("D")) return "deleted";
  if (code[0] === "R") return "renamed";
  if (code[0] === "A" || code[0] === "C") return "added";
  return "modified";
}

async function runGitNullList(root: string, args: string[]): Promise<{ entries: string[]; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const result = await runGit(root, args, {
    timeoutMs: LIST_TIMEOUT_MS,
    onStdout: (chunk) => {
      chunks.push(chunk);
      bytes += chunk.length;
      return bytes < MAX_LIST_OUTPUT_BYTES;
    },
  });
  if (result.timedOut) throw new FileServiceError("Listing files took too long.");
  if (!result.stopped && result.code !== 0) {
    const detail = result.stderr
      .trim()
      .split(/\r?\n/u)[0]
      ?.replace(/^fatal:\s*/u, "");
    throw new FileServiceError(`Could not list files${detail ? `: ${detail}` : "."}`);
  }
  const output = Buffer.concat(chunks).toString("utf8").split("\0");
  // A stopped stream ends mid-entry, so the last piece is dropped.
  if (result.stopped || output.at(-1) === "") output.pop();
  return { entries: output.filter((entry) => entry.length > 0), truncated: result.stopped };
}

type GitStreamResult = { code: number; stderr: string; stopped: boolean; timedOut: boolean };

/** Streams stdout to `onStdout`; returning false kills git and reports `stopped`. */
function runGit(
  cwd: string,
  args: string[],
  options: { timeoutMs: number; onStdout: (chunk: Buffer) => boolean },
): Promise<GitStreamResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stopped = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped || timedOut) return;
      if (!options.onStdout(chunk)) {
        stopped = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(errorCode(error) === "ENOENT" ? new FileServiceError("Git is not installed or not on PATH.") : error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr, stopped, timedOut });
    });
  });
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}
