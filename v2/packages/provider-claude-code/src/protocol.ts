// Headless Claude Code session: NDJSON stdin/stdout, token deltas, no one-shot prompt.
// Resume and permission-prompt-tool are omitted; this adapter does not implement them.
export const CLAUDE_SESSION_ARGS = [
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--input-format",
  "stream-json",
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
