export type DroidPermissionMode = "full-access" | "supervised";

// Droid exec runs one process per user turn. The prompt arrives on stdin, and the
// session id from system/init is passed back with -s to continue the
// conversation. Full access uses --skip-permissions-unsafe: exec mode has no
// approval channel, and each agent already runs in its own isolated worktree.
// Supervised uses --auto low, which lets the agent edit files but refuses riskier
// commands instead of asking. The two flags cannot be combined.
export function droidTurnArgs(input: {
  cwd: string;
  sessionId?: string;
  permissionMode?: DroidPermissionMode;
  model?: string;
}): string[] {
  const args = ["exec", "-o", "stream-json", "--cwd", input.cwd];
  if (input.permissionMode === "supervised") args.push("--auto", "low");
  else args.push("--skip-permissions-unsafe");
  if (input.model) args.push("-m", input.model);
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
