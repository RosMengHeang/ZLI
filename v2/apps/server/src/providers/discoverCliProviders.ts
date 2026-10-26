import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { posix, win32 } from "node:path";

import {
  type ListedProviderKind,
  type ProviderDiscovery,
  type ProviderModelOption,
  ReasoningEffort,
} from "@zli-v2/contracts";
import { spawnCli } from "@zli-v2/shared";

const LISTED = [
  { provider: "codex", displayName: "Codex", binary: "codex" },
  { provider: "claude-code", displayName: "Claude Code", binary: "claude" },
  { provider: "cursor-agent", displayName: "Cursor", binary: "cursor-agent" },
  { provider: "droid", displayName: "Droid", binary: "droid" },
  { provider: "opencode", displayName: "OpenCode", binary: "opencode" },
  { provider: "gemini", displayName: "Gemini", binary: "gemini" },
  { provider: "copilot", displayName: "GitHub Copilot", binary: "copilot" },
  { provider: "kimi", displayName: "Kimi Code", binary: "kimi" },
  { provider: "qwen", displayName: "Qwen Code", binary: "qwen" },
  { provider: "goose", displayName: "Goose", binary: "goose" },
] as const satisfies ReadonlyArray<{ provider: ListedProviderKind; displayName: string; binary: string }>;

/** CLIs distributed through npm or bun, whose global shims land outside PATH on some machines. */
const PACKAGE_MANAGER_CLIS: ReadonlySet<ListedProviderKind> = new Set(["opencode", "gemini", "copilot", "qwen"]);

/** Model ids a terminal launch accepts; OpenRouter aliases such as "openrouter/~x/y" are left out. */
const LAUNCHABLE_MODEL_ID = /^[A-Za-z0-9._:/[\]=,-]+$/u;

type ListedSpec = (typeof LISTED)[number];

export type CliProbe = {
  pathEntries: readonly string[];
  homeDir?: string;
  localAppData?: string;
  /** Roaming AppData on Windows, where npm puts global CLI shims. */
  appData?: string;
  platform: NodeJS.Platform;
  fileExists(filePath: string): boolean;
  readVersion?(command: string): Promise<string | undefined>;
  /** Models the CLI offers. Undefined means unknown, never "no models". */
  readModels?(provider: ListedProviderKind, command: string): Promise<readonly ProviderModelOption[] | undefined>;
};

const VERSION_TIMEOUT_MS = 1_000;
const MODEL_TIMEOUT_MS = 10_000;
/** Model lists change rarely and listing them spawns the CLI, so they outlive the 20 s discovery cache. */
const MODEL_CACHE_MS = 10 * 60_000;
const MODEL_FAILURE_CACHE_MS = 60_000;
const MAX_MODELS = 400;
const MAX_MODEL_OUTPUT_CHARS = 256_000;

/** Claude Code's --effort levels. Haiku takes none. */
const CLAUDE_CODE_REASONING = ["low", "medium", "high", "xhigh", "max"];

/** Claude Code accepts these aliases for its current models. */
export const CLAUDE_CODE_MODELS: readonly ProviderModelOption[] = [
  { id: "sonnet", label: "Sonnet", reasoningEfforts: CLAUDE_CODE_REASONING },
  { id: "opus", label: "Opus", reasoningEfforts: CLAUDE_CODE_REASONING },
  { id: "haiku", label: "Haiku", reasoningEfforts: [] },
];

/** Codex lists levels per model only over its app server, so this is the set its coding models share. */
const CODEX_REASONING = ["low", "medium", "high", "xhigh"];

/** Droid marks its own default model in the model list. */
const DROID_DEFAULT_LABEL = /\s+\(default\)$/u;

