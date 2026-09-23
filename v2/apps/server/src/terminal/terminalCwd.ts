import { posix, win32 } from "node:path";

export class TerminalCwdError extends Error {
  constructor(message = "Terminal cwd must stay inside the worktree.") {
    super(message);
    this.name = "TerminalCwdError";
  }
}

export function resolveTerminalCwd(worktreePath: string, cwd: string): string {
  if (worktreePath.length === 0 || cwd.length === 0 || worktreePath.includes("\0") || cwd.includes("\0")) {
    throw new TerminalCwdError();
  }
  const style = windowsWorktree(worktreePath) ? win32 : posix;
  if (!style.isAbsolute(worktreePath)) throw new TerminalCwdError();
  const root = style.resolve(worktreePath);
  const target = style.resolve(root, cwd);
  if (!containsWorktree(style, root, target)) throw new TerminalCwdError();
  return target;
}

function windowsWorktree(worktreePath: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(worktreePath) || worktreePath.includes("\\");
}

function containsWorktree(style: typeof posix | typeof win32, root: string, target: string): boolean {
  const fold = (value: string) => (style === win32 ? value.toLowerCase() : value);
  const rootKey = fold(root);
  const targetKey = fold(target);
  if (targetKey === rootKey) return true;
  const prefix = rootKey.endsWith(style.sep) ? rootKey : `${rootKey}${style.sep}`;
  return targetKey.startsWith(prefix);
}
