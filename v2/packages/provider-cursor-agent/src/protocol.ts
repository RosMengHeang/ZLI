export type CursorPermissionMode = "read-only" | "supervised" | "full-access";

// stream-json is only valid in print mode. Cursor does not keep a stdin session
// open: each user turn is a new process in the worktree, and the chat id from
// system/init is passed back as --resume. --worktree is omitted because that
// flag creates a different git worktree. Full access adds --force: print mode has
// no approval channel, and each agent already runs in its own isolated worktree.
// Supervised omits it, so Cursor refuses commands its allowlist does not cover.
// Read only runs Cursor's plan mode, which analyzes and proposes without editing.
export function cursorTurnArgs(input: {
  cwd: string;
  sessionId?: string;
  permissionMode?: CursorPermissionMode;
  model?: string;
  /** Starts configured MCP servers without the approval prompt print mode cannot answer. */
  approveMcps?: boolean;
  /**
   * Every turn is a new process, and each one can start Cursor's background updater. An update
   * that lands while a turn runs replaces the files that turn still loads, and it crashes with
   * "Cannot find module".
   */
  disableAutoUpdate?: boolean;
}): string[] {
  const args = ["-p", "--output-format", "stream-json", "--stream-partial-output", "--trust"];
  if (input.disableAutoUpdate) args.push("--disable-auto-update");
  if (input.permissionMode === "read-only") args.push("--mode", "plan");
  else if (input.permissionMode !== "supervised") args.push("--force");
  if (input.approveMcps) args.push("--approve-mcps");
  args.push("--workspace", input.cwd);
  if (input.model) args.push("--model", input.model);
  if (input.sessionId) args.push("--resume", input.sessionId);
  return args;
}

export const MAX_CURSOR_LINE_CHARS = 1_000_000;

export type CursorLine = { type: "skip" } | { type: "invalid" } | { type: "message"; value: unknown };

export function decodeCursorLine(line: string): CursorLine {
  const trimmed = line.replace(/\r$/u, "").trim();
  if (!trimmed?.startsWith("{")) return { type: "skip" };
  try {
    return { type: "message", value: JSON.parse(trimmed) as unknown };
  } catch {
    return { type: "invalid" };
  }
}
