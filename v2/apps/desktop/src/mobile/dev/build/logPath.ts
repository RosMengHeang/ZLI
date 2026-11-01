import { open, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const LOG_FILE_MAX = 50 * 1024 * 1024;
export const LOG_READ_MAX = 2 * 1024 * 1024;
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

export type LogFiles = {
  realpath(file: string): Promise<string>;
  stat(file: string): Promise<{ size: number; isFile(): boolean }>;
  /** The last `bytes` bytes of the file, as text. */
  readTail(file: string, bytes: number): Promise<string>;
  tmpdir(): string;
  readonly path: Pick<typeof path, "resolve" | "relative" | "isAbsolute">;
};

export const nodeLogFiles: LogFiles = {
  realpath: (file) => realpath(file),
  stat: (file) => stat(file),
  readTail: async (file, bytes) => {
    const handle = await open(file, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  },
  tmpdir,
  path,
};

/**
 * Reads a build log an agent named. Relative paths start at the worktree. The real path, after links, must be in
 * the worktree or the temp folder, so an agent cannot use the brief to read other files on the machine.
 */
export async function readBuildLog(
  logPath: string,
  worktreePath: string,
  files: LogFiles = nodeLogFiles,
): Promise<string> {
  const requested = files.path.resolve(worktreePath, logPath);
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
  const info = await files.stat(real);
  if (!info.isFile()) throw new LogPathError(`${logPath} is not a file.`);
  if (info.size > LOG_FILE_MAX)
    throw new LogPathError(`${logPath} is over 50 MB. Save the end of the build log to a file and pass that.`);
  const text = await files.readTail(real, LOG_READ_MAX);
  // A cut in the middle of the file starts mid-line, so that partial line is dropped.
  return info.size > LOG_READ_MAX ? text.slice(text.indexOf("\n") + 1) : text;
}

function inside(paths: LogFiles["path"], root: string, file: string): boolean {
  const relative = paths.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !paths.isAbsolute(relative);
}
