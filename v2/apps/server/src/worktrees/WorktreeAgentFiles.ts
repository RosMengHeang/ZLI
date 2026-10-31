import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, rmdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { isPlainObject, writeFileAtomic } from "../browser-tool/browserTool.js";
import { GitProcess } from "../git/GitProcess.js";
import { isConfined } from "./confinedPath.js";

export const EXCLUDE_START =
  "# zli:start Files ZLI adds for the agents it starts. ZLI removes this block when it quits.";
export const EXCLUDE_END = "# zli:end";

export type WorktreeFilesLog = (level: "info" | "warn", message: string, context: Record<string, unknown>) => void;

type StoredFile = {
  version: 1;
  files: Record<string, string>;
  /** The worktree each file is in. Older state files lack it. */
  roots: Record<string, string>;
  dirs: string[];
  excludes: string[];
};

type Repo = { top: string; exclude: string };

/**
 * Files ZLI puts in worktrees for the agents it starts, such as a CLI's project MCP file, so they apply
 * only to those agents. ZLI writes a file only where none exists, or where the file is still exactly as
 * ZLI wrote it; anything else is the person's or the repository's and is left alone. Paths are hidden
 * from git through the repository's shared `info/exclude`. Everything is recorded in `statePath`, so
 * `removeAll` can undo it on shutdown or, after a crash, on the next start.
 */
export class WorktreeAgentFiles {
  /** File path to a digest of what ZLI last wrote there. */
  private files: Record<string, string> = {};
  /** File path to the worktree it is in. */
  private roots: Record<string, string> = {};
  /** Folders ZLI created, removed again once empty. */
  private dirs = new Set<string>();
  /** info/exclude files that hold a ZLI block. */
  private excludes = new Set<string>();
  private readonly repos = new Map<string, Promise<Repo | undefined>>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly git: GitProcess;

  constructor(private readonly options: { statePath: string; git?: GitProcess; log?: WorktreeFilesLog }) {
    this.git = options.git ?? new GitProcess();
  }

