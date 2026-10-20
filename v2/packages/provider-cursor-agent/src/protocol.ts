// stream-json is only valid in print mode. Cursor does not keep a stdin session
// open: each user turn is a new process in the worktree, and the chat id from
// system/init is passed back as --resume. --worktree is omitted because that
// flag creates a different git worktree. --force approves tool calls: print mode has
// no approval channel, and each agent already runs in its own isolated worktree.
export function cursorTurnArgs(input: { cwd: string; sessionId?: string }): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    "--force",
    "--workspace",
    input.cwd,
  ];
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
