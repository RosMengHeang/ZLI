import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, posix, win32 } from "node:path";

import type {
  ListedProviderKind,
  ProviderDiscovery,
  ProviderUpdateInfo,
  ProviderUpdateMethod,
} from "@zli-v2/contracts";
import { killProcessTree, spawnCli } from "@zli-v2/shared";

import { pathKey } from "../browser-tool/browserTool.js";

/** The npm package behind each agent CLI that ships through npm. */
const NPM_PACKAGES: Partial<Record<ListedProviderKind, string>> = {
  codex: "@openai/codex",
  "claude-code": "@anthropic-ai/claude-code",
  opencode: "opencode-ai",
  gemini: "@google/gemini-cli",
  copilot: "@github/copilot",
  qwen: "@qwen-code/qwen-code",
};

/** Agents whose CLI updates itself with this subcommand when no package manager owns it. */
const SELF_UPDATE: Partial<Record<ListedProviderKind, readonly string[]>> = {
  "claude-code": ["update"],
  "cursor-agent": ["update"],
  opencode: ["upgrade"],
  goose: ["update"],
};

export type UpdatePlan = {
  method: ProviderUpdateMethod;
  /** What to spawn; missing for a manual install. */
  command?: string;
  args?: readonly string[];
  /** The command as a person would type it. */
  display?: string;
  /** Where the newest version is looked up. */
  npmPackage?: string;
};

/**
 * Works out who installed the CLI from where its executable lives, and the command that updates it there.
 * A path ZLI does not recognise falls back to the CLI's own update command, or to a command shown but
 * never run, so ZLI never updates a copy other than the one it launches.
 */
export function planProviderUpdate(
  provider: ListedProviderKind,
  executable: string,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): UpdatePlan {
  const path = executable.replaceAll("\\", "/").toLowerCase();
  const npmPackage = NPM_PACKAGES[provider];
  const windows = platform === "win32";
  const tool = (name: string) => (windows ? `${name}.cmd` : name);
  const pkg = npmPackage ? `${npmPackage}@latest` : undefined;
  const base = npmPackage ? { npmPackage } : {};

  if (pkg) {
    if (path.includes("/.bun/")) return run("bun", windows ? "bun.exe" : "bun", ["add", "-g", pkg], base);
    if (path.includes("/pnpm/") || path.includes("/.pnpm") || path.includes("pnpm-global")) {
      return run("pnpm", tool("pnpm"), ["add", "-g", pkg], base);
    }
    if (path.includes("/.volta/")) return run("volta", windows ? "volta.exe" : "volta", ["install", pkg], base);
    if (path.includes("/yarn/")) return run("yarn", tool("yarn"), ["global", "add", pkg], base);
    const prefix = npmPrefix(executable, path, platform);
    if (prefix !== undefined || path.includes("/node_modules/")) {
      // The npm that sits beside the CLI owns its global folder, so it updates the same copy.
      const ownNpm = windows && prefix ? win32.join(prefix, "npm.cmd") : undefined;
      const npm = ownNpm && exists(ownNpm) ? ownNpm : tool("npm");
      return run("npm", npm, ["install", "-g", ...(prefix ? ["--prefix", prefix] : []), pkg], base);
    }
  }
  const self = SELF_UPDATE[provider];
  if (self) {
    const name = (windows ? win32 : posix).basename(executable).replace(/\.(exe|cmd|bat|ps1)$/iu, "");
    return {
      method: "self",
      command: executable,
      args: self,
      display: [name, ...self].join(" "),
      ...base,
    };
  }
  return { method: "manual", ...(pkg ? { display: `npm install -g ${pkg}` } : {}), ...base };
}

function run(method: ProviderUpdateMethod, command: string, args: readonly string[], base: object): UpdatePlan {
  return { method, command, args, display: [method, ...args].join(" "), ...base };
}

/**
 * The npm prefix that owns a global shim, when the path proves it: %APPDATA%\npm or a Node install folder
 * on Windows, <prefix>/bin elsewhere. Undefined when the shim could belong to something else.
 */
function npmPrefix(executable: string, path: string, platform: NodeJS.Platform): string | undefined {
  if (platform === "win32") {
    const folder = win32.dirname(executable);
    const lower = folder.replaceAll("\\", "/").toLowerCase();
    return lower.endsWith("/appdata/roaming/npm") || lower.endsWith("/nodejs") || lower.includes("/nvm/")
      ? folder
      : undefined;
  }
  if (!/\/(\.nvm|\.npm-global|\.npm|nodenv|fnm|n)\//u.test(path) && !path.startsWith("/usr/local/bin/")) {
    return undefined;
  }
  const folder = dirname(executable);
  return folder.endsWith("/bin") ? dirname(folder) : undefined;
}

