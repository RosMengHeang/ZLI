import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ZliBrowserCall } from "./client.js";

export const CLI_HELP = `zli-browser: drive the browser pane built into ZLI.

Usage:
  zli-browser mcp                         Run as an MCP server over stdio.
  zli-browser open <url> [--new-tab]      Open a URL and show it in the Browser panel.
  zli-browser navigate <url>              Load a URL in the current tab.
  zli-browser back | forward | reload [--hard]
  zli-browser tabs                        List this worktree's browser tabs.
  zli-browser snapshot                    Print URL, title, text, and interactive elements.
  zli-browser click <selector>            Also: --text <label>, or --x <n> --y <n>.
  zli-browser fill <selector> <value>
  zli-browser press <key>                 For example Enter, Escape, Control+A.
  zli-browser wait [--selector <css>] [--idle <ms>] [--timeout <ms>]
  zli-browser eval <expression>
  zli-browser screenshot [file.png] [--full-page] [--jpeg]
  zli-browser console [--clear]
  zli-browser network
  zli-browser viewport <preset|WIDTHxHEIGHT|reset> [--mobile] [--dpr <n>]
  zli-browser close

Options for every command:
  --cwd <dir>        Directory used to pick the ZLI worktree (default: current directory).
  --worktree <id>    Use this ZLI worktree id.
  --tab <id>         Use this browser tab id.
`;

export type CliCommand =
  | { kind: "help" }
  | { kind: "mcp" }
  | { kind: "call"; action: string; input: Record<string, unknown>; screenshotPath?: string };

export class CliUsageError extends Error {}

const VALUE_FLAGS = new Set(["cwd", "worktree", "tab", "text", "x", "y", "selector", "idle", "timeout", "dpr"]);
const BOOLEAN_FLAGS = new Set(["new-tab", "hard", "full-page", "jpeg", "clear", "mobile", "help"]);

export function parseCliArgs(argv: readonly string[]): CliCommand {
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
      if (value === undefined) throw new CliUsageError(`--${name} needs a value.`);
      flags.set(name, value);
    } else throw new CliUsageError(`Unknown option --${name}.`);
  }
  const [command, ...rest] = positional;
  if (flags.has("help") || command === undefined || command === "help") return { kind: "help" };
  if (command === "mcp") return { kind: "mcp" };

  const input: Record<string, unknown> = {};
  const text = (name: string) => {
    const value = flags.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const number = (name: string) => {
    const value = text(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new CliUsageError(`--${name} must be a number.`);
    return parsed;
  };
  const need = (value: string | undefined, what: string) => {
    if (value === undefined || value === "") throw new CliUsageError(`${command} needs ${what}.`);
    return value;
  };
  if (text("cwd") !== undefined) input.cwd = resolve(text("cwd") ?? ".");
  if (text("worktree") !== undefined) input.worktreeId = text("worktree");
  if (text("tab") !== undefined) input.browserTabId = text("tab");

  switch (command) {
    case "open":
      input.url = need(rest[0], "a URL");
      if (flags.has("new-tab")) input.newTab = true;
      return { kind: "call", action: "open", input };
    case "navigate":
      input.url = need(rest[0], "a URL");
      return { kind: "call", action: "navigate", input };
    case "back":
    case "forward":
    case "tabs":
    case "snapshot":
    case "network":
    case "close":
      return { kind: "call", action: command, input };
    case "reload":
      if (flags.has("hard")) input.hard = true;
      return { kind: "call", action: "reload", input };
    case "click": {
      const x = number("x");
      const y = number("y");
      if (text("text") !== undefined) input.text = text("text");
      else if (x !== undefined || y !== undefined) {
        if (x === undefined || y === undefined) throw new CliUsageError("click needs both --x and --y.");
        input.x = x;
        input.y = y;
      } else input.selector = need(rest[0], "a selector, --text, or --x and --y");
      return { kind: "call", action: "click", input };
    }
    case "fill":
      input.selector = need(rest[0], "a selector");
      if (rest[1] === undefined) throw new CliUsageError("fill needs a value.");
      input.value = rest[1];
      return { kind: "call", action: "fill", input };
    case "press":
      input.key = need(rest[0], "a key");
      return { kind: "call", action: "press", input };
    case "wait": {
      const idle = number("idle");
      const timeout = number("timeout");
      if (text("selector") !== undefined) input.selector = text("selector");
      if (idle !== undefined) input.idleMs = idle;
      if (timeout !== undefined) input.timeoutMs = timeout;
      return { kind: "call", action: "wait", input };
    }
    case "eval":
    case "evaluate":
      input.expression = need(rest.join(" ").trim() || undefined, "an expression");
      return { kind: "call", action: "evaluate", input };
    case "screenshot": {
      if (flags.has("full-page")) input.fullPage = true;
      if (flags.has("jpeg")) input.format = "jpeg";
      const extension = flags.has("jpeg") ? "jpg" : "png";
      return {
        kind: "call",
        action: "screenshot",
        input,
        screenshotPath: rest[0] ?? `zli-browser-screenshot-${Date.now()}.${extension}`,
      };
    }
    case "console":
      if (flags.has("clear")) input.clear = true;
      return { kind: "call", action: "console", input };
    case "viewport": {
      const target = need(rest[0], "a preset, WIDTHxHEIGHT, or reset");
      const size = /^(\d+)x(\d+)$/iu.exec(target);
      const dpr = number("dpr");
      if (target === "reset") input.reset = true;
      else if (size) {
        input.width = Number(size[1]);
        input.height = Number(size[2]);
        input.mobile = flags.has("mobile");
        if (dpr !== undefined) input.deviceScaleFactor = dpr;
      } else input.preset = target;
      return { kind: "call", action: "viewport", input };
    }
    default:
      throw new CliUsageError(`Unknown command ${command}. Run zli-browser --help.`);
  }
}

export type CliIo = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly cwd: () => string;
  readonly writeFile?: (path: string, data: Buffer) => Promise<void>;
};

/** Runs one CLI command. Returns the process exit code. */
export async function runCli(command: CliCommand, call: ZliBrowserCall, io: CliIo): Promise<number> {
  if (command.kind === "help") {
    io.stdout(CLI_HELP);
    return 0;
  }
  if (command.kind === "mcp") throw new Error("Use serveMcpOverStdio for the mcp command.");
  try {
    const result = await call(command.action, command.input);
    if (command.screenshotPath !== undefined && isRecord(result) && typeof result.data === "string") {
      const path = resolve(io.cwd(), command.screenshotPath);
      await (io.writeFile ?? ((target, data) => writeFile(target, data)))(path, Buffer.from(result.data, "base64"));
      io.stdout(`${path}\n`);
      return 0;
    }
    io.stdout(`${JSON.stringify(result ?? null, null, 2)}\n`);
    return 0;
  } catch (cause) {
    io.stderr(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
