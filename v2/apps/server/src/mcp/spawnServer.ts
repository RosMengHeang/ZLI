import type { ChildProcess, StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

import { killProcessTree, spawnCli } from "@zli-v2/shared";

import { pathKey } from "../browser-tool/browserTool.js";

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * The file a bare command such as `npx` names on Windows. Without a shell, spawn finds only .exe files,
 * and npm puts .cmd shims on PATH.
 */
export function resolveServerCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform !== "win32" || /[\\/]/u.test(command)) return command;
  const extensions = (env.PATHEXT ?? DEFAULT_PATHEXT)
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith("."));
  if (extensions.includes(win32.extname(command).toLowerCase())) return command;
  const dirs = (env[pathKey(env, platform)] ?? "").split(";").filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = win32.join(dir, `${command}${extension}`);
      if (exists(candidate)) return candidate;
    }
  }
  return command;
}

/** Starts a local MCP server without a shell. Its env adds to ZLI's own, as agents do. */
export function spawnMcpServer(
  spec: { command: string; args: readonly string[]; env: Readonly<Record<string, string>> },
  stdio: StdioOptions,
): ChildProcess {
  const env = { ...process.env, ...spec.env };
  return spawnCli(resolveServerCommand(spec.command, env), spec.args, { env, stdio, windowsHide: true });
}

/** Ends the server and, on Windows, anything it started, such as the node process behind npx. */
export function stopMcpServer(child: ChildProcess): void {
  child.stdin?.end();
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    killProcessTree(child);
  } catch {
    // Already gone.
  }
}

const INSTALL_HINTS: Record<string, string> = {
  npx: "Install Node.js",
  npm: "Install Node.js",
  node: "Install Node.js",
  pnpm: "Install pnpm",
  uvx: "Install uv",
  uv: "Install uv",
  python: "Install Python",
  python3: "Install Python",
  docker: "Install Docker",
  bun: "Install Bun",
  bunx: "Install Bun",
  deno: "Install Deno",
};

/** What to tell the person when the server's command did not start. */
export function startProblem(command: string, error: unknown): string {
  const name = command.split(/[\\/]/u).at(-1) || command;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ENOENT") {
    const key = name.toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/u, "");
    const hint = INSTALL_HINTS[key] ?? `Check that ${name} is installed and on your PATH`;
    return `ZLI could not start ${name}. ${hint}, then try again.`;
  }
  if (code === "EACCES") {
    return `ZLI could not start ${name} because it is not allowed to run. Check its permissions, then try again.`;
  }
  const message = error instanceof Error ? error.message.replace(/\.+$/u, "") : String(error);
  return `ZLI could not start ${name}: ${message}.`;
}
