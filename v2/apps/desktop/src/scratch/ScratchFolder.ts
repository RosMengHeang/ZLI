import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RunGit = (args: string[], cwd: string) => Promise<unknown>;

const runGit: RunGit = (args, cwd) => execFileAsync("git", args, { cwd, windowsHide: true, timeout: 15_000 });

/**
 * The folder scratch chats run in. It is its own Git repository, so the Changes panel and turn
 * checkpoints work there without touching any project.
 */
export async function ensureScratchFolder(path: string, git: RunGit = runGit): Promise<string> {
  await mkdir(path, { recursive: true });
  if (!existsSync(join(path, ".git"))) await git(["init", "--quiet"], path);
  return path;
}
