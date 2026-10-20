// Print mode is required for stream-json input and output. No one-shot prompt:
// user turns arrive as NDJSON on stdin. Resume and permission-prompt-tool are omitted.
// Each agent runs in its own git worktree, so tool calls are allowed without prompts;
// without this, print mode denies every Edit/Write/Bash call the user has not pre-allowed.
export const CLAUDE_SESSION_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--input-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--permission-mode",
  "bypassPermissions",
] as const;

export const MAX_CLAUDE_LINE_CHARS = 1_000_000;

export type ClaudeLine = { type: "skip" } | { type: "invalid" } | { type: "message"; value: unknown };

export function encodeClaudeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

export function decodeClaudeLine(line: string): ClaudeLine {
  const trimmed = line.replace(/\r$/u, "").trim();
  if (!trimmed?.startsWith("{")) return { type: "skip" };
  try {
    return { type: "message", value: JSON.parse(trimmed) as unknown };
  } catch {
    return { type: "invalid" };
  }
}
