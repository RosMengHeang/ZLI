import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ZliBrowserCall } from "../browser-tool/client.js";

export const ZLI_MOBILE_HELP = `zli-mobile: drive the phones and simulators in ZLI's Mobile panel.

Usage:
  zli-mobile mcp                           Run as an MCP server over stdio.
  zli-mobile devices                       List devices, their ids, and who is using them.
  zli-mobile boot [--platform android|ios] [--window] [--wipe-data]
  zli-mobile shutdown
  zli-mobile install <app.apk|App.app>
  zli-mobile launch <appId> [--stop]       Start an app by package name or bundle id.
  zli-mobile open <url>                    Open a URL or deep link, such as exp://localhost:8081.
  zli-mobile snapshot                      Print the screen's elements and their refs.
  zli-mobile tap <ref> [--long]            Or: zli-mobile tap --x <n> --y <n>.
  zli-mobile swipe <up|down|left|right>    Or: --from <x,y> --to <x,y>. Also --duration <ms>.
  zli-mobile type <text> [--ref <ref>]
  zli-mobile press <button>                back, home, recents, power, volume_up, volume_down, enter, delete,
                                           tab, dpad_up, dpad_down, dpad_left, dpad_right.
  zli-mobile rotate [orientation]          portrait, landscape, portrait-reverse, landscape-reverse.
  zli-mobile screenshot [file.png]
  zli-mobile logs [--app <id>] [--lines <n>] [--filter <text>]
  zli-mobile release                       Hand your devices back.

Options for every command:
  --device <id>      Use this deviceId from zli-mobile devices.
  --cwd <dir>        Directory used to pick the ZLI worktree (default: current directory).
  --worktree <id>    Use this ZLI worktree id.
`;

export type MobileCliCommand =
  | { kind: "help" }
  | { kind: "mcp" }
  | { kind: "call"; action: string; input: Record<string, unknown>; screenshotPath?: string };

export class MobileCliUsageError extends Error {}

const VALUE_FLAGS = new Set([
  "cwd",
  "worktree",
  "device",
  "platform",
  "x",
  "y",
  "from",
  "to",
  "duration",
  "ref",
  "app",
  "lines",
  "filter",
]);
const BOOLEAN_FLAGS = new Set(["window", "wipe-data", "stop", "long", "help"]);

export function parseMobileArgs(argv: readonly string[], cwd: () => string = () => process.cwd()): MobileCliCommand {
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
      if (value === undefined) throw new MobileCliUsageError(`--${name} needs a value.`);
      flags.set(name, value);
    } else throw new MobileCliUsageError(`Unknown option --${name}.`);
  }
  const [command, ...rest] = positional;
  if (flags.has("help") || command === undefined || command === "help") return { kind: "help" };
  if (command === "mcp") return { kind: "mcp" };

  const text = (name: string) => {
    const value = flags.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const need = (value: string | undefined, what: string) => {
    if (value === undefined || value.trim() === "") throw new MobileCliUsageError(`${command} needs ${what}.`);
    return value;
  };
  const number = (name: string) => {
    const value = text(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0)
      throw new MobileCliUsageError(`--${name} must be a number of 0 or more.`);
    return parsed;
  };
  const point = (name: string) => {
    const value = text(name);
    if (value === undefined) return undefined;
    const match = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/u.exec(value);
    if (!match) throw new MobileCliUsageError(`--${name} takes x,y, for example 540,1200.`);
    return { x: Number(match[1]), y: Number(match[2]) };
  };
  const input: Record<string, unknown> = {};
  if (text("cwd") !== undefined) input.cwd = resolve(text("cwd") ?? ".");
  if (text("worktree") !== undefined) input.worktreeId = text("worktree");
  if (text("device") !== undefined) input.deviceId = text("device");

  switch (command) {
    case "devices":
    case "list":
      return { kind: "call", action: "mobiledevices", input };
    case "boot":
      if (text("platform") !== undefined) input.platform = text("platform");
      if (flags.has("window")) input.window = true;
      if (flags.has("wipe-data")) input.wipeData = true;
      return { kind: "call", action: "mobileboot", input };
    case "shutdown":
      return { kind: "call", action: "mobileshutdown", input };
    case "install":
      input.path = resolve(typeof input.cwd === "string" ? input.cwd : cwd(), need(rest[0], "an .apk or .app path"));
      return { kind: "call", action: "mobileinstall", input };
    case "launch":
      input.appId = need(rest[0], "an app id such as com.example.app");
      if (flags.has("stop")) input.stop = true;
      return { kind: "call", action: "mobilelaunch", input };
    case "open":
      input.url = need(rest[0], "a URL");
      return { kind: "call", action: "mobileopenurl", input };
    case "snapshot":
      return { kind: "call", action: "mobilesnapshot", input };
    case "tap": {
      const x = number("x");
      const y = number("y");
      if (rest[0] !== undefined) input.ref = rest[0];
      else if (x !== undefined && y !== undefined) Object.assign(input, { x, y });
      else throw new MobileCliUsageError("tap needs a ref from snapshot, or --x and --y.");
      if (flags.has("long")) input.longPress = true;
      return { kind: "call", action: "mobiletap", input };
    }
    case "swipe": {
      const from = point("from");
      const to = point("to");
      if (rest[0] !== undefined) input.direction = rest[0];
      else if (from && to) Object.assign(input, { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y });
      else throw new MobileCliUsageError("swipe needs a direction, or --from and --to.");
      const duration = number("duration");
      if (duration !== undefined) input.durationMs = Math.round(duration);
      return { kind: "call", action: "mobileswipe", input };
    }
    case "type":
      input.text = need(rest.join(" ") || undefined, "text to type");
      if (text("ref") !== undefined) input.ref = text("ref");
      return { kind: "call", action: "mobiletype", input };
    case "press":
      input.button = need(rest[0], "a button such as home or back");
      return { kind: "call", action: "mobilepress", input };
    case "rotate":
      if (rest[0] !== undefined) input.orientation = rest[0];
      return { kind: "call", action: "mobilerotate", input };
    case "screenshot":
      return {
        kind: "call",
        action: "mobilescreenshot",
        input,
        screenshotPath: rest[0] ?? `zli-mobile-${new Date().toISOString().replace(/[:.]/gu, "-")}.png`,
      };
    case "logs": {
      if (text("app") !== undefined) input.appId = text("app");
      if (text("filter") !== undefined) input.filter = text("filter");
      const lines = number("lines");
      if (lines !== undefined) input.lines = Math.round(lines);
      return { kind: "call", action: "mobilelogs", input };
    }
    case "release":
      return { kind: "call", action: "mobilerelease", input };
    default:
      throw new MobileCliUsageError(`Unknown command ${command}. Run zli-mobile --help.`);
  }
}

export type MobileCliIo = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly cwd: () => string;
  readonly writeFile?: (path: string, data: Buffer) => Promise<void>;
};

/** Runs one command and returns the exit code. The snapshot tree and logs print as text; the rest as JSON. */
export async function runMobileCli(command: MobileCliCommand, call: ZliBrowserCall, io: MobileCliIo): Promise<number> {
  if (command.kind === "help") {
    io.stdout(ZLI_MOBILE_HELP);
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
    if (command.action === "mobilesnapshot" && isRecord(result) && typeof result.tree === "string") {
      io.stdout(`${result.tree}\n`);
      return 0;
    }
    if (command.action === "mobilelogs" && isRecord(result) && typeof result.log === "string") {
      io.stdout(result.log ? `${result.log}\n` : "");
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
