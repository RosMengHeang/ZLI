import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MOBILE_BUILD_LOG_MAX } from "@zli-v2/contracts";

export const LOG_FILE_MAX = 50 * 1024 * 1024;
export const LOG_READ_MAX = MOBILE_BUILD_LOG_MAX;
const OUTSIDE = "ZLI reads build logs only from this worktree or the temp folder.";

/** A build log ZLI refused to read, with the HTTP status an agent's call gets for it. */
export class LogPathError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "LogPathError";
  }
}

export type LogTail = {
  readonly isFile: boolean;
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
  /** The last LOG_READ_MAX bytes of the file, as text. Empty for anything but a regular file. */
  readonly text: string;
};

export type LogFiles = {
  realpath(file: string): Promise<string>;
  stat(file: string): Promise<{ dev: number; ino: number }>;
  /** Opens the file, refusing links and things that are not files, and reads its tail. */
  openTail(file: string, bytes: number): Promise<LogTail>;
  tmpdir(): string;
  readonly path: Pick<typeof path, "resolve" | "relative" | "isAbsolute">;
};

export const nodeLogFiles: LogFiles = {
  realpath: (file) => realpath(file),
  stat: async (file) => {
    const info = await stat(file);
    return { dev: info.dev, ino: info.ino };
  },
  openTail: async (file, bytes) => {
    // O_NOFOLLOW refuses a link as the last component, and O_NONBLOCK keeps a FIFO from holding the worker.
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      // Windows has no O_NOFOLLOW. A link swapped for a file after this check still fails readBuildLog's inode match.
      if ((await lstat(file)).isSymbolicLink()) throw Object.assign(new Error(`${file} is a link.`), { code: "ELOOP" });
      const info = await handle.stat();
      const length = info.isFile() && info.size <= LOG_FILE_MAX ? Math.min(info.size, bytes) : 0;
      const buffer = Buffer.alloc(length);
      if (length > 0) await handle.read(buffer, 0, length, info.size - length);
      return { isFile: info.isFile(), size: info.size, dev: info.dev, ino: info.ino, text: buffer.toString("utf8") };
    } finally {
      await handle.close();
    }
  },
  tmpdir,
  path,
};

/**
 * Reads a build log an agent named. Relative paths start at the worktree. The file is opened first, and only
 * read on when its real path is in the worktree or the temp folder and still names the open file, so a swapped
 * link or path cannot make ZLI read other files on the machine.
 */
export async function readBuildLog(
  logPath: string,
  worktreePath: string,
  files: LogFiles = nodeLogFiles,
): Promise<{ text: string; cut: boolean }> {
  const requested = files.path.resolve(worktreePath, logPath);
  let opened: LogTail;
  try {
    opened = await files.openTail(requested, LOG_READ_MAX);
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;
    if (code === "ENOENT") throw new LogPathError(`There is no build log at ${logPath}.`, 404);
    if (code === "ELOOP") throw new LogPathError(`${logPath} is a link. Pass the log file itself.`);
    throw cause;
  }
  if (!opened.isFile) throw new LogPathError(`${logPath} is not a file.`);
  if (opened.size > LOG_FILE_MAX)
    throw new LogPathError(`${logPath} is over 50 MB. Save the end of the build log to a file and pass that.`);
  let real: string;
  try {
    real = await files.realpath(requested);
  } catch {
    throw new LogPathError(`There is no build log at ${logPath}.`, 404);
  }
  const roots = await Promise.all(
    [worktreePath, files.tmpdir()].map((root) => files.realpath(root).catch(() => files.path.resolve(root))),
  );
  if (!roots.some((root) => inside(files.path, root, real))) throw new LogPathError(OUTSIDE);
  // The open handle is the proof: the contained path must still name the very file that was opened.
  const confirm = await files.stat(real);
  if (confirm.dev !== opened.dev || confirm.ino !== opened.ino) throw new LogPathError(OUTSIDE);
  const cut = opened.size > LOG_READ_MAX;
  // A cut in the middle of the file starts mid-line, so that partial line is dropped.
  return { text: cut ? opened.text.slice(opened.text.indexOf("\n") + 1) : opened.text, cut };
}

function inside(paths: LogFiles["path"], root: string, file: string): boolean {
  const relative = paths.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !paths.isAbsolute(relative);
}
