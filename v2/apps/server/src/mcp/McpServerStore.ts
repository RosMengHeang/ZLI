import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, posix, win32 } from "node:path";

import {
  AgentToolAccess,
  AgentToolScope,
  type ConnectedAppsStatus,
  DEFAULT_AGENT_TOOL_ACCESS,
  DEFAULT_AGENT_TOOL_SCOPE,
  DEFAULT_MCP_TOOL_LOADING,
  isHttpServer,
  type McpHttpServerConfig,
  type McpImportResult,
  type McpListResult,
  type McpServerConfig,
  type McpServerHealth,
  McpServerList,
  type McpSignInStart,
  type McpSignInState,
  type McpTestResult,
  McpToolLoading,
  type McpToolsCallResult,
  type McpToolsFindResult,
} from "@zli-v2/contracts";

import { isPlainObject, type McpServerSpec, writeFileAtomic, writeFileIfChanged } from "../browser-tool/browserTool.js";
import { SecretBox } from "../secrets/SecretBox.js";
import type { ConnectedApps } from "./ConnectedApps.js";
import { type ImportEnvironment, scanImportableServers } from "./importServers.js";
import { type GatewayServer, McpGateway } from "./McpGateway.js";
import {
  type McpProbe,
  type McpProbeOptions,
  type McpProbeOutcome,
  probeMcpServer,
  serverConnect,
} from "./McpProbe.js";
import type { McpSignIns } from "./signIn/McpSignIns.js";
import { SignInError } from "./signIn/oauth.js";
import { freshAccessToken, markSignInExpired } from "./signIn/tokenFile.js";

/** ZLI's bundled connect bridge, run with Electron's Node like the other agent tools. */
export type ConnectTool = { command: string; script: string };

/** Where an agent is about to start. Servers limited to some projects reach only agents in those projects. */
/** `worktreeId`: whose agent this is, so the connected apps' relay knows whose calls they are. */
export type McpSpecContext = { projectPath?: string; worktreeId?: string };

/** A request about a server that cannot be done as asked, worth showing the person as is. */
export class McpRequestError extends Error {}

const KEYCHAIN_SLOW =
  "Your system keychain didn't answer when ZLI started, so ZLI won't save keys or headers unprotected. Restart ZLI, then save them again.";

type StoredFile = {
  version: 1;
  servers: McpServerConfig[];
  /** Servers older versions copied into the person's own agent settings, by file, until they are removed. */
  owned: Record<string, string[]>;
  agentAccess: AgentToolAccess;
  agentScope: AgentToolScope;
  toolLoading?: McpToolLoading;
};

/** Where an agent works, for the gateway: its project (for servers limited to some) and its folder. */
export type GatewayPlace = { projectPath?: string; worktreePath?: string };

export type McpLaunchOptions = {
  headerFile?: string;
  /** Hands the headers to the bridge in this environment variable instead of a file. */
  headerEnv?: string;
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
  const headerEnv = withHeaders ? options.headerEnv : undefined;
  const headerFile = withHeaders && !headerEnv ? options.headerFile : undefined;
  if (tool && bridgeReady && (!withHeaders || headerEnv || headerFile)) {
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
        ...(headerEnv ? ["--header-env", headerEnv] : []),
        ...(headerFile ? ["--header-file", headerFile] : []),
        ...hideArgs,
      ],
      env: { ELECTRON_RUN_AS_NODE: "1", ...(headerEnv ? { [headerEnv]: JSON.stringify(server.headers) } : {}) },
    };
  }
  const headers = { ...server.headers };
  if (server.oauth && options.accessToken) {
    for (const name of Object.keys(headers)) if (name.toLowerCase() === "authorization") delete headers[name];
    headers.Authorization = `Bearer ${options.accessToken}`;
  }
  return { transport: "http", name: server.name, url: server.url, headers };
}

/** Where the connected apps' relay token reaches the bridge: never a file, so another worktree cannot read it. */
export const CONNECT_HEADERS_ENV = "ZLI_CONNECT_HEADERS";

