import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

/** MCP server name every agent sees. Codex, Kimi, and Droid accept `-` in server names. */
export const BROWSER_MCP_SERVER = "zli-browser";

export type BrowserToolConfig = {
  /** Electron executable that runs the tool script with ELECTRON_RUN_AS_NODE. */
  command: string;
  script: string;
  /** Endpoint file the tool reads to reach the browser control service. */
  controlFile: string;
  /** Directory holding the `zli-browser` shell shims. */
  shimDir: string;
  /** Where per-launch MCP config files for agent CLIs are written. */
  mcpConfigDir: string;
};

export type McpServerSpec = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
};

/** Undefined unless the desktop shell passed every browser tool path, so tests and CLI runs inject nothing. */
export function browserToolConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BrowserToolConfig | undefined {
  const command = env.ZLI_BROWSER_TOOL_COMMAND?.trim();
  const script = env.ZLI_BROWSER_TOOL_SCRIPT?.trim();
  const controlFile = env.ZLI_BROWSER_CONTROL_FILE?.trim();
  const shimDir = env.ZLI_BROWSER_SHIM_DIR?.trim();
  if (!command || !script || !controlFile || !shimDir) return undefined;
  if (![command, script, controlFile, shimDir].every((value) => isAbsolute(value))) return undefined;
  return { command, script, controlFile, shimDir, mcpConfigDir: join(dirname(controlFile), "mcp") };
}

/** Global registrations omit the worktree id; the tool then resolves the worktree from its cwd. */
export function mcpServerSpec(config: BrowserToolConfig, worktreeId?: string): McpServerSpec {
  return {
    name: BROWSER_MCP_SERVER,
    command: config.command,
    args: [config.script, "mcp"],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ZLI_BROWSER_CONTROL_FILE: config.controlFile,
      ...(worktreeId ? { ZLI_WORKTREE_ID: worktreeId } : {}),
    },
  };
}

/**
 * The PATH key as it already exists in `env`. Windows environments usually spell it `Path`, and a child
 * given both `Path` and `PATH` sees only one of them, so the existing spelling must be reused.
 */
export function pathKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return "PATH";
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "Path";
}

/** Returns `env` with `dir` first on PATH, removing other spellings of the PATH key on Windows. */
export function prependPath(
  env: NodeJS.ProcessEnv,
  dir: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const key = pathKey(env, platform);
  const delimiter = platform === "win32" ? ";" : ":";
  const current = env[key] ?? "";
  const entries = current.split(delimiter).filter((entry) => entry.length > 0);
  const same = (entry: string) => (platform === "win32" ? entry.toLowerCase() === dir.toLowerCase() : entry === dir);
  const next: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (platform === "win32" && name !== key && name.toUpperCase() === "PATH") continue;
    next[name] = value;
  }
  next[key] = [dir, ...entries.filter((entry) => !same(entry))].join(delimiter);
  return next;
}

/** Variables that let `zli-browser` find the control service and the agent's worktree. */
export function browserToolEnv(config: BrowserToolConfig, worktreeId?: string): Record<string, string> {
  return {
    ZLI_BROWSER_CONTROL_FILE: config.controlFile,
    ...(worktreeId ? { ZLI_WORKTREE_ID: worktreeId } : {}),
  };
}

/** Environment additions for an agent process spawned by this server, including the shim dir on PATH. */
export function agentEnv(
  config: BrowserToolConfig,
  worktreeId: string | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const key = pathKey(baseEnv, platform);
  const path = prependPath({ [key]: baseEnv[key] }, config.shimDir, platform)[key] ?? config.shimDir;
  return { ...browserToolEnv(config, worktreeId), [key]: path };
}

/** ACP stdio McpServer, where env is a list of name/value pairs. */
export function acpMcpServer(spec: McpServerSpec): {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
} {
  return {
    name: spec.name,
    command: spec.command,
    args: [...spec.args],
    env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
  };
}

function specList(specs: McpServerSpec | readonly McpServerSpec[]): readonly McpServerSpec[] {
  return Array.isArray(specs) ? specs : [specs as McpServerSpec];
}

