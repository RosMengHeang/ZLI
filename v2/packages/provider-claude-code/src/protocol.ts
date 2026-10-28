export type ClaudePermissionMode = "read-only" | "supervised" | "full-access";

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
// user turns arrive as NDJSON on stdin.
// Full access: each agent runs in its own git worktree, so tool calls are allowed
// without prompts; without this, print mode denies every Edit/Write/Bash call the
// user has not pre-allowed.
export const CLAUDE_SESSION_ARGS = [...BASE_ARGS, "--permission-mode", "bypassPermissions"] as const;

// Supervised accepts file edits and, with "stdio" as the prompt tool, asks over stdout
// with can_use_tool control requests before anything else instead of denying it.
// Read only is Claude's plan mode: it researches and proposes, and asks the same way
// before it leaves plan mode.
// A new conversation gets its id from us with --session-id: the CLI only prints its init
// record after the first user message, so the id cannot be read from it before then.
// --mcp-config adds servers for this process only and keeps the user's own; it is variadic,
// so it goes last where no positional argument can be mistaken for another config.
export function claudeSessionArgs(
  input: {
    permissionMode?: ClaudePermissionMode;
    model?: string;
    sessionId?: string;
    resumeSessionId?: string;
    mcpConfig?: string;
  } = {},
): string[] {
  const args: string[] =
    input.permissionMode === "supervised" || input.permissionMode === "read-only"
      ? [
          ...BASE_ARGS,
          "--permission-mode",
          input.permissionMode === "read-only" ? "plan" : "acceptEdits",
          "--permission-prompt-tool",
          "stdio",
        ]
      : [...CLAUDE_SESSION_ARGS];
  if (input.model) args.push("--model", input.model);
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  else if (input.sessionId) args.push("--session-id", input.sessionId);
  if (input.mcpConfig) args.push("--mcp-config", input.mcpConfig);
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
