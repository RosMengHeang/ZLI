import { resolve } from "node:path";

import type { ZliBrowserCall } from "../browser-tool/client.js";

export const ZLI_CLI_HELP = `zli: work with the other agents in ZLI.

Usage:
  zli mcp                          Run as an MCP server over stdio.
  zli agents                       List the agents in this project with their names and ids.
      --all-projects               Also list agents in other projects, when Settings allow it.
  zli read <agent> [--limit <n>]   Show an agent's recent messages or terminal output.
  zli send <agent> <message>       Send a message to another agent.
  zli start <provider> <task>      Start an agent on a task in a new worktree.
      --name <name>                Name the agent, such as bob, to use in place of its id.
      --terminal                   Run the agent's CLI in a terminal instead of a chat.
      --same-worktree              Work in this worktree instead of a new one.
      --branch <name>              Branch name for the new worktree.
      --model <id>                 Model to use.
  zli connect <service> [reason]   Ask the person to connect a service such as github or linear.

<agent> is a name or id from zli agents. For an agent in another project, write
project/agent or add --project <name>. Settings have to let agents reach every project.

Options for every command:
  --cwd <dir>        Directory used to pick the ZLI worktree (default: current directory).
  --worktree <id>    Use this ZLI worktree id.
`;

export type ZliCommand =
  | { kind: "help" }
  | { kind: "mcp" }
  | { kind: "call"; action: string; input: Record<string, unknown> };

export class ZliUsageError extends Error {}

const VALUE_FLAGS = new Set(["cwd", "worktree", "limit", "branch", "model", "name", "project"]);
const BOOLEAN_FLAGS = new Set(["terminal", "same-worktree", "all-projects", "help"]);

export function parseZliArgs(argv: readonly string[]): ZliCommand {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "-h") {
      flags.set("help", true);
      continue;
    }
    if (argument === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const [name = "", inline] = argument.slice(2).split(/=(.*)/su);
    if (BOOLEAN_FLAGS.has(name)) flags.set(name, true);
    else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++index];
      if (value === undefined) throw new ZliUsageError(`--${name} needs a value.`);
      flags.set(name, value);
    } else throw new ZliUsageError(`Unknown option --${name}.`);
  }
  const [command, ...rest] = positional;
  if (flags.has("help") || command === undefined || command === "help") return { kind: "help" };
  if (command === "mcp") return { kind: "mcp" };

  const text = (name: string) => {
    const value = flags.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const need = (value: string | undefined, what: string) => {
    if (value === undefined || value.trim() === "") throw new ZliUsageError(`${command} needs ${what}.`);
    return value;
  };
  const input: Record<string, unknown> = {};
  if (text("cwd") !== undefined) input.cwd = resolve(text("cwd") ?? ".");
  if (text("worktree") !== undefined) input.worktreeId = text("worktree");

  switch (command) {
    case "agents":
    case "list":
      if (flags.has("all-projects")) input.allProjects = true;
      return { kind: "call", action: "agentlist", input };
    case "read": {
      input.agent = need(rest[0], "an agent name or id");
      if (text("project") !== undefined) input.project = text("project");
      const limit = text("limit");
      if (limit !== undefined) {
        const parsed = Number(limit);
        if (!Number.isInteger(parsed) || parsed < 1) throw new ZliUsageError("--limit must be a whole number above 0.");
        input.limit = parsed;
      }
      return { kind: "call", action: "agentread", input };
    }
    case "send":
      input.agent = need(rest[0], "an agent name or id");
      if (text("project") !== undefined) input.project = text("project");
      input.text = need(rest.slice(1).join(" ").trim() || undefined, "a message");
      return { kind: "call", action: "agentsend", input };
    case "start":
      input.provider = need(rest[0], "a provider such as codex or claude-code");
      input.prompt = need(rest.slice(1).join(" ").trim() || undefined, "a task");
      if (flags.has("terminal")) input.mode = "terminal";
      if (flags.has("same-worktree")) input.worktree = "same";
      if (text("branch") !== undefined) input.branch = text("branch");
      if (text("model") !== undefined) input.model = text("model");
      if (text("name") !== undefined) input.name = text("name");
      return { kind: "call", action: "agentstart", input };
    case "connect": {
      input.service = need(rest[0], "a service such as github or linear");
      const reason = rest.slice(1).join(" ").trim();
      if (reason) input.reason = reason;
      return { kind: "call", action: "agentconnect", input };
    }
    default:
      throw new ZliUsageError(`Unknown command ${command}. Run zli --help.`);
  }
}

export type ZliIo = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};

/** Runs one command and returns the exit code. Terminal output prints as text; everything else as JSON. */
export async function runZli(command: ZliCommand, call: ZliBrowserCall, io: ZliIo): Promise<number> {
  if (command.kind === "help") {
    io.stdout(ZLI_CLI_HELP);
    return 0;
  }
  if (command.kind === "mcp") throw new Error("Use serveMcpOverStdio for the mcp command.");
  try {
    const result = await call(command.action, command.input);
    const output = !isRecord(result)
      ? undefined
      : typeof result.output === "string"
        ? result.output
        : command.action === "agentconnect" && typeof result.message === "string"
          ? result.message
          : undefined;
    io.stdout(output !== undefined ? `${output}\n` : `${JSON.stringify(result ?? null, null, 2)}\n`);
    return 0;
  } catch (cause) {
    io.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
