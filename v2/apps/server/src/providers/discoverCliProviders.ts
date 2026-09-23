import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { posix, win32 } from "node:path";

import type { ProviderDiscovery } from "@zli-v2/contracts";

/** Codex, Claude Code, and Cursor only. OpenCode is not a selectable provider. */
const LISTED = [
  { provider: "codex", displayName: "Codex", binary: "codex" },
  { provider: "claude-code", displayName: "Claude Code", binary: "claude" },
  { provider: "cursor-agent", displayName: "Cursor", binary: "cursor-agent" },
] as const;

type ListedSpec = (typeof LISTED)[number];

export type CliProbe = {
  pathEntries: readonly string[];
  homeDir?: string;
  localAppData?: string;
  platform: NodeJS.Platform;
  fileExists(filePath: string): boolean;
  readVersion?(command: string): Promise<string | undefined>;
};

const VERSION_TIMEOUT_MS = 1_000;

export function createDefaultCliProbe(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CliProbe {
  const api = platform === "win32" ? win32 : posix;
  const homeDir = platform === "win32" ? env.USERPROFILE : env.HOME;
  const localAppData = env.LOCALAPPDATA;
  return {
    pathEntries: (env.PATH ?? "").split(api.delimiter).filter((entry) => entry.length > 0),
    ...(homeDir ? { homeDir } : {}),
    ...(localAppData ? { localAppData } : {}),
    platform,
    fileExists: (filePath) => fileLooksExecutable(filePath, platform),
    readVersion: (command) => readCliVersion(command),
  };
}

export function fileLooksExecutable(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === "win32") return true;
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function unavailableProviderDiscovery(reason = "Provider discovery failed."): ProviderDiscovery[] {
  return LISTED.map((spec) => ({
    provider: spec.provider,
    displayName: spec.displayName,
    status: "missing",
    reason,
  }));
}

export async function discoverCliProviders(probe: CliProbe): Promise<ProviderDiscovery[]> {
  return Promise.all(LISTED.map((spec) => discoverOne(spec, probe)));
}

/** Bounded `--version` read. This does not start an agent session. */
export function readCliVersion(
  command: string,
  args: readonly string[] = ["--version"],
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve(undefined);
      return;
    }
    child.unref();
    let settled = false;
    let output = "";
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(sanitizeVersion(value));
    };
    const timer = setTimeout(() => {
      killChild(child);
      finish(output);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (output.length < 240) output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (output.length < 240) output += chunk.toString();
    });
    child.once("error", () => finish(undefined));
    child.once("close", () => finish(output));
  });
}

export function sanitizeVersion(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const line = value
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return undefined;
  const compact = line.replace(/\s+/gu, " ").slice(0, 80);
  return compact.length > 0 ? compact : undefined;
}

async function discoverOne(spec: ListedSpec, probe: CliProbe): Promise<ProviderDiscovery> {
  const path = firstExisting(spec, probe);
  if (!path) {
    return {
      provider: spec.provider,
      displayName: spec.displayName,
      status: "missing",
      reason: `${spec.displayName} CLI was not found on PATH or in known install locations.`,
    };
  }
  const version = await readFoundVersion(probe, path);
  return version
    ? { provider: spec.provider, displayName: spec.displayName, status: "found", path, version }
    : { provider: spec.provider, displayName: spec.displayName, status: "found", path };
}

function firstExisting(spec: ListedSpec, probe: CliProbe): string | undefined {
  for (const candidate of candidatePaths(spec, probe)) {
    if (exists(probe, candidate)) return candidate;
  }
  return undefined;
}

function candidatePaths(spec: ListedSpec, probe: CliProbe): readonly string[] {
  const api = probe.platform === "win32" ? win32 : posix;
  const names = commandFileNames(spec.binary, probe.platform);
  const fromPath = probe.pathEntries.flatMap((dir) => names.map((name) => api.join(dir, name)));
  return [...fromPath, ...knownPaths(spec, probe, api)];
}

function knownPaths(spec: ListedSpec, probe: CliProbe, api: typeof posix | typeof win32): readonly string[] {
  const dirs = installDirs(spec, probe, api);
  const paths: string[] = [];
  for (const dir of dirs) {
    for (const name of commandFileNames(spec.binary, probe.platform)) paths.push(api.join(dir, name));
    if (spec.provider === "cursor-agent" && cursorAliasDir(dir)) {
      for (const name of commandFileNames("agent", probe.platform)) paths.push(api.join(dir, name));
    }
  }
  return paths;
}

function installDirs(spec: ListedSpec, probe: CliProbe, api: typeof posix | typeof win32): string[] {
  const dirs: string[] = [];
  if (probe.homeDir) {
    dirs.push(api.join(probe.homeDir, ".local", "bin"));
    if (spec.provider === "claude-code") dirs.push(api.join(probe.homeDir, ".claude", "local"));
    if (spec.provider === "cursor-agent") {
      dirs.push(api.join(probe.homeDir, ".cursor", "bin"));
      dirs.push(api.join(probe.homeDir, ".local", "share", "cursor-agent"));
    }
  }
  if (probe.platform === "win32" && probe.localAppData && spec.provider === "cursor-agent") {
    dirs.push(api.join(probe.localAppData, "cursor-agent"));
  }
  if (probe.platform !== "win32") dirs.push("/usr/local/bin", "/opt/homebrew/bin");
  return dirs;
}

function commandFileNames(binary: string, platform: NodeJS.Platform): readonly string[] {
  if (platform === "win32") return [`${binary}.exe`, `${binary}.cmd`, `${binary}.ps1`, binary];
  return [binary];
}

function cursorAliasDir(dir: string): boolean {
  const normalized = dir.replaceAll("\\", "/").toLowerCase();
  return normalized.endsWith("/.cursor/bin") || normalized.endsWith("/cursor-agent");
}

function exists(probe: CliProbe, filePath: string): boolean {
  try {
    return probe.fileExists(filePath);
  } catch {
    return false;
  }
}

async function readFoundVersion(probe: CliProbe, command: string): Promise<string | undefined> {
  if (!probe.readVersion) return undefined;
  try {
    return sanitizeVersion(await probe.readVersion(command));
  } catch {
    return undefined;
  }
}

function killChild(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    child.kill();
  }
}
