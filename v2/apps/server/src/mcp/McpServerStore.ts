import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  AgentToolAccess,
  DEFAULT_AGENT_TOOL_ACCESS,
  isHttpServer,
  type McpHttpServerConfig,
  type McpListResult,
  type McpServerConfig,
  McpServerList,
  type McpSettingsOutcome,
  type McpSignInStart,
  type McpSignInState,
} from "@zli-v2/contracts";

import { isPlainObject, type McpServerSpec, writeFileAtomic, writeFileIfChanged } from "../browser-tool/browserTool.js";
import type { UserSettingsOwnership } from "../browser-tool/userSettings.js";
import type { McpSignIns } from "./signIn/McpSignIns.js";
import { SignInError } from "./signIn/oauth.js";

/** ZLI's bundled connect bridge, run with Electron's Node like the other agent tools. */
export type ConnectTool = { command: string; script: string };

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
 * The server as agents launch it. A sign-in (OAuth) server runs through ZLI's connect bridge, which reads
 * the saved login from `tokenFile` and refreshes it, so it works in every agent the same way, Goose
 * included. Its headers go in `headerFile`, which keeps them out of the process list. Without the bridge
 * (tests and runs outside the desktop app), agents get the URL with the current token as a header.
 */
export function mcpLaunchSpec(
  server: McpServerConfig,
  options: { headerFile?: string; tokenFile?: string; accessToken?: string; connectTool?: ConnectTool } = {},
): McpServerSpec {
  if (!isHttpServer(server)) {
    return { name: server.name, command: server.command, args: [...server.args], env: { ...server.env } };
  }
  const hasHeaders = Object.keys(server.headers).length > 0;
  const tool = options.connectTool;
  if (server.oauth && tool && (!hasHeaders || options.headerFile)) {
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
        ...(options.tokenFile ? ["--token-file", options.tokenFile] : []),
        ...(hasHeaders && options.headerFile ? ["--header-file", options.headerFile] : []),
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

  constructor(
    private readonly options: {
      path: string;
      syncUserSettings?: McpUserSettingsSync;
      /** Servers from other sources, such as plugins. `taken` holds the lowercase names of the person's own servers, which win. */
      extraServers?: (taken: ReadonlySet<string>) => McpServerConfig[];
      signIns?: McpSignIns;
      connectTool?: ConnectTool;
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
    await this.writeHeaderFiles();
  }

  /** Enabled servers in the form agent launches use. */
  specs(): McpServerSpec[] {
    return [...this.servers.filter((server) => server.enabled), ...this.extraServers()].map((server) =>
      mcpLaunchSpec(server, this.launchOptions(server)),
    );
  }

  private launchOptions(server: McpServerConfig): Parameters<typeof mcpLaunchSpec>[1] {
    if (!isHttpServer(server) || !server.oauth) return {};
    const signIns = this.options.signIns;
    const accessToken = signIns?.accessToken(server.url);
    return {
      ...(needsHeaderFile(server) ? { headerFile: this.headerFile(server.name) } : {}),
      ...(signIns ? { tokenFile: signIns.tokenFile(server.url) } : {}),
      ...(accessToken ? { accessToken } : {}),
      ...(this.options.connectTool ? { connectTool: this.options.connectTool } : {}),
    };
  }

  /** Where the connect bridge reads one sign-in server's headers. */
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
      signIns: this.signInStates(),
      ...(this.problem ? { problem: this.problem } : {}),
    };
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

  private requireSignIns(): McpSignIns {
    const signIns = this.options.signIns;
    if (!signIns) throw new SignInError("Signing in is not available here.");
    return signIns;
  }

  private signInServer(name: string): McpHttpServerConfig {
    const key = name.toLowerCase();
    const server = [...this.servers, ...this.extraServers()].find((entry) => entry.name.toLowerCase() === key);
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

  /** Picks up a change in the extra servers: rewrites their header files and agent settings. */
  refresh(): Promise<void> {
    return this.serialize(async () => {
      await this.writeHeaderFiles();
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
      return extra(new Set(this.servers.map((server) => server.name.toLowerCase())));
    } catch {
      return [];
    }
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
    const wanted = [...this.servers, ...this.extraServers()].filter(needsHeaderFile);
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