/** Claude Code `--mcp-config` file contents. */
export function claudeMcpConfig(specs: McpServerSpec | readonly McpServerSpec[]): string {
  const mcpServers = Object.fromEntries(
    specList(specs).map((spec) => [
      spec.name,
      { type: "stdio", command: spec.command, args: spec.args, env: spec.env },
    ]),
  );
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

/** GitHub Copilot CLI `--additional-mcp-config` file contents. */
export function copilotMcpConfig(specs: McpServerSpec | readonly McpServerSpec[]): string {
  const mcpServers = Object.fromEntries(
    specList(specs).map((spec) => [
      spec.name,
      { type: "local", command: spec.command, args: spec.args, env: spec.env, tools: ["*"] },
    ]),
  );
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

/**
 * A TOML string. Literal strings keep Windows backslashes and avoid double quotes, which would
 * otherwise need escaping again when the argument passes through cmd.exe for npm shims.
 */
export function tomlString(value: string): string {
  const literal = [...value].every((char) => char !== "'" && char >= " " && char !== "\u007f");
  return literal ? `'${value}'` : JSON.stringify(value);
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(key) ? key : JSON.stringify(key);
}

export function tomlInlineTable(values: Record<string, string>): string {
  const entries = Object.entries(values).map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`);
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
}

/** Codex `-c` overrides that add the server for one process without touching ~/.codex/config.toml. */
export function codexMcpArgs(spec: McpServerSpec): string[] {
  const prefix = `mcp_servers.${tomlKey(spec.name)}`;
  return [
    "-c",
    `${prefix}.command=${tomlString(spec.command)}`,
    "-c",
    `${prefix}.args=[${spec.args.map(tomlString).join(", ")}]`,
    "-c",
    `${prefix}.env=${tomlInlineTable(spec.env)}`,
  ];
}

/** Per-thread Codex config override that gives one app-server thread its worktree id. */
export function codexThreadConfig(spec: McpServerSpec): Record<string, unknown> {
  return { [`mcp_servers.${spec.name}.env`]: { ...spec.env } };
}

/** Per-thread Codex config override that adds a whole server, so edits apply to the next thread. */
export function codexServerConfig(spec: McpServerSpec): Record<string, unknown> {
  return { [`mcp_servers.${spec.name}`]: { command: spec.command, args: [...spec.args], env: { ...spec.env } } };
}

/** OpenCode inline config, merged into any OPENCODE_CONFIG_CONTENT the user already set. */
export function opencodeConfigContent(
  specs: McpServerSpec | readonly McpServerSpec[],
  existing?: string,
): string | undefined {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (!isPlainObject(parsed)) return undefined;
      base = parsed;
    } catch {
      return undefined;
    }
  }
  const mcp = isPlainObject(base.mcp) ? base.mcp : {};
  const added = Object.fromEntries(
    specList(specs).map((spec) => [
      spec.name,
      { type: "local", command: [spec.command, ...spec.args], environment: spec.env, enabled: true },
    ]),
  );
  return JSON.stringify({ ...base, mcp: { ...mcp, ...added } });
}

/**
 * Goose `--with-extension` value: leading KEY=VALUE environment assignments, then the command line.
 * Windows paths use forward slashes because a POSIX-style word splitter would eat backslashes.
 */
export function gooseExtension(spec: McpServerSpec, platform: NodeJS.Platform = process.platform): string {
  const word = (value: string) => {
    const normalized = platform === "win32" ? value.replace(/\\/gu, "/") : value;
    return /^[A-Za-z0-9_\-./:@+=,]+$/u.test(normalized) ? normalized : `'${normalized.replace(/'/gu, `'\\''`)}'`;
  };
  const assignments = Object.entries(spec.env).map(([key, value]) => `${key}=${word(value)}`);
  return [...assignments, word(spec.command), ...spec.args.map(word)].join(" ");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Writes through a temp file and rename so a reader never sees a half-written file. */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, contents, "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Writes only when the contents differ, so launches that share a file do not rewrite it. */
export async function writeFileIfChanged(path: string, contents: string): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) === contents) return;
  } catch {
    // Missing or unreadable: write it.
  }
  await writeFileAtomic(path, contents);
}

export type McpConfigFileKind = "claude" | "copilot";

/** Per-worktree MCP config file holding every server, for CLIs that take one on the command line. */
export async function writeAgentMcpConfig(
  dir: string,
  kind: McpConfigFileKind,
  worktreeId: string | undefined,
  specs: readonly McpServerSpec[],
): Promise<string> {
  const key = (worktreeId ?? "shared").replace(/[^A-Za-z0-9_-]/gu, "_");
  const path = join(dir, `${kind}-${key}.json`);
  await writeFileIfChanged(path, kind === "claude" ? claudeMcpConfig(specs) : copilotMcpConfig(specs));
  return path;
}

/** Per-worktree MCP config file for CLIs that take one on the command line. */
export async function writeMcpConfigFile(
  config: BrowserToolConfig,
  kind: McpConfigFileKind,
  worktreeId: string | undefined,
): Promise<string> {
  return writeAgentMcpConfig(config.mcpConfigDir, kind, worktreeId, [mcpServerSpec(config, worktreeId)]);
}