/**
 * Takes the relay token out of specs that are about to be written to a settings file, and returns it as
 * environment for the agent process, whose MCP servers inherit it. Providers that take their servers over a
 * pipe (Codex threads, ACP) keep it in the spec instead.
 */
export function liftSecretEnv(specs: readonly McpServerSpec[]): {
  specs: McpServerSpec[];
  env: Record<string, string>;
} {
  const env: Record<string, string> = {};
  const out = specs.map((spec): McpServerSpec => {
    if (!("env" in spec)) return spec;
    const { [CONNECT_HEADERS_ENV]: secret, ...rest } = spec.env;
    if (secret === undefined) return spec;
    env[CONNECT_HEADERS_ENV] = secret;
    return { ...spec, env: rest };
  });
  return { specs: out, env };
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
  private scope: AgentToolScope = DEFAULT_AGENT_TOOL_SCOPE;
  private loading: McpToolLoading = DEFAULT_MCP_TOOL_LOADING;
  private readonly gateway = new McpGateway();
  private placeOf: ((worktreeId: string) => Promise<GatewayPlace>) | undefined;
  private problem: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** The last connection test per server, by lowercase name. Kept in memory only. */
  private readonly health = new Map<string, McpServerHealth>();

  constructor(
    private readonly options: {
      path: string;
      /** Called after a saved change to which agents others can reach. */
      onAgentScopeChange?: () => void;
      /** Servers from other sources, such as plugins. `taken` holds the lowercase names of the person's own servers, which win. */
      extraServers?: (taken: ReadonlySet<string>) => McpServerConfig[];
      signIns?: McpSignIns;
      connectTool?: ConnectTool;
      /** Replaces the real connection test. */
      probe?: McpProbe;
      /** Where to look for other apps' MCP settings. */
      importFrom?: ImportEnvironment;
      /** Apps connected through Composio, whose server every agent gets. */
      apps?: ConnectedApps;
      /** How agents get tools until the saved file says otherwise. */
      toolLoading?: McpToolLoading;
      /** Seals server keys and header values on disk. Without it (no OS keychain) they are saved as typed. */
      box?: SecretBox;
      /**
       * The keychain is there but did not answer in time when ZLI started: keys and headers are then not saved at
       * all until a restart, rather than saved as typed.
       */
      keychainSlow?: boolean;
      now?: () => number;
    },
  ) {}

  /** Servers whose saved keys or headers could not be opened with this computer's key. */
  private unreadable: string[] = [];
  /**
   * The sealed text of each value that could not be opened, by server and then "env.NAME" or "headers.NAME". It is
   * written back as it was until that value is typed again or removed, so a save of something else never wipes a
   * key the right computer can still open.
   */
  private locked: Record<string, Record<string, string>> = {};

  async load(): Promise<void> {
    this.loading = this.options.toolLoading ?? DEFAULT_MCP_TOOL_LOADING;
    let text: string;
    try {
      text = await readFile(this.options.path, "utf8");
    } catch (error) {
      // No list of the person's own yet: the apps' and plugins' bridge files are still rewritten, so none left
      // from an earlier run (an old key or address) stays on disk.
      if (isNotFound(error)) {
        await this.writeBridgeFiles();
        return;
      }
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
      const scope = AgentToolScope.safeParse(parsed.agentScope);
      if (scope.success) this.scope = scope.data;
      const loading = McpToolLoading.safeParse(parsed.toolLoading);
      if (loading.success) this.loading = loading.data;
    }
    // Keys and headers are opened before the list is checked: sealed text is longer than what was typed.
    const opened = isPlainObject(parsed) ? openSecrets(parsed.servers, this.options.box) : undefined;
    const servers = opened ? McpServerList.safeParse(opened.servers) : undefined;
    if (!opened || !servers?.success) {
      this.problem = "The saved MCP server list is not valid.";
      return;
    }
    this.servers = servers.data;
    this.unreadable = opened.unreadable;
    this.locked = opened.locked;
    this.owned = isPlainObject(parsed) ? ownedFrom(parsed.owned) : {};
    // A list saved before sealing, or saved readable by others, is written again: sealed, and for this user only.
    if (opened.plain && this.options.box) await this.write().catch(() => undefined);
    await this.writeBridgeFiles();
  }

  /**
   * Enabled servers in the form agent launches use. Servers limited to some projects are included only
   * when `projectPath` is one of them, so without a project they are left out.
   */
  specs(context: McpSpecContext = {}): McpServerSpec[] {
    const apps = context.worktreeId ? this.appsServerFor(context.worktreeId) : undefined;
    return (
      [
        ...this.servers.filter((server) => server.enabled && serverInProject(server, context.projectPath)),
        ...this.extraServers().map((server) => (apps && server.name === apps.name ? apps : server)),
      ]
        // On demand, agents reach these through ZLI's own server instead. Connected apps keep their own server: it
        // already finds tools by itself, and its relay needs each worktree's token to ask in the right chat.
        .filter((server) => this.loading === "upfront" || this.isAppsServer(server))
        .map((server) =>
          mcpLaunchSpec(
            server,
            this.isAppsServer(server)
              ? { ...this.launchOptions(server), headerEnv: CONNECT_HEADERS_ENV }
              : this.launchOptions(server),
          ),
        )
    );
  }

  /** The connected apps' server, whose relay token stays out of every file. */
  private isAppsServer(server: McpServerConfig): boolean {
    return (
      this.options.apps !== undefined && server.name.toLowerCase() === this.options.apps.server()?.name.toLowerCase()
    );
  }

  /**
   * The connected apps' server as one worktree's agent gets it: the relay's address with that worktree's own
   * token, so the relay knows whose call it is and asks in the right chat.
   */
  private appsServerFor(worktreeId: string): McpServerConfig | undefined {
    const server = this.options.apps?.server(worktreeId);
    if (!server || !isHttpServer(server) || !hasHeaders(server)) return undefined;
    if (this.servers.some((own) => own.name.toLowerCase() === server.name.toLowerCase())) return undefined;
    return server;
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

  agentScope(): AgentToolScope {
    return this.scope;
  }

  list(): McpListResult {
    return {
      servers: this.servers.map(copyServer),
      agentAccess: this.access,
      agentScope: this.scope,
      toolLoading: this.loading,
      signIns: this.signInStates(),
      health: this.healthStates(),
      ...(this.problem ? { problem: this.problem } : {}),
      secrets: {
        sealed: this.options.box !== undefined,
        ...(this.options.keychainSlow && !this.options.box ? { keychainSlow: true } : {}),
        unreadable: [...this.unreadable],
      },
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

  appsStatus(): Promise<ConnectedAppsStatus> {
    return this.requireApps().status();
  }

  /** Saves or clears the Composio key; agents started from then on get the apps' server, or lose it. */
  async appsKey(key: string): Promise<ConnectedAppsStatus> {
    const status = await this.requireApps().setKey(key);
    await this.refresh();
    return status;
  }

  appsConnect(app: string): Promise<{ url: string }> {
    return this.requireApps().connect(app);
  }

  appsDisconnect(accountId: string): Promise<ConnectedAppsStatus> {
    return this.requireApps().disconnect(accountId);
  }

  private requireApps(): ConnectedApps {
    if (!this.options.apps) throw new McpRequestError("Connected apps are not available here.");
    return this.options.apps;
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

  setAgentScope(scope: AgentToolScope): Promise<McpListResult> {
    return this.serialize(async () => {
      const next = AgentToolScope.parse(scope);
      const previous = this.scope;
      this.scope = next;
      try {
        await this.write();
      } catch (error) {
        this.scope = previous;
        throw error;
      }
      if (next !== previous) this.options.onAgentScopeChange?.();
      return this.list();
    });
  }

  setToolLoading(loading: McpToolLoading): Promise<McpListResult> {
    return this.serialize(async () => {
      const next = McpToolLoading.parse(loading);
      const previous = this.loading;
      this.loading = next;
      try {
        await this.write();
      } catch (error) {
        this.loading = previous;
        throw error;
      }
      return this.list();
    });
  }

  toolLoading(): McpToolLoading {
    return this.loading;
  }

  /** Tells the gateway where a worktree's agent works, so servers limited to some projects apply. */
  setPlaceResolver(resolve: (worktreeId: string) => Promise<GatewayPlace>): void {
    this.placeOf = resolve;
  }

  /** Finds tools for an agent in `worktreeId` across every server it may use, read live. */
  async findTools(command: { worktreeId?: string; query: string; limit?: number }): Promise<McpToolsFindResult> {
    return this.gateway.find(await this.gatewayServers(command.worktreeId), command.query, command.limit);
  }

  /** Calls one tool for an agent in `worktreeId`. */
  async callTool(command: {
    worktreeId?: string;
    server: string;
    tool: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpToolsCallResult> {
    const servers = await this.gatewayServers(command.worktreeId);
    const result = await this.gateway.call(servers, command.server, command.tool, command.arguments);
    const server = servers.find((entry) => entry.config.name.toLowerCase() === command.server.toLowerCase());
    // A call may have refreshed or rejected a saved login; the list shows the truth next time.
    if (server && isHttpServer(server.config) && server.config.oauth) {
      await this.options.signIns?.reload(server.config.url).catch(() => undefined);
    }
    return result;
  }

  /** Stops the gateway's server connections, such as when ZLI quits. */
  closeGateway(): Promise<void> {
    return this.gateway.close();
  }

  /** The servers an agent in `worktreeId` may use through the gateway, each with how to reach it. */
  private async gatewayServers(worktreeId: string | undefined): Promise<GatewayServer[]> {
    const place: GatewayPlace = worktreeId && this.placeOf ? await this.placeOf(worktreeId).catch(() => ({})) : {};
    const appsName = this.options.apps?.server()?.name.toLowerCase();
    const configs = [
      ...this.servers.filter((server) => server.enabled && serverInProject(server, place.projectPath)),
      ...this.extraServers(),
    ].filter((server) => server.name.toLowerCase() !== appsName);
    return configs.map((config) => {
      const tokenFile =
        isHttpServer(config) && config.oauth && this.options.signIns
          ? this.options.signIns.tokenFile(config.url)
          : undefined;
      const options: McpProbeOptions = {
        ...(place.worktreePath ? { cwd: place.worktreePath } : {}),
        ...(tokenFile
          ? {
              getToken: (force: boolean) => freshAccessToken(tokenFile, { force }),
              onSignInRejected: (token: string) => markSignInExpired(tokenFile, token),
            }
          : {}),
      };
      return {
        config,
        hiddenTools: config.disabledTools ?? [],
        ...(place.worktreePath ? { cwd: place.worktreePath } : {}),
        connect: serverConnect(config, options),
      };
    });
  }

  /** Picks up a change in the extra servers by rewriting their bridge files. */
  refresh(): Promise<void> {
    return this.serialize(() => this.writeBridgeFiles());
  }

  /**
   * Hands the servers older versions copied into the person's own agent settings to `remove`, and keeps
   * whatever it reports could not be removed.
   */
  cleanUpUserSettings(
    remove: (owned: Readonly<Record<string, readonly string[]>>) => Promise<Record<string, string[]>>,
  ): Promise<void> {
    return this.serialize(async () => {
      const remaining = await remove(this.owned);
      if (sameOwned(this.owned, remaining)) return;
      this.owned = remaining;
      // A list that could not be read must not be replaced by an empty one.
      if (!this.problem) await this.write().catch(() => undefined);
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
    const taken = new Set(this.servers.map((server) => server.name.toLowerCase()));
    const apps = this.options.apps?.server();
    const own = apps && !taken.has(apps.name) ? [apps] : [];
    const extra = this.options.extraServers;
    if (!extra) return own;
    try {
      // Plugin servers go to every project.
      return [...own, ...extra(taken)].map((server) => {
        if (!server.projects) return server;
        const { projects: _projects, ...rest } = server;
        return rest as McpServerConfig;
      });
    } catch {
      return own;
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
      if (isHttpServer(server) && hasHeaders(server) && !this.isAppsServer(server)) {
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
    if (this.options.keychainSlow && !this.options.box && servers.some(hasSecretValues)) {
      throw new McpRequestError(KEYCHAIN_SLOW);
    }
    // Re-entered values replace ones that could not be opened.
    const names = new Set(servers.map((server) => server.name.toLowerCase()));
    this.unreadable = this.unreadable.filter(
      (name) =>
        names.has(name.toLowerCase()) && !servers.some((server) => server.name === name && hasSecretValues(server)),
    );
    const file: StoredFile = {
      version: 1,
      servers: keepLocked(sealSecrets(servers, this.options.box), this.locked),
      owned: this.owned,
      agentAccess: this.access,
      agentScope: this.scope,
      toolLoading: this.loading,
    };
    // Only this user may read the list: it holds the servers' keys, sealed or not.
    await writeFileAtomic(this.options.path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }
}

/** Whether a server carries any key or header value of its own. */
function hasSecretValues(server: McpServerConfig): boolean {
  const values = server.transport === "http" ? server.headers : server.env;
  return Object.values(values).some((value) => value.length > 0);
}

function mapValues(record: unknown, change: (value: string, key: string) => string): Record<string, unknown> | unknown {
  if (!isPlainObject(record)) return record;
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, typeof value === "string" ? change(value, key) : value]),
  );
}

/**
 * Opens sealed env and header values in the saved list, as written. A value sealed with another key comes back
 * empty, and its server is named in unreadable. plain says whether any value was saved without sealing.
 */
export function openSecrets(
  servers: unknown,
  box: SecretBox | undefined,
): { servers: unknown; unreadable: string[]; plain: boolean; locked: Record<string, Record<string, string>> } {
  if (!Array.isArray(servers)) return { servers, unreadable: [], plain: false, locked: {} };
  const unreadable: string[] = [];
  const locked: Record<string, Record<string, string>> = {};
  let plain = false;
  const opened = servers.map((server: unknown) => {
    if (!isPlainObject(server)) return server;
    let lost = false;
    const opener = (field: "env" | "headers") => (value: string, key: string) => {
      if (!SecretBox.isSealed(value)) {
        if (value) plain = true;
        return value;
      }
      const text = box?.open(value);
      if (text === undefined) {
        lost = true;
        if (typeof server.name === "string") {
          const kept = locked[server.name] ?? {};
          kept[`${field}.${key}`] = value;
          locked[server.name] = kept;
        }
      }
      return text ?? "";
    };
    const next = {
      ...server,
      env: mapValues(server.env, opener("env")),
      headers: mapValues(server.headers, opener("headers")),
    };
    if (server.env === undefined) delete (next as Record<string, unknown>).env;
    if (server.headers === undefined) delete (next as Record<string, unknown>).headers;
    if (lost && typeof server.name === "string") unreadable.push(server.name);
    return next;
  });
  return { servers: opened, unreadable, plain, locked };
}

/** Puts back the sealed text of values that could not be opened and are still empty, as they were on disk. */
function keepLocked(servers: McpServerConfig[], locked: Record<string, Record<string, string>>): McpServerConfig[] {
  return servers.map((server) => {
    const sealed = locked[server.name];
    if (!sealed) return server;
    const field = server.transport === "http" ? "headers" : "env";
    const values = { ...(server.transport === "http" ? server.headers : server.env) };
    for (const [key, value] of Object.entries(values)) {
      const kept = sealed[`${field}.${key}`];
      if (value === "" && kept) values[key] = kept;
    }
    return { ...server, [field]: values } as McpServerConfig;
  });
}

/** Seals every env and header value for the file on disk; the list in memory keeps them open. */
export function sealSecrets(servers: readonly McpServerConfig[], box: SecretBox | undefined): McpServerConfig[] {
  if (!box) return servers.map(copyServer);
  const seal = (value: string) => (value ? box.seal(value) : value);
  return servers.map((server) =>
    server.transport === "http"
      ? { ...copyServer(server), headers: mapValues(server.headers, seal) as Record<string, string> }
      : { ...copyServer(server), env: mapValues(server.env, seal) as Record<string, string> },
  ) as McpServerConfig[];
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
