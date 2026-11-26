import { PRIVATE_FILE_PATTERNS } from "@zli-v2/shared";

export type ClaudePermissionMode = "read-only" | "supervised" | "full-access";

const BASE_ARGS = [
  "-p",
  "--output-format",
  "stream-json",
  "--input-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  // Adaptive thinking lets the model think as much as each request needs instead of a fixed budget,
  // and summarized display streams readable thinking for the chat's thinking rows.
  "--thinking",
  "adaptive",
  "--thinking-display",
  "summarized",
] as const;

// Print mode is required for stream-json input and output. No one-shot prompt:
// user turns arrive as NDJSON on stdin.
// Full access: each agent runs in its own git worktree, so tool calls are allowed
// without prompts; without this, print mode denies every Edit/Write/Bash call the
// user has not pre-allowed.
/** Claude's tools that stop and wait for the person: off when nobody is there to answer. */
const UNATTENDED_OFF = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"] as const;
/** The file-writing tools, refused outright for a read-only agent that runs unattended. */
const READ_ONLY_OFF = ["Edit", "Write", "NotebookEdit"] as const;

// The prompt tool is on in full access too: Claude still sends AskUserQuestion through it, which shows as a question
// card in ZLI instead of failing. Every other tool runs without asking.
export const CLAUDE_SESSION_ARGS = [
  ...BASE_ARGS,
  "--permission-mode",
  "bypassPermissions",
  "--permission-prompt-tool",
  "stdio",
] as const;

/**
 * ZLI's own files in its data folder (keys, settings, the database, saved sign-ins, the browser's key store), by
 * pattern under that folder. Deny rules for Read and Edit (Edit covers every writing tool) refuse Claude Code's own
 * file tools there. This is a guard rail, not a wall: Claude Code also refused a plain `cat` of these files in a real
 * run, but a script that builds the path itself still reads them, since the buddy runs as the person. Only running
 * buddies as another OS user would close that. The list is shared with the ACP and Droid guards.
 */
const PRIVATE_PATTERNS = PRIVATE_FILE_PATTERNS;

/**
 * A folder as a Claude Code permission path: `//c/Users/...` on Windows, `//Users/...` elsewhere. A network folder
 * (`\\server\share\...`, as with redirected AppData) becomes `//server/share/...`, not `///server/...`, which no
 * path matches.
 */
export function claudeRulePath(folder: string): string {
  const slashed = folder
    .replace(/\\/gu, "/")
    .replace(/^\/\/\?\/(?:UNC\/)?/u, (prefix) => (prefix.endsWith("UNC/") ? "//" : ""))
    .replace(/\/+$/u, "");
  const drive = /^([A-Za-z]):(?:\/|$)/u.exec(slashed);
  if (drive) return `//${drive[1]?.toLowerCase()}/${slashed.slice(3)}`.replace(/\/+$/u, "");
  if (/^\/\/[^/]/u.test(slashed)) return slashed;
  return `/${slashed}`;
}

/** The deny rules that keep an agent's file tools out of ZLI's own files in `privateDir`. */
export function privateFileRules(privateDir: string): string[] {
  const base = claudeRulePath(privateDir);
  // The drive letter in both cases: the documented form is lowercase, but a path Claude Code is given may not be.
  const drive = /^\/\/([a-z])\//u.exec(base);
  const bases = drive ? [base, `//${drive[1]?.toUpperCase()}${base.slice(3)}`] : [base];
  return ["Read", "Edit"].flatMap((tool) =>
    bases.flatMap((root) => PRIVATE_PATTERNS.map((pattern) => `${tool}(${root}/${pattern})`)),
  );
}

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
    /**
     * Nobody answers prompts as they come, as in a buddy's chat or job. Claude's own question and plan tools are
     * turned off, since they wait for an answer, and read-only runs in dontAsk mode, which refuses anything not
     * already allowed instead of asking. Plan mode would write a plan and wait for it to be approved.
     */
    unattended?: boolean;
    model?: string;
    sessionId?: string;
    resumeSessionId?: string;
    mcpConfig?: string;
    /** The session's display name. Naming it up front saves the request Claude Code otherwise makes to name it. */
    name?: string;
    /** Tokens at which Claude summarizes older context, from 100k to 1M. Omitted keeps Claude's own setting. */
    autoCompactTokens?: number;
    /** A file of instructions added after Claude Code's own system prompt. */
    appendSystemPromptFile?: string;
    /** ZLI's data folder: an unattended agent's file tools are refused on ZLI's own files there. */
    privateDir?: string;
  } = {},
): string[] {
  const args: string[] =
    input.unattended && input.permissionMode === "read-only"
      ? [...BASE_ARGS, "--permission-mode", "dontAsk", "--disallowedTools", ...UNATTENDED_OFF, ...READ_ONLY_OFF]
      : input.permissionMode === "supervised" || input.permissionMode === "read-only"
        ? [
            ...BASE_ARGS,
            "--permission-mode",
            input.permissionMode === "read-only" ? "plan" : "acceptEdits",
            "--permission-prompt-tool",
            "stdio",
          ]
        : [...CLAUDE_SESSION_ARGS];
  const privateRules = input.unattended && input.privateDir ? privateFileRules(input.privateDir) : [];
  if (input.unattended && input.permissionMode === "read-only") args.push(...privateRules);
  else if (input.unattended) args.push("--disallowedTools", ...UNATTENDED_OFF, ...privateRules);
  // A buddy works on its own brief: only the project's settings load, not the person's own plugins and hooks.
  if (input.unattended) args.push("--setting-sources", "project");
  if (input.model) args.push("--model", input.model);
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  else if (input.sessionId) args.push("--session-id", input.sessionId);
  if (input.name?.trim()) args.push("--name", input.name.trim());
  if (input.autoCompactTokens !== undefined) args.push("--autocompact", String(input.autoCompactTokens));
  if (input.appendSystemPromptFile) args.push("--append-system-prompt-file", input.appendSystemPromptFile);
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
