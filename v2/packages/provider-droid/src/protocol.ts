// Droid exec runs one process per user turn. The prompt arrives on stdin, and the
// session id from system/init is passed back with -s to continue the
// conversation. --skip-permissions-unsafe approves every tool call: exec mode has
// no approval channel, and each agent already runs in its own isolated worktree.
// It cannot be combined with --auto.
export function droidTurnArgs(input: { cwd: string; sessionId?: string }): string[] {
  const args = ["exec", "-o", "stream-json", "--cwd", input.cwd, "--skip-permissions-unsafe"];
  if (input.sessionId) args.push("-s", input.sessionId);
  return args;
}

export const MAX_DROID_LINE_CHARS = 1_000_000;

export type DroidLine = { type: "skip" } | { type: "invalid" } | { type: "message"; value: unknown };

export function decodeDroidLine(line: string): DroidLine {
  const trimmed = line.replace(/\r$/u, "").trim();
  if (!trimmed?.startsWith("{")) return { type: "skip" };
  try {
    return { type: "message", value: JSON.parse(trimmed) as unknown };
  } catch {
    return { type: "invalid" };
  }
}