/** The first x.y.z in a CLI's version line, such as "2.1.3 (Claude Code)". */
export function parseVersion(text: string | undefined): string | undefined {
  return text?.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u)?.[0];
}

/** Negative when a is older than b. Pre-releases sort before their release. */
export function compareVersions(a: string, b: string): number {
  const [mainA = "", preA] = a.split("-", 2);
  const [mainB = "", preB] = b.split("-", 2);
  const partsA = mainA.split(".").map(Number);
  const partsB = mainB.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const LATEST_FOUND_MS = 60 * 60_000;
const LATEST_MISSING_MS = 60_000;
const latestCache = new Map<string, { expiresAt: number; value: Promise<string | undefined> }>();

/** The `latest` tag on the npm registry, cached for an hour (a minute when the lookup failed). */
export function latestNpmVersion(
  npmPackage: string,
  fetchImpl: Fetch = fetch as unknown as Fetch,
  now: () => number = Date.now,
): Promise<string | undefined> {
  const cached = latestCache.get(npmPackage);
  if (cached && cached.expiresAt > now()) return cached.value;
  const value = (async () => {
    try {
      const response = await fetchImpl(`https://registry.npmjs.org/${npmPackage}/latest`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { version?: unknown };
      return typeof body.version === "string" ? parseVersion(body.version) : undefined;
    } catch {
      return undefined;
    }
  })();
  const entry = { expiresAt: now() + LATEST_FOUND_MS, value };
  latestCache.set(npmPackage, entry);
  void value.then((version) => {
    if (!version && latestCache.get(npmPackage) === entry) entry.expiresAt = now() + LATEST_MISSING_MS;
  });
  return value;
}

export function forgetLatestVersions(): void {
  latestCache.clear();
}

/** Each found agent against its newest version. Missing agents are left out. */
export async function checkProviderUpdates(
  providers: readonly ProviderDiscovery[],
  options: { platform?: NodeJS.Platform; latest?: (npmPackage: string) => Promise<string | undefined> } = {},
): Promise<ProviderUpdateInfo[]> {
  const latestOf = options.latest ?? ((npmPackage: string) => latestNpmVersion(npmPackage));
  return Promise.all(
    providers.flatMap((entry) => {
      if (entry.status !== "found") return [];
      return [
        (async (): Promise<ProviderUpdateInfo> => {
          const plan = planProviderUpdate(entry.provider, entry.path, options.platform);
          const current = parseVersion(entry.version);
          const latest = plan.npmPackage ? await latestOf(plan.npmPackage) : undefined;
          const status = current && latest ? (compareVersions(current, latest) < 0 ? "behind" : "current") : "unknown";
          return {
            provider: entry.provider,
            displayName: entry.displayName,
            ...(current ? { current } : {}),
            ...(latest ? { latest } : {}),
            status,
            method: plan.method,
            canUpdate: plan.command !== undefined,
            ...(plan.display ? { command: plan.display } : {}),
          };
        })(),
      ];
    }),
  );
}

const UPDATE_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 4_000;
/**
 * The full path of a bare Windows command such as "npm.cmd", found on PATH. Elsewhere, or when it is
 * already a path or is not found, the name comes back as it was.
 */
export function fullCommandPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform !== "win32" || /[\\/]/u.test(command)) return command;
  const extensions = win32.extname(command) ? [""] : [".exe", ".cmd", ".bat"];
  for (const dir of (env[pathKey(env, platform)] ?? "").split(";")) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = win32.join(dir, `${command}${extension}`);
      if (exists(candidate)) return candidate;
    }
  }
  return command;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal color codes start with ESC.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;

export type UpdateRun = { ok: boolean; output: string };

/** Runs an update command without a terminal, keeping the end of what it printed. */
export function runUpdateCommand(
  command: string,
  args: readonly string[],
  spawn: (command: string, args: readonly string[]) => ChildProcess = (file, list) =>
    // A bare "npm.cmd" run through cmd.exe sees the working folder as its own and cannot find npm,
    // so the command is resolved to its full path first.
    spawnCli(fullCommandPath(file), list, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }),
  timeoutMs = UPDATE_TIMEOUT_MS,
): Promise<UpdateRun> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args);
    } catch (error) {
      resolve({ ok: false, output: error instanceof Error ? error.message : String(error) });
      return;
    }
    let output = "";
    let settled = false;
    const finish = (ok: boolean, extra?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = `${output}${extra ? `\n${extra}` : ""}`.replace(ANSI, "").trim();
      resolve({ ok, output: text.slice(-OUTPUT_LIMIT) });
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(false, "The update took longer than 10 minutes and was stopped.");
    }, timeoutMs);
    const collect = (chunk: Buffer | string) => {
      output = (output + chunk.toString()).slice(-OUTPUT_LIMIT * 2);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => finish(false, error.message));
    child.once("close", (code) => finish(code === 0));
  });
}