export function createDefaultCliProbe(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CliProbe {
  if (env.ZLI_TEST_PROVIDER === "mock") return mockCodexProbe(platform);
  const api = platform === "win32" ? win32 : posix;
  const homeDir = platform === "win32" ? env.USERPROFILE : env.HOME;
  const localAppData = env.LOCALAPPDATA;
  const appData = platform === "win32" ? env.APPDATA : undefined;
  return {
    pathEntries: (env.PATH ?? "").split(api.delimiter).filter((entry) => entry.length > 0),
    ...(homeDir ? { homeDir } : {}),
    ...(localAppData ? { localAppData } : {}),
    ...(appData ? { appData } : {}),
    platform,
    fileExists: (filePath) => fileLooksExecutable(filePath, platform),
    readVersion: (command) => readCliVersion(command),
    readModels: (provider, command) => readCachedCliModels(provider, command),
  };
}

/** The mock provider has no Codex binary. E2E still needs Start Codex enabled. */
function mockCodexProbe(platform: NodeJS.Platform): CliProbe {
  const api = platform === "win32" ? win32 : posix;
  const directory = platform === "win32" ? "C:\\zli\\mock-provider" : "/zli/mock-provider";
  const codexPath = api.join(directory, platform === "win32" ? "codex.exe" : "codex");
  return {
    pathEntries: [directory],
    platform,
    fileExists: (filePath) => filePath === codexPath,
    readVersion: async (command) => (command === codexPath ? "codex mock" : undefined),
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

/** Pass `models: false` when only the executable path matters, such as resolving a command to spawn. */
export async function discoverCliProviders(
  probe: CliProbe,
  options: { models?: boolean } = {},
): Promise<ProviderDiscovery[]> {
  const includeModels = options.models ?? true;
  return Promise.all(LISTED.map((spec) => discoverOne(spec, probe, includeModels)));
}

/** Bounded `--version` read. This does not start an agent session. */
export async function readCliVersion(
  command: string,
  args: readonly string[] = ["--version"],
  timeoutMs = VERSION_TIMEOUT_MS,
): Promise<string | undefined> {
  return sanitizeVersion(await readCliOutput(command, args, { timeoutMs, maxChars: 240, keepPartial: true }));
}

/**
 * Runs a short, non-agent CLI command and collects stdout and stderr. A command
 * still running at the timeout is killed; its partial output is kept only when asked.
 */
export function readCliOutput(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; maxChars: number; keepPartial?: boolean },
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnCli(command, args, {
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
      resolve(value);
    };
    const timer = setTimeout(() => {
      killChild(child);
      finish(options.keepPartial ? output : undefined);
    }, options.timeoutMs);
    const collect = (chunk: Buffer | string) => {
      if (output.length < options.maxChars) output += chunk.toString();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", () => finish(undefined));
    child.once("close", () => finish(output));
  });
}

const modelCache = new Map<string, { expiresAt: number; value: Promise<readonly ProviderModelOption[] | undefined> }>();

/** Shared across probes so session starts and discovery refreshes reuse one listing. */
export function readCachedCliModels(
  provider: ListedProviderKind,
  command: string,
  now: () => number = Date.now,
): Promise<readonly ProviderModelOption[] | undefined> {
  const key = `${provider}\u0000${command}`;
  const cached = modelCache.get(key);
  if (cached && cached.expiresAt > now()) return cached.value;
  const value = readCliModels(provider, command).catch(() => undefined);
  const entry = { expiresAt: now() + MODEL_CACHE_MS, value };
  modelCache.set(key, entry);
  void value.then((models) => {
    if (!models && modelCache.get(key) === entry) entry.expiresAt = now() + MODEL_FAILURE_CACHE_MS;
  });
  return value;
}

export async function readCliModels(
  provider: ListedProviderKind,
  command: string,
): Promise<readonly ProviderModelOption[] | undefined> {
  switch (provider) {
    case "claude-code":
      return CLAUDE_CODE_MODELS;
    case "cursor-agent":
      return parseCursorModels(
        await readCliOutput(command, ["models"], { timeoutMs: MODEL_TIMEOUT_MS, maxChars: MAX_MODEL_OUTPUT_CHARS }),
      );
    case "droid":
      return parseDroidModels(
        await readCliOutput(command, ["exec", "--help"], {
          timeoutMs: MODEL_TIMEOUT_MS,
          maxChars: MAX_MODEL_OUTPUT_CHARS,
        }),
      );
    case "opencode":
      return parseOpenCodeModels(
        await readCliOutput(command, ["models"], { timeoutMs: MODEL_TIMEOUT_MS, maxChars: MAX_MODEL_OUTPUT_CHARS }),
      );
    default:
      return undefined;
  }
}

/** `cursor-agent models` prints "Available models", then one "id - Label" row per model. */
export function parseCursorModels(output: string | undefined): ProviderModelOption[] | undefined {
  if (!output) return undefined;
  const models: ProviderModelOption[] = [];
  for (const raw of cleanLines(output)) {
    if (/^available models\b/iu.test(raw) || /^tip:/iu.test(raw)) continue;
    const match = /^(\S+)\s+-\s+(.+)$/u.exec(raw);
    if (match?.[1] && match[2]) pushModel(models, match[1], match[2]);
  }
  return models.length > 0 ? models : undefined;
}

/**
 * `droid exec --help` lists "Available Models:" as indented "id   Label" rows, then "Model details:"
 * with each label's reasoning levels.
 */
export function parseDroidModels(output: string | undefined): ProviderModelOption[] | undefined {
  if (!output) return undefined;
  const lines = output.replace(/\r/gu, "").split("\n");
  const start = lines.findIndex((line) => /^\s*available models:\s*$/iu.test(line));
  if (start < 0) return undefined;
  const models: ProviderModelOption[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = stripInvisible(raw);
    if (!line.trim()) {
      if (models.length > 0) break;
      continue;
    }
    if (!/^\s/u.test(line)) break;
    const match = /^\s+(\S+)\s{2,}(.+)$/u.exec(line);
    if (match?.[1] && match[2]) pushModel(models, match[1], match[2]);
  }
  if (models.length === 0) return undefined;
  const reasoning = parseDroidReasoning(lines);
  return models.map((model) => {
    const levels = reasoning.get(model.label.replace(DROID_DEFAULT_LABEL, ""));
    return levels ? { ...model, ...levels } : model;
  });
}

/** Rows such as "- Opus 5.5: supports reasoning: Yes; supported: [low, high]; default: high", keyed by label. */
function parseDroidReasoning(
  lines: readonly string[],
): Map<string, Pick<ProviderModelOption, "reasoningEfforts" | "defaultReasoningEffort">> {
  const levels = new Map<string, Pick<ProviderModelOption, "reasoningEfforts" | "defaultReasoningEffort">>();
  for (const raw of lines) {
    const match =
      /^\s*-\s+(.+?):\s+supports reasoning:\s*(yes|no)\s*;\s*supported:\s*\[([^\]]*)\]\s*;\s*default:\s*(\S+)/iu.exec(
        stripInvisible(raw),
      );
    if (!match?.[1] || !match[2] || match[3] === undefined || !match[4]) continue;
    if (match[2].toLowerCase() === "no") {
      levels.set(match[1].trim(), { reasoningEfforts: [] });
      continue;
    }
    const supported = match[3]
      .split(",")
      .map((level) => level.trim())
      .filter((level) => ReasoningEffort.safeParse(level).success)
      .slice(0, 20);
    const fallback = match[4].replace(/[;,.]$/u, "");
    levels.set(match[1].trim(), {
      reasoningEfforts: supported,
      ...(supported.includes(fallback) ? { defaultReasoningEffort: fallback } : {}),
    });
  }
  return levels;
}

function providerReasoningEfforts(
  provider: ListedProviderKind,
  models: readonly ProviderModelOption[] | undefined,
): readonly string[] | undefined {
  switch (provider) {
    case "claude-code":
      return CLAUDE_CODE_REASONING;
    case "codex":
      return CODEX_REASONING;
    case "droid":
      return models?.find((model) => DROID_DEFAULT_LABEL.test(model.label))?.reasoningEfforts;
    default:
      return undefined;
  }
}

/** `opencode models` prints one "provider/model" id per line. */
export function parseOpenCodeModels(output: string | undefined): ProviderModelOption[] | undefined {
  if (!output) return undefined;
  const models: ProviderModelOption[] = [];
  for (const line of cleanLines(output)) {
    if (line.includes("/") && LAUNCHABLE_MODEL_ID.test(line)) pushModel(models, line, line);
  }
  return models.length > 0 ? models : undefined;
}

function pushModel(models: ProviderModelOption[], id: string, label: string): void {
  const cleanLabel = label.replace(/\s+/gu, " ").trim();
  if (models.length >= MAX_MODELS || id.length > 200 || !cleanLabel) return;
  if (models.some((model) => model.id === id)) return;
  models.push({ id, label: cleanLabel.slice(0, 200) });
}

function cleanLines(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => stripInvisible(line).trim())
    .filter((line) => line.length > 0);
}

