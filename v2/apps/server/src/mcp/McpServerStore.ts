import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  AgentToolAccess,
  DEFAULT_AGENT_TOOL_ACCESS,
  isHttpServer,
  MCP_REMOTE_PACKAGE,
  type McpListResult,
  type McpServerConfig,
  McpServerList,
  type McpSettingsOutcome,
} from "@zli-v2/contracts";

import { isPlainObject, type McpServerSpec, writeFileAtomic, writeFileIfChanged } from "../browser-tool/browserTool.js";
import type { UserSettingsOwnership } from "../browser-tool/userSettings.js";

/** Copies the enabled servers into agents that read MCP servers only from their own settings files. */
export type McpUserSettingsSync = (
  specs: readonly McpServerSpec[],
  owned: UserSettingsOwnership,
) => Promise<{ outcomes: McpSettingsOutcome[]; owned: Record<string, string[]> }>;

type StoredFile = {
  version: 1;
  servers: McpServerConfig[];
  owned: Record<string, string[]>;
  agentAccess: AgentToolAccess;
};

/**
 * The server as agents launch it. A sign-in (OAuth) server runs through mcp-remote, which handles the
 * browser login and token refresh, so it works in every agent the same way. Its headers go in
 * `headerFile` when given, which keeps them out of the process list.
 */
export function mcpLaunchSpec(
  server: McpServerConfig,
  options: { headerFile?: string; platform?: NodeJS.Platform } = {},
): McpServerSpec {
  if (!isHttpServer(server)) {
    return { name: server.name, command: server.command, args: [...server.args], env: { ...server.env } };
  }
  if (!server.oauth) return { transport: "http", name: server.name, url: server.url, headers: { ...server.headers } };
  const headers = Object.entries(server.headers);
  const headerArgs =
    headers.length === 0
      ? []
      : options.headerFile
        ? ["--header-file", options.headerFile]
        : headers.flatMap(([name, value]) => ["--header", `${name}:${value}`]);
  const args = [
    "-y",
    MCP_REMOTE_PACKAGE,
    server.url,
    ...(server.url.startsWith("http:") ? ["--allow-http"] : []),
    ...headerArgs,
  ];
  // npx is a .cmd shim on Windows, and agents start servers without a shell.
  return (options.platform ?? process.platform) === "win32"
    ? { name: server.name, command: "cmd", args: ["/c", "npx", ...args], env: {} }
    : { name: server.name, command: "npx", args, env: {} };
}