  async load(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.options.statePath, "utf8"));
    } catch {
      return;
    }
    if (!isPlainObject(parsed)) return;
    if (isPlainObject(parsed.files)) {
      this.files = Object.fromEntries(
        Object.entries(parsed.files).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    }
    if (isPlainObject(parsed.roots)) {
      this.roots = Object.fromEntries(
        Object.entries(parsed.roots).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    }
    this.dirs = new Set(strings(parsed.dirs));
    this.excludes = new Set(strings(parsed.excludes));
  }

  /**
   * Writes `contents` to `relPath` (forward slashes) inside the worktree, or removes ZLI's file there when
   * `contents` is undefined. Returns whether the file now holds `contents`; false means the file is not
   * ZLI's and was left alone.
   */
  writeFile(worktreePath: string, relPath: string, contents: string | undefined): Promise<boolean> {
    return this.serialize(async () => {
      const path = join(worktreePath, ...relPath.split("/"));
      if (!(await isConfined(worktreePath, relPath))) {
        if (this.files[path] !== undefined) {
          this.forget(path);
          await this.save();
        }
        this.log("warn", "Left an agent file in a worktree alone because a folder on its path is a link.", { path });
        return false;
      }
      let current: string | undefined;
      try {
        current = await readOptional(path);
      } catch (error) {
        this.log("warn", "Could not read an agent file in a worktree.", { path, message: messageOf(error) });
        return false;
      }
      const recorded = this.files[path];
      const ours = current !== undefined && recorded !== undefined && digest(current) === recorded;
      if (current !== undefined && !ours) {
        if (recorded !== undefined) {
          this.forget(path);
          await this.save();
        }
        this.log("info", "Left a file in a worktree alone because ZLI did not write it.", { path });
        return false;
      }
      if (contents === undefined) {
        if (current !== undefined) {
          await rm(path, { force: true });
          this.forget(path);
          await this.save();
        }
        return false;
      }
      await this.hideNow(worktreePath, [relPath]);
      if (current === undefined) await this.makeDirNow(worktreePath, dirname(relPath));
      // Recorded before the write, so a crash between the two still leaves a record to clean up.
      this.files[path] = digest(contents);
      this.roots[path] = worktreePath;
      await this.save();
      // Server env values and headers are often tokens. The mode does nothing on Windows.
      if (current !== contents) await writeFileAtomic(path, contents, { mode: 0o600 });
      return true;
    });
  }

  /** Creates `relDir` inside the worktree, remembering which folders ZLI made. */
  makeDir(worktreePath: string, relDir: string): Promise<void> {
    return this.serialize(() => this.makeDirNow(worktreePath, relDir));
  }

  /** Hides paths inside the worktree from git. A trailing slash hides a folder. Plain folders are skipped. */
  hide(worktreePath: string, relPaths: readonly string[]): Promise<void> {
    return this.serialize(() => this.hideNow(worktreePath, relPaths));
  }

  /**
   * Removes every file ZLI wrote that is still as ZLI left it, the folders ZLI made once they are empty,
   * and ZLI's block in each info/exclude. Failures are logged and kept for the next try.
   */
  removeAll(): Promise<void> {
    return this.serialize(async () => {
      const files: Record<string, string> = {};
      const roots: Record<string, string> = {};
      for (const [path, recorded] of Object.entries(this.files)) {
        try {
          if (!(await this.removable(path))) {
            this.log("info", "Kept a file ZLI wrote in a worktree because a folder on its path is now a link.", {
              path,
            });
            continue;
          }
          const current = await readOptional(path);
          if (current === undefined) continue;
          if (digest(current) !== recorded) {
            this.log("info", "Kept a file ZLI wrote in a worktree because it changed since.", { path });
            continue;
          }
          await rm(path, { force: true });
        } catch (error) {
          files[path] = recorded;
          const root = this.roots[path];
          if (root !== undefined) roots[path] = root;
          this.log("warn", "Could not remove a file ZLI wrote in a worktree.", { path, message: messageOf(error) });
        }
      }
      // Deepest first, so a parent is empty by the time its turn comes.
      for (const dir of [...this.dirs].sort((left, right) => right.length - left.length)) {
        await rmdir(dir).catch(() => undefined);
      }
      const excludes = new Set<string>();
      for (const path of this.excludes) {
        try {
          await removeExcludeBlock(path);
        } catch (error) {
          excludes.add(path);
          this.log("warn", "Could not remove ZLI's lines from a git exclude file.", {
            path,
            message: messageOf(error),
          });
        }
      }
      this.files = files;
      this.roots = roots;
      this.dirs = new Set();
      this.excludes = excludes;
      this.repos.clear();
      await this.save();
    });
  }

  async waitForIdle(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  private async makeDirNow(worktreePath: string, relDir: string): Promise<void> {
    const parts = relDir.split("/").filter((part) => part.length > 0 && part !== ".");
    if (parts.length === 0) return;
    if (!(await isConfined(worktreePath, relDir))) {
      throw new Error(`${relDir} in ${worktreePath} or a folder above it is a link.`);
    }
    const missing: string[] = [];
    for (let index = parts.length; index > 0; index -= 1) {
      const dir = join(worktreePath, ...parts.slice(0, index));
      if (await exists(dir)) break;
      missing.push(dir);
    }
    if (missing.length === 0) return;
    for (const dir of missing) this.dirs.add(dir);
    await this.save();
    await mkdir(join(worktreePath, ...parts), { recursive: true });
  }

  private async hideNow(worktreePath: string, relPaths: readonly string[]): Promise<void> {
    if (relPaths.length === 0) return;
    const repo = await this.repo(worktreePath);
    if (!repo) return;
    const root = await realpath(worktreePath).catch(() => worktreePath);
    const patterns = relPaths.flatMap((relPath) => {
      const folder = relPath.endsWith("/");
      const fromTop = relative(repo.top, join(root, ...relPath.split("/").filter(Boolean)));
      if (fromTop.length === 0 || fromTop.startsWith("..") || isAbsolute(fromTop)) return [];
      return [`/${fromTop.split(sep).map(escapePattern).join("/")}${folder ? "/" : ""}`];
    });
    if (patterns.length === 0) return;
    const text = (await readOptional(repo.exclude)) ?? "";
    const next = withExcludeLines(text, patterns);
    if (next === text) return;
    this.excludes.add(repo.exclude);
    await this.save();
    await writeFileAtomic(repo.exclude, next);
  }

  /** The repository's top folder and shared exclude file, or undefined for a folder outside git. */
  private repo(worktreePath: string): Promise<Repo | undefined> {
    let repo = this.repos.get(worktreePath);
    if (!repo) {
      repo = this.git
        .run(["rev-parse", "--show-toplevel", "--git-common-dir"], { cwd: worktreePath, timeoutMs: 10_000 })
        .then(async ({ stdout }) => {
          const [top, common] = stdout.split(/\r?\n/u).map((line) => line.trim());
          if (!top || !common) return undefined;
          const topPath = await realpath(top).catch(() => resolve(top));
          return { top: topPath, exclude: join(resolve(worktreePath, common), "info", "exclude") };
        })
        .catch(() => undefined);
      this.repos.set(worktreePath, repo);
    }
    return repo;
  }

  private async save(): Promise<void> {
    const file: StoredFile = {
      version: 1,
      files: this.files,
      roots: this.roots,
      dirs: [...this.dirs],
      excludes: [...this.excludes],
    };
    await writeFileAtomic(this.options.statePath, `${JSON.stringify(file, null, 2)}\n`);
  }

  private forget(path: string): void {
    delete this.files[path];
    delete this.roots[path];
  }

  /** Whether removing `path` stays inside its worktree. Without a recorded worktree, only the file itself is checked. */
  private async removable(path: string): Promise<boolean> {
    const root = this.roots[path];
    if (root !== undefined) return isConfined(root, relative(root, path).split(sep).join("/"));
    try {
      return !(await lstat(path)).isSymbolicLink();
    } catch {
      return true;
    }
  }

  private log(level: "info" | "warn", message: string, context: Record<string, unknown>): void {
    this.options.log?.(level, message, context);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(work);
    this.queue = run;
    return run;
  }
}

/** `text` with ZLI's block holding `patterns` as well as what it held before. */
export function withExcludeLines(text: string, patterns: readonly string[]): string {
  const lines = text.length === 0 ? [] : text.replace(/\r?\n$/u, "").split(/\r?\n/u);
  const start = lines.indexOf(EXCLUDE_START);
  const end = start < 0 ? -1 : lines.indexOf(EXCLUDE_END, start);
  const existing = start >= 0 && end > start ? lines.slice(start + 1, end) : [];
  const missing = [...new Set(patterns)].filter((pattern) => !existing.includes(pattern));
  if (missing.length === 0 && end > start) return text;
  const block = [EXCLUDE_START, ...existing, ...missing, EXCLUDE_END];
  const rest = start >= 0 && end > start ? [...lines.slice(0, start), ...lines.slice(end + 1)] : lines;
  const eol = lineEnding(text);
  return `${[...rest, ...block].join(eol)}${eol}`;
}

/** `text` without ZLI's block. */
export function withoutExcludeBlock(text: string): string {
  const lines = text.replace(/\r?\n$/u, "").split(/\r?\n/u);
  const start = lines.indexOf(EXCLUDE_START);
  const end = start < 0 ? -1 : lines.indexOf(EXCLUDE_END, start);
  if (start < 0 || end < start) return text;
  const rest = [...lines.slice(0, start), ...lines.slice(end + 1)];
  const eol = lineEnding(text);
  return rest.length === 0 ? "" : `${rest.join(eol)}${eol}`;
}

function lineEnding(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

async function removeExcludeBlock(path: string): Promise<void> {
  const text = await readOptional(path);
  if (text === undefined) return;
  const next = withoutExcludeBlock(text);
  if (next !== text) await writeFileAtomic(path, next);
}

/** Git reads these characters in exclude patterns as wildcards. */
function escapePattern(segment: string): string {
  return segment.replace(/[\\*?[\]]/gu, "\\$&");
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