/** CLI tables can carry ANSI colors and zero-width characters between cells. */
function stripInvisible(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC.
  return value.replace(/\u001b\[[0-9;]*[A-Za-z]/gu, "").replace(/[\u200b-\u200d\u2060\ufeff]/gu, "");
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

async function discoverOne(spec: ListedSpec, probe: CliProbe, includeModels: boolean): Promise<ProviderDiscovery> {
  const path = firstExisting(spec, probe);
  if (!path) {
    return {
      provider: spec.provider,
      displayName: spec.displayName,
      status: "missing",
      reason: `${spec.displayName} CLI was not found on PATH or in known install locations.`,
    };
  }
  const [version, models] = await Promise.all([
    readFoundVersion(probe, path),
    includeModels ? readFoundModels(probe, spec.provider, path) : Promise.resolve(undefined),
  ]);
  const reasoningEfforts =
    includeModels && probe.readModels ? providerReasoningEfforts(spec.provider, models) : undefined;
  return {
    provider: spec.provider,
    displayName: spec.displayName,
    status: "found",
    path,
    ...(version ? { version } : {}),
    ...(models ? { models } : {}),
    ...(reasoningEfforts?.length ? { reasoningEfforts: [...reasoningEfforts] } : {}),
  };
}

async function readFoundModels(
  probe: CliProbe,
  provider: ListedProviderKind,
  command: string,
): Promise<ProviderModelOption[] | undefined> {
  if (!probe.readModels) return undefined;
  try {
    const models = await probe.readModels(provider, command);
    return models && models.length > 0 ? models.slice(0, MAX_MODELS).map((model) => ({ ...model })) : undefined;
  } catch {
    return undefined;
  }
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
    if (spec.provider === "droid") dirs.push(api.join(probe.homeDir, "bin"));
    if (spec.provider === "opencode") dirs.push(api.join(probe.homeDir, ".opencode", "bin"));
    if (spec.provider === "kimi") dirs.push(api.join(probe.homeDir, ".kimi-code", "bin"));
    if (PACKAGE_MANAGER_CLIS.has(spec.provider)) dirs.push(api.join(probe.homeDir, ".bun", "bin"));
  }
  if (probe.platform === "win32" && probe.localAppData && spec.provider === "cursor-agent") {
    dirs.push(api.join(probe.localAppData, "cursor-agent"));
  }
  if (probe.platform === "win32" && probe.appData && PACKAGE_MANAGER_CLIS.has(spec.provider)) {
    dirs.push(api.join(probe.appData, "npm"));
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
