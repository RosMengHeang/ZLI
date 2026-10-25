import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";

import {
  AgentToolAccess,
  DEFAULT_AGENT_TOOL_ACCESS,
  isHttpServer,
  type McpHttpServerConfig,
  type McpImportResult,
  type McpListResult,
  type McpServerConfig,
  type McpServerHealth,
  McpServerList,
  type McpSettingsOutcome,
  type McpSignInStart,
  type McpSignInState,
  type McpTestResult,
} from "@zli-v2/contracts";

import { isPlainObject, type McpServerSpec, writeFileAtomic, writeFileIfChanged } from "../browser-tool/browserTool.js";
import type { UserSettingsOwnership } from "../browser-tool/userSettings.js";
import { type ImportEnvironment, scanImportableServers } from "./importServers.js";
import { type McpProbe, type McpProbeOptions, type McpProbeOutcome, probeMcpServer } from "./McpProbe.js";
import type { McpSignIns } from "./signIn/McpSignIns.js";
import { SignInError } from "./signIn/oauth.js";
import { freshAccessToken, markSignInExpired } from "./signIn/tokenFile.js";

/** ZLI's bundled connect bridge, run with Electron's Node like the other agent tools. */
export type ConnectTool = { command: string; script: string };

/** Copies the enabled servers into agents that read MCP servers only from their own settings files. */
export type McpUserSettingsSync = (
  specs: readonly McpServerSpec[],
  owned: UserSettingsOwnership,
) => Promise<{ outcomes: McpSettingsOutcome[]; owned: Record<string, string[]> }>;

/** Where an agent is about to start. Servers limited to some projects reach only agents in those projects. */
export type McpSpecContext = { projectPath?: string };

/** A request about a server that cannot be done as asked, worth showing the person as is. */
export class McpRequestError extends Error {}

type StoredFile = {
  version: 1;
  servers: McpServerConfig[];
  owned: Record<string, string[]>;
  agentAccess: AgentToolAccess;
};

export type McpLaunchOptions = {
  headerFile?: string;
  tokenFile?: string;
  accessToken?: string;
  connectTool?: ConnectTool;
  /** JSON list of the tools the person turned off. */
  hideToolsFile?: string;
  /** JSON command, args, and env for a local server run through the bridge. */
  specFile?: string;
};

function hasHiddenTools(server: McpServerConfig): boolean {
  return (server.disabledTools?.length ?? 0) > 0;
}

function hasHeaders(server: McpServerConfig): boolean {
  return isHttpServer(server) && Object.keys(server.headers).length > 0;
}

/** Servers agents reach through ZLI's connect bridge whenever it is available. */
function usesBridge(server: McpServerConfig): boolean {
  if (!isHttpServer(server)) return hasHiddenTools(server);
  return server.oauth || hasHeaders(server) || hasHiddenTools(server);
}

/**
 * The server as agents launch it. With ZLI's connect bridge available, a remote server with sign-in
 * (OAuth), headers, or turned-off tools runs through it, and so does a local server with turned-off tools.
 * The bridge reads the saved login from `tokenFile` and refreshes it, reads headers from `headerFile` so
 * they stay out of agent settings and the process list, and hides the tools listed in `hideToolsFile`.
 * Without the bridge (tests and runs outside the desktop app), agents get the URL with the current token
 * as a header, and turned-off tools stay visible.
 */