/** mcp-remote header file contents: one `Name: value` per line. */
export function mcpRemoteHeaderFile(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\n`)
    .join("");
}

function needsHeaderFile(server: McpServerConfig): boolean {
  return isHttpServer(server) && server.oauth && Object.keys(server.headers).length > 0;
}

function copyServer(server: McpServerConfig): McpServerConfig {
  return isHttpServer(server)
    ? { ...server, headers: { ...server.headers } }
    : { ...server, args: [...server.args], env: { ...server.env } };
}

const HEADER_FILE_SUFFIX = ".headers";

/**
 * The MCP servers the person added in Settings, kept in one JSON file beside the database. Agents read
 * `specs()` at each launch, so a save applies to the next agent without a restart.
 */
export class McpServerStore {
  private servers: McpServerConfig[] = [];
  private owned: Record<string, string[]> = {};
  private access: AgentToolAccess = DEFAULT_AGENT_TOOL_ACCESS;
  private outcomes: McpSettingsOutcome[] = [];
  private problem: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: { path: string; syncUserSettings?: McpUserSettingsSync }) {}

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.options.path, "utf8");
    } catch (error) {
      if (isNotFound(error)) return;
      this.problem = "The saved MCP server list could not be read.";
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/u, ""));
    } catch {
      this.problem = "The saved MCP server list is not valid JSON.";
      return;
    }
    if (isPlainObject(parsed)) {
      const access = AgentToolAccess.safeParse(parsed.agentAccess);
      if (access.success) this.access = access.data;
    }
    const servers = isPlainObject(parsed) ? McpServerList.safeParse(parsed.servers) : undefined;
    if (!servers?.success) {
      this.problem = "The saved MCP server list is not valid.";
      return;
    }
    this.servers = servers.data;
    this.owned = isPlainObject(parsed) ? ownedFrom(parsed.owned) : {};
    await this.writeHeaderFiles();
  }

  /** Enabled servers in the form agent launches use. */
  specs(): McpServerSpec[] {
    return this.servers
      .filter((server) => server.enabled)
      .map((server) =>
        mcpLaunchSpec(server, needsHeaderFile(server) ? { headerFile: this.headerFile(server.name) } : {}),
      );
  }

  /** Where mcp-remote reads one sign-in server's headers. */
  headerFile(name: string): string {
    return join(this.headerDir(), `${name}${HEADER_FILE_SUFFIX}`);
  }

  agentAccess(): AgentToolAccess {
    return this.access;
  }

  list(): McpListResult {
    return {
      servers: this.servers.map(copyServer),
      agentAccess: this.access,
      userSettings: { enabled: this.options.syncUserSettings !== undefined, outcomes: [...this.outcomes] },
      ...(this.problem ? { problem: this.problem } : {}),
    };
  }

  save(servers: readonly McpServerConfig[]): Promise<McpListResult> {
    return this.serialize(async () => {
      const next = McpServerList.parse(servers);
      await this.write(next);
      this.servers = next;
      this.problem = undefined;
      await this.writeHeaderFiles();
      await this.sync();
      return this.list();
    });
  }

  setAgentAccess(access: AgentToolAccess): Promise<McpListResult> {
    return this.serialize(async () => {
      const next = AgentToolAccess.parse(access);
      const previous = this.access;
      this.access = next;
      try {
        await this.write();
      } catch (error) {
        this.access = previous;
        throw error;
      }
      return this.list();
    });
  }

  /** Brings agent settings in line with the saved list, for example after an agent CLI was installed. */
  syncUserSettings(): Promise<McpListResult> {
    return this.serialize(async () => {
      await this.sync();
      return this.list();
    });
  }

  async waitForIdle(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(work);
    this.queue = run;
    return run;
  }

  private async sync(): Promise<void> {
    const sync = this.options.syncUserSettings;
    if (!sync) return;
    let result: Awaited<ReturnType<McpUserSettingsSync>>;
    try {
      result = await sync(this.specs(), this.owned);
    } catch {
      return;
    }
    this.outcomes = result.outcomes;
    if (!sameOwned(this.owned, result.owned)) {
      this.owned = result.owned;
      // The list itself is already saved; a lost ownership record only means a later delete leaves an entry.
      await this.write().catch(() => undefined);
    }
  }

  private headerDir(): string {
    return join(dirname(this.options.path), "mcp-headers");
  }

  /** Keeps one private file per sign-in server with headers and removes the rest. A failure only affects that server. */
  private async writeHeaderFiles(): Promise<void> {
    const wanted = this.servers.filter(needsHeaderFile);
    const keep = new Set(wanted.map((server) => `${server.name}${HEADER_FILE_SUFFIX}`));
    for (const server of wanted) {
      if (!isHttpServer(server)) continue;
      await writeFileIfChanged(this.headerFile(server.name), mcpRemoteHeaderFile(server.headers), {
        mode: 0o600,
      }).catch(() => undefined);
    }
    let names: string[];
    try {
      names = await readdir(this.headerDir());
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(HEADER_FILE_SUFFIX) || keep.has(name)) continue;
      await rm(join(this.headerDir(), name), { force: true }).catch(() => undefined);
    }
  }

  private async write(servers: McpServerConfig[] = this.servers): Promise<void> {
    const file: StoredFile = { version: 1, servers, owned: this.owned, agentAccess: this.access };
    await writeFileAtomic(this.options.path, `${JSON.stringify(file, null, 2)}\n`);
  }
}

function ownedFrom(value: unknown): Record<string, string[]> {
  if (!isPlainObject(value)) return {};
  const owned: Record<string, string[]> = {};
  for (const [path, names] of Object.entries(value)) {
    if (!Array.isArray(names)) continue;
    const valid = names.filter((name): name is string => typeof name === "string" && name.length > 0);
    if (valid.length > 0) owned[path] = valid;
  }
  return owned;
}

function sameOwned(left: Record<string, string[]>, right: Record<string, string[]>): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    const a = left[key] ?? [];
    const b = right[key];
    return b !== undefined && a.length === b.length && a.every((name, index) => name === b[index]);
  });
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
