export type ClaudePermissionMode = "full-access" | "supervised";

const BASE_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--input-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
] as const;

// Print mode is required for stream-json input and output. No one-shot prompt:
// user turns arrive as NDJSON on stdin. Resume is omitted.
// Full access: each agent runs in its own git worktree, so tool calls are allowed
// without prompts; without this, print mode denies every Edit/Write/Bash call the
// user has not pre-allowed.
export const CLAUDE_SESSION_ARGS = [...BASE_ARGS, "--permission-mode", "bypassPermissions"] as const;

// Supervised: the default permission mode with "stdio" as the prompt tool makes
// Claude ask over stdout with can_use_tool control requests instead of denying.
export function claudeSessionArgs(input: { permissionMode?: ClaudePermissionMode; model?: string } = {}): string[] {
  const args: string[] =
    input.permissionMode === "supervised"
      ? [...BASE_ARGS, "--permission-mode", "default", "--permission-prompt-tool", "stdio"]
      : [...CLAUDE_SESSION_ARGS];
  if (input.model) args.push("--model", input.model);
  return args;
}

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