export function mcpLaunchSpec(server: McpServerConfig, options: McpLaunchOptions = {}): McpServerSpec {
  const tool = options.connectTool;
  const hidden = hasHiddenTools(server);
  const hideArgs = hidden && options.hideToolsFile ? ["--hide-tools", options.hideToolsFile] : [];
  const bridgeReady = tool !== undefined && usesBridge(server) && (!hidden || options.hideToolsFile !== undefined);
  if (!isHttpServer(server)) {
    if (tool && bridgeReady && options.specFile) {
      return {
        name: server.name,
        command: tool.command,
        args: [tool.script, "stdio", "--name", server.name, "--spec-file", options.specFile, ...hideArgs],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      };
    }
    return { name: server.name, command: server.command, args: [...server.args], env: { ...server.env } };
  }
  const withHeaders = hasHeaders(server);
  if (tool && bridgeReady && (!withHeaders || options.headerFile)) {
    return {
      name: server.name,
      command: tool.command,
      args: [
        tool.script,
        "mcp",
        "--name",
        server.name,
        "--url",
        server.url,
        ...(server.oauth && options.tokenFile ? ["--token-file", options.tokenFile] : []),
        ...(withHeaders && options.headerFile ? ["--header-file", options.headerFile] : []),
        ...hideArgs,
      ],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  const headers = { ...server.headers };
  if (server.oauth && options.accessToken) {
    for (const name of Object.keys(headers)) if (name.toLowerCase() === "authorization") delete headers[name];
    headers.Authorization = `Bearer ${options.accessToken}`;
  }
  return { transport: "http", name: server.name, url: server.url, headers };
}

/** Connect bridge header file contents: one `Name: value` per line. */
export function mcpRemoteHeaderFile(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\n`)
    .join("");
}

/** Same folder, same project: separators, a trailing slash, and on Windows case do not matter. */
export function projectPathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const api = platform === "win32" ? win32 : posix;
  let normalized = api.normalize(path.trim());
  const root = api.parse(normalized).root;
  while (normalized.length > root.length && /[\\/]$/u.test(normalized)) normalized = normalized.slice(0, -1);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Whether agents in `projectPath` get the server. Without a project, only servers for every project. */
export function serverInProject(
  server: McpServerConfig,
  projectPath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const projects = server.projects ?? [];
  if (projects.length === 0) return true;
  if (!projectPath) return false;
  const key = projectPathKey(projectPath, platform);
  return projects.some((project) => projectPathKey(project, platform) === key);
}

function copyServer(server: McpServerConfig): McpServerConfig {
  const lists = {
    ...(server.disabledTools ? { disabledTools: [...server.disabledTools] } : {}),
    ...(server.projects ? { projects: [...server.projects] } : {}),
  };
  return isHttpServer(server)
    ? { ...server, headers: { ...server.headers }, ...lists }
    : { ...server, args: [...server.args], env: { ...server.env }, ...lists };
}

const HEADER_FILE_SUFFIX = ".headers";
const TOOLS_FILE_SUFFIX = ".hidden-tools.json";
const SPEC_FILE_SUFFIX = ".stdio.json";
const BRIDGE_FILE_SUFFIXES = [HEADER_FILE_SUFFIX, TOOLS_FILE_SUFFIX, SPEC_FILE_SUFFIX];

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
  /** The last connection test per server, by lowercase name. Kept in memory only. */
  private readonly health = new Map<string, McpServerHealth>();

  constructor(
    private readonly options: {
      path: string;
      syncUserSettings?: McpUserSettingsSync;
      /** Servers from other sources, such as plugins. `taken` holds the lowercase names of the person's own servers, which win. */
      extraServers?: (taken: ReadonlySet<string>) => McpServerConfig[];
      signIns?: McpSignIns;
      connectTool?: ConnectTool;
      /** Replaces the real connection test. */
      probe?: McpProbe;
      /** Where to look for other apps' MCP settings. */
      importFrom?: ImportEnvironment;
      now?: () => number;
    },
  ) {}

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
    await this.writeBridgeFiles();
  }

  /**
   * Enabled servers in the form agent launches use. Servers limited to some projects are included only
   * when `projectPath` is one of them, so without a project (agent user settings) they are left out.
   */
  specs(context: McpSpecContext = {}): McpServerSpec[] {
    return [
      ...this.servers.filter((server) => server.enabled && serverInProject(server, context.projectPath)),
      ...this.extraServers(),
    ].map((server) => mcpLaunchSpec(server, this.launchOptions(server)));
  }

  private launchOptions(server: McpServerConfig): McpLaunchOptions {
    const options: McpLaunchOptions = {};
    if (this.options.connectTool) options.connectTool = this.options.connectTool;
    if (hasHiddenTools(server)) options.hideToolsFile = this.hideToolsFile(server.name);
    if (!isHttpServer(server)) {
      if (hasHiddenTools(server)) options.specFile = this.specFile(server.name);
      return options;
    }
    if (hasHeaders(server)) options.headerFile = this.headerFile(server.name);
    if (!server.oauth) return options;
    const signIns = this.options.signIns;
    if (signIns) options.tokenFile = signIns.tokenFile(server.url);
    const accessToken = signIns?.accessToken(server.url);
    if (accessToken) options.accessToken = accessToken;
    return options;
  }

  /** Where the connect bridge reads one remote server's headers. */
  headerFile(name: string): string {
    return join(this.bridgeDir(), `${name}${HEADER_FILE_SUFFIX}`);
  }

  /** Where the connect bridge reads the tools turned off for one server. */
  hideToolsFile(name: string): string {
    return join(this.bridgeDir(), `${name}${TOOLS_FILE_SUFFIX}`);
  }

  /** Where the connect bridge reads how to start one local server. */
  specFile(name: string): string {
    return join(this.bridgeDir(), `${name}${SPEC_FILE_SUFFIX}`);
  }

  agentAccess(): AgentToolAccess {
    return this.access;
  }

  list(): McpListResult {
    return {
      servers: this.servers.map(copyServer),
      agentAccess: this.access,
      userSettings: { enabled: this.options.syncUserSettings !== undefined, outcomes: [...this.outcomes] },
      signIns: this.signInStates(),
      health: this.healthStates(),
      ...(this.problem ? { problem: this.problem } : {}),
    };
  }

  /** Rereads saved logins, which connect bridges may have refreshed or found expired. */
  async reloadSignIns(): Promise<void> {
    await this.options.signIns?.load();
  }

  /** Starts signing in to one sign-in server, the person's or a plugin's. */
  async signIn(name: string): Promise<McpSignInStart> {
    const signIns = this.requireSignIns();
    const server = this.signInServer(name);
    const start = await signIns.start(server.url);
    if (start.status === "open") return start;
    await this.refresh();
    return { status: "done", list: this.list() };
  }

  async waitForSignIn(attemptId: string): Promise<McpListResult> {
    await this.requireSignIns().wait(attemptId);
    await this.refresh();
    return this.list();
  }

  cancelSignIn(attemptId: string): McpListResult {
    this.requireSignIns().cancel(attemptId);
    return this.list();
  }

  async signOut(name: string): Promise<McpListResult> {
    await this.requireSignIns().signOut(this.signInServer(name).url);
    await this.refresh();
    return this.list();
  }

  /** Connects to one server, the person's or a plugin's, and lists its tools. */
  async test(name: string): Promise<McpTestResult> {
    const server = this.findServer(name);
    if (!server) throw new McpRequestError(`There is no MCP server named ${name}.`);
    const signIns = this.options.signIns;
    const tokenFile = isHttpServer(server) && server.oauth && signIns ? signIns.tokenFile(server.url) : undefined;
    const probeOptions: McpProbeOptions = tokenFile
      ? {
          getToken: (force) => freshAccessToken(tokenFile, { force }),
          onSignInRejected: (token) => markSignInExpired(tokenFile, token),
        }
      : {};
    const outcome: McpProbeOutcome = await (this.options.probe ?? probeMcpServer)(server, probeOptions).catch(
      (error: unknown) => ({
        ok: false,
        tools: [],
        problem: `ZLI could not test ${server.name}. ${error instanceof Error ? error.message : String(error)}`.trim(),
      }),
    );
    if (tokenFile && signIns && isHttpServer(server)) await signIns.reload(server.url).catch(() => undefined);
    const testedAt = new Date((this.options.now ?? Date.now)()).toISOString();
    const extra = {
      ...(outcome.problem ? { problem: outcome.problem } : {}),
      ...(outcome.needsSignIn ? { needsSignIn: true } : {}),
    };
    this.health.set(server.name.toLowerCase(), {
      name: server.name,
      ok: outcome.ok,
      toolCount: outcome.tools.length,
      ...extra,
      testedAt,
    });
    return { name: server.name, ok: outcome.ok, tools: outcome.tools, ...extra, testedAt };
  }

  /** Servers set up in other apps on this computer that the person can copy into ZLI. */
  async scanImports(): Promise<McpImportResult> {
    return scanImportableServers({
      ...this.options.importFrom,
      existing: [...this.servers, ...this.extraServers()].map((server) => server.name),
      owned: this.owned,
    });
  }

  private requireSignIns(): McpSignIns {
    const signIns = this.options.signIns;
    if (!signIns) throw new SignInError("Signing in is not available here.");
    return signIns;
  }

  private findServer(name: string): McpServerConfig | undefined {
    const key = name.toLowerCase();
    return [...this.servers, ...this.extraServers()].find((entry) => entry.name.toLowerCase() === key);
  }

  private signInServer(name: string): McpHttpServerConfig {
    const server = this.findServer(name);
    if (!server) throw new SignInError(`There is no MCP server named ${name}.`);
    if (!isHttpServer(server) || !server.oauth) throw new SignInError(`${server.name} does not use sign-in.`);
    return server;
  }

  private signInStates(): McpSignInState[] {
    const signIns = this.options.signIns;
    return [...this.servers, ...this.extraServers()].flatMap((server) => {
      if (!isHttpServer(server) || !server.oauth) return [];
      const status = signIns?.status(server.url) ?? { signedIn: false };
      return [{ name: server.name, url: server.url, ...status }];
    });
  }

  private healthStates(): McpServerHealth[] {
    return [...this.servers, ...this.extraServers()].flatMap((server) => {
      const health = this.health.get(server.name.toLowerCase());
      return health ? [{ ...health }] : [];
    });
  }

  save(servers: readonly McpServerConfig[]): Promise<McpListResult> {
    return this.serialize(async () => {
      const next = McpServerList.parse(servers);
      await this.write(next);
      this.forgetChangedHealth(next);
      this.servers = next;
      this.problem = undefined;
      await this.writeBridgeFiles();
      await this.sync();
      return this.list();
    });
  }

  /**
   * A test result says nothing about a server whose connection settings changed since. Turning it
   * off, hiding tools, or limiting projects leaves the connection as it was, so the result stays.
   */
  private forgetChangedHealth(next: readonly McpServerConfig[]): void {
    const connection = (server: McpServerConfig) => {
      const { enabled: _enabled, disabledTools: _tools, projects: _projects, ...rest } = server;
      return JSON.stringify(rest);
    };
    const before = new Map(this.servers.map((server) => [server.name.toLowerCase(), connection(server)]));
    for (const server of next) {
      const key = server.name.toLowerCase();
      if (before.get(key) !== connection(server)) this.health.delete(key);
    }
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

  /** Picks up a change in the extra servers: rewrites their bridge files and agent settings. */
  refresh(): Promise<void> {
    return this.serialize(async () => {
      await this.writeBridgeFiles();
      await this.sync();
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

  private extraServers(): McpServerConfig[] {
    const extra = this.options.extraServers;
    if (!extra) return [];
    try {
      // Plugin servers go to every project.
      return extra(new Set(this.servers.map((server) => server.name.toLowerCase()))).map((server) => {
        if (!server.projects) return server;
        const { projects: _projects, ...rest } = server;
        return rest as McpServerConfig;
      });
    } catch {
      return [];
    }
  }

  private async sync(): Promise<void> {
    const sync = this.options.syncUserSettings;
    if (!sync) return;
    let result: Awaited<ReturnType<McpUserSettingsSync>>;
    try {
      // User settings apply in every project, so servers limited to some projects stay out.
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

  private bridgeDir(): string {
    return join(dirname(this.options.path), "mcp-headers");
  }

  /**
   * Keeps the private files the connect bridge reads: headers, turned-off tools, and how to start local
   * servers. Removes the rest. A failure only affects that server.
   */
  private async writeBridgeFiles(): Promise<void> {
    const wanted = new Map<string, string>();
    for (const server of [...this.servers, ...this.extraServers()]) {
      if (!usesBridge(server)) continue;
      if (isHttpServer(server) && hasHeaders(server)) {
        wanted.set(this.headerFile(server.name), mcpRemoteHeaderFile(server.headers));
      }
      if (hasHiddenTools(server)) {
        wanted.set(this.hideToolsFile(server.name), `${JSON.stringify(server.disabledTools ?? [])}\n`);
        if (!isHttpServer(server)) {
          const spec = { command: server.command, args: server.args, env: server.env };
          wanted.set(this.specFile(server.name), `${JSON.stringify(spec, null, 2)}\n`);
        }
      }
    }
    for (const [path, contents] of wanted) {
      await writeFileIfChanged(path, contents, { mode: 0o600 }).catch(() => undefined);
    }
    let names: string[];
    try {
      names = await readdir(this.bridgeDir());
    } catch {
      return;
    }
    const keep = new Set([...wanted.keys()].map((path) => path.slice(this.bridgeDir().length + 1)));
    for (const name of names) {
      if (!BRIDGE_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix)) || keep.has(name)) continue;
      await rm(join(this.bridgeDir(), name), { force: true }).catch(() => undefined);
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
