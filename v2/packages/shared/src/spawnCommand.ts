import { type ChildProcess, type SpawnOptions, spawn, spawnSync } from "node:child_process";

export type SpawnPlan = {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
  wrapped: boolean;
};

const CMD_META = /([()\][%!^"`<>&|;, *?])/gu;

/**
 * Node refuses to spawn .cmd/.bat files without a shell (CVE-2024-27980), and
 * cannot run .ps1 at all. npm, Cursor, and Claude installers ship those shims
 * on Windows, so they are routed through cmd.exe or PowerShell explicitly with
 * cross-spawn style escaping instead of `shell: true`.
 */
export function planSpawn(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): SpawnPlan {
  if (platform !== "win32") return { command, args: [...args], windowsVerbatimArguments: false, wrapped: false };
  const lower = command.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    const line = [quoteCmdArgument(command), ...args.map(quoteCmdArgument)].join(" ");
    return {
      command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      windowsVerbatimArguments: true,
      wrapped: true,
    };
  }
  if (lower.endsWith(".ps1")) {
    return {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
      windowsVerbatimArguments: false,
      wrapped: true,
    };
  }
  return { command, args: [...args], windowsVerbatimArguments: false, wrapped: false };
}

export function quoteCmdArgument(value: string): string {
  const quoted = `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\*)$/u, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1");
}

/**
 * A wrapper shell does not forward signals, so stopping only cmd.exe would
 * orphan the real CLI. taskkill /T ends the whole tree on Windows.
 */
export function killProcessTree(
  child: { pid?: number | undefined; kill(signal?: NodeJS.Signals): boolean },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32" && child.pid !== undefined) {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    if (result.status === 0) return true;
  }
  return child.kill();
}

/** Spawns a CLI without a shell, routing Windows shims through planSpawn and tree-killing wrapped processes. */
export function spawnCli(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  const plan = planSpawn(command, args, process.platform, options.env ?? process.env);
  const child = spawn(plan.command, plan.args, {
    ...options,
    shell: false,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
  if (plan.wrapped) {
    const original = child.kill.bind(child);
    child.kill = (signal?: NodeJS.Signals | number) =>
      killProcessTree({ pid: child.pid, kill: () => original(signal) });
  }
  return child;
}
