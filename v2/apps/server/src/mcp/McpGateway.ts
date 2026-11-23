import {
  isHttpServer,
  MAX_MCP_TOOLS,
  type McpGatewayService,
  type McpGatewayTool,
  type McpServerConfig,
  type McpToolsCallResult,
  type McpToolsFindResult,
} from "@zli-v2/contracts";

import { SIGN_IN_CODE } from "./bridge/mcpBridge.js";
import type { ProbeConnect, ProbeConnection } from "./McpProbe.js";

/**
 * One server an agent may use, with what the gateway needs to reach it. `cwd` is where a local server starts; a
 * remote one is the same for every agent, so it is shared.
 */
export type GatewayServer = {
  config: McpServerConfig;
  /** Tools the person turned off: never listed, never called. */
  hiddenTools: readonly string[];
  cwd?: string;
  connect: ProbeConnect;
};

const PROTOCOL_VERSION = "2025-06-18";
const METHOD_NOT_FOUND = -32601;
const MAX_PAGES = 50;
const MAX_DESCRIPTION = 600;
/** A schema larger than this is cut to its top-level properties; agents still learn the argument names. */
const MAX_SCHEMA_CHARS = 12_000;
const DEFAULT_LIMIT = 8;
const STOP_WORDS = new Set(["a", "an", "the", "to", "of", "for", "in", "on", "and", "or", "my", "with", "from", "me"]);

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

class ClosedError extends Error {}

/** A live MCP session with one server: initialized once, then reused for listing and calls until it goes idle. */
class GatewaySession {
  readonly #pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  #connection: ProbeConnection | undefined;
  #closed: string | undefined;
  #nextId = 1;
  #ready: Promise<void> | undefined;
  #tools: Promise<McpGatewayTool[]> | undefined;
  #idle: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly name: string,
    private readonly connect: ProbeConnect,
    private readonly options: { timeoutMs: number; idleMs: number; onGone(): void },
  ) {}

  get closed(): boolean {
    return this.#closed !== undefined;
  }

  /** Connects and initializes on first use; later calls share the same handshake. */
  ready(): Promise<void> {
    this.#ready ??= this.#start();
    return this.#ready;
  }

  async #start(): Promise<void> {
    this.#connection = this.connect({
      onMessage: (message) => this.#receive(message),
      onClosed: (problem) => this.#close(problem),
    });
    await this.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "zli-gateway", version: "1" } },
      this.options.timeoutMs,
    );
    this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /** The server's tools, listed once and again after it says they changed. */
  tools(hidden: ReadonlySet<string>): Promise<McpGatewayTool[]> {
    this.#tools ??= this.#listTools().catch((error: unknown) => {
      this.#tools = undefined;
      throw error;
    });
    return this.#tools.then((tools) => tools.filter((tool) => !hidden.has(tool.name)));
  }

  async #listTools(): Promise<McpGatewayTool[]> {
    await this.ready();
    const tools: McpGatewayTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let result: unknown;
      try {
        result = await this.request("tools/list", cursor ? { cursor } : {}, this.options.timeoutMs);
      } catch (error) {
        if (page === 0 && error instanceof RpcError && error.code === METHOD_NOT_FOUND) return tools;
        throw error;
      }
      const listed = isObject(result) && Array.isArray(result.tools) ? result.tools : [];
      for (const raw of listed) {
        const tool = gatewayTool(this.name, raw);
        if (tool) tools.push(tool);
        if (tools.length >= MAX_MCP_TOOLS) return tools;
      }
      const next = isObject(result) ? result.nextCursor : undefined;
      if (typeof next !== "string" || next === "" || next === cursor) return tools;
      cursor = next;
    }
    return tools;
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.#closed) return Promise.reject(new ClosedError(this.#closed));
    this.#touch();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(String(id));
        reject(new ClosedError(`${this.name} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`));
      }, timeoutMs);
      this.#pending.set(String(id), {
        resolve: (value) => {
          clearTimeout(timer);
          this.#touch();
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #send(message: unknown): void {
    this.#connection?.send(message);
  }

  #receive(message: unknown): void {
    for (const item of Array.isArray(message) ? message : [message]) {
      if (!isObject(item)) continue;
      if (typeof item.method === "string") {
        if (item.method === "notifications/tools/list_changed") this.#tools = undefined;
        // Requests from the server, such as ping, still need an answer.
        if (isId(item.id)) {
          this.#send(
            item.method === "ping"
              ? { jsonrpc: "2.0", id: item.id, result: {} }
              : { jsonrpc: "2.0", id: item.id, error: { code: METHOD_NOT_FOUND, message: "Not supported by ZLI." } },
          );
        }
        continue;
      }
      if (!isId(item.id)) continue;
      const waiting = this.#pending.get(String(item.id));
      if (!waiting) continue;
      this.#pending.delete(String(item.id));
      if (isObject(item.error)) {
        const code = typeof item.error.code === "number" ? item.error.code : 0;
        waiting.reject(new RpcError(code, typeof item.error.message === "string" ? item.error.message : ""));
      } else {
        waiting.resolve(item.result);
      }
    }
  }

  #touch(): void {
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => void this.close(), this.options.idleMs);
    this.#idle.unref?.();
  }

  #close(problem: string): void {
    if (this.#closed) return;
    this.#closed = problem;
    clearTimeout(this.#idle);
    for (const waiting of this.#pending.values()) waiting.reject(new ClosedError(problem));
    this.#pending.clear();
    this.options.onGone();
  }

  async close(): Promise<void> {
    const connection = this.#connection;
    this.#close(`${this.name} was closed.`);
    await connection?.close().catch(() => undefined);
  }
}

/**
 * ZLI's MCP gateway. Agents get one small server (ZLI's own) instead of every connected server's tool list; it
 * asks this gateway to find tools by what they do and to call them. So a service connected mid-chat is usable at
 * once, and tool lists cost an agent no context until it looks one up.
 *
 * Sessions are opened on first use and closed after a quiet spell. Remote servers are shared by every agent;
 * local ones start in the asking agent's worktree, because some act on the folder they run in.
 */
export class McpGateway {
  readonly #sessions = new Map<string, GatewaySession>();

  constructor(
    private readonly options: {
      /** How long to wait to connect or list tools. */
      timeoutMs?: number;
      /** How long a tool call may run. */
      callTimeoutMs?: number;
      /** How long an unused session stays open. */
      idleMs?: number;
    } = {},
  ) {}

  /** Tools across `servers` that match `query`, best first, or the servers alone when the query is empty. */
  async find(servers: readonly GatewayServer[], query: string, limit = DEFAULT_LIMIT): Promise<McpToolsFindResult> {
    const listed = await Promise.all(servers.map((server) => this.#listServer(server)));
    const services = listed.map((entry) => entry.service);
    if (servers.length === 0) {
      return {
        services,
        tools: [],
        hint: "No services are connected in ZLI. Use connect_service to ask the person to connect one.",
      };
    }
    const words = queryWords(query);
    const needsPerson = services.filter((service) => service.status !== "ready");
    const personHint =
      needsPerson.length > 0
        ? ` ${needsPerson.map((service) => service.name).join(", ")} ${needsPerson.length === 1 ? "is" : "are"} not available right now; use connect_service to ask the person to sign in or fix ${needsPerson.length === 1 ? "it" : "them"}.`
        : "";
    if (words.length === 0) {
      return {
        services,
        tools: [],
        hint: `Search with words for what you want to do, such as "deploy" or "create issue", to get tools and their arguments.${personHint}`,
      };
    }
    const scored = listed
      .flatMap((entry) => entry.tools)
      .map((tool, order) => ({ tool, order, score: scoreTool(tool, words) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, limit)
      .map((entry) => entry.tool);
    return {
      services,
      tools: scored,
      ...(scored.length === 0
        ? {
            hint: `No tool matched "${query}". Try other words, or an empty query to see which services are connected.${personHint}`,
          }
        : personHint
          ? { hint: personHint.trim() }
          : {}),
    };
  }

  /** Calls one tool and passes its result through as the server gave it. */
  async call(
    servers: readonly GatewayServer[],
    serverName: string,
    tool: string,
    args: Record<string, unknown> | undefined,
  ): Promise<McpToolsCallResult> {
    const server = servers.find((entry) => entry.config.name.toLowerCase() === serverName.toLowerCase());
    if (!server) {
      const names = servers.map((entry) => entry.config.name);
      return failed(
        names.length > 0
          ? `There is no connected service called ${serverName}. Connected: ${names.join(", ")}.`
          : "No services are connected in ZLI. Use connect_service to ask the person to connect one.",
      );
    }
    const name = server.config.name;
    if (server.hiddenTools.includes(tool)) return failed(`${tool} is turned off for ${name} in ZLI.`);
    const session = this.#session(server);
    try {
      await session.ready();
      const result = await session.request(
        "tools/call",
        { name: tool, arguments: args ?? {} },
        this.options.callTimeoutMs ?? 5 * 60_000,
      );
      return callResult(result);
    } catch (error) {
      return failed(problemText(name, error, tool));
    }
  }

  /** Closes every session, such as when ZLI quits. */
  async close(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }

  async #listServer(server: GatewayServer): Promise<{ service: McpGatewayService; tools: McpGatewayTool[] }> {
    const name = server.config.name;
    try {
      const tools = await this.#session(server).tools(new Set(server.hiddenTools));
      return { service: { name, status: "ready", toolCount: tools.length }, tools };
    } catch (error) {
      const signIn = error instanceof RpcError && error.code === SIGN_IN_CODE;
      return {
        service: {
          name,
          status: signIn ? "needs_sign_in" : "error",
          toolCount: 0,
          problem: signIn ? `Sign in to ${name} first.` : problemText(name, error),
        },
        tools: [],
      };
    }
  }

  #session(server: GatewayServer): GatewaySession {
    // A changed setup (address, command, headers) makes a new key, so edits apply to the next call.
    const key = JSON.stringify([server.config, isHttpServer(server.config) ? "" : (server.cwd ?? "")]);
    const existing = this.#sessions.get(key);
    if (existing && !existing.closed) return existing;
    const session: GatewaySession = new GatewaySession(server.config.name, server.connect, {
      timeoutMs: this.options.timeoutMs ?? 30_000,
      idleMs: this.options.idleMs ?? 10 * 60_000,
      onGone: () => {
        if (this.#sessions.get(key) === session) this.#sessions.delete(key);
      },
    });
    this.#sessions.set(key, session);
    return session;
  }
}

function gatewayTool(server: string, raw: unknown): McpGatewayTool | undefined {
  if (!isObject(raw) || typeof raw.name !== "string" || raw.name.length === 0) return undefined;
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const text = [title && title !== raw.name ? title : "", description].filter(Boolean).join(". ");
  const annotations = isObject(raw.annotations) ? raw.annotations : undefined;
  return {
    server,
    name: raw.name,
    ...(text ? { description: text.slice(0, MAX_DESCRIPTION) } : {}),
    ...(raw.inputSchema !== undefined ? { inputSchema: compactSchema(raw.inputSchema) } : {}),
    ...(annotations?.readOnlyHint === true ? { readOnly: true } : {}),
  };
}

/** Keeps a schema whole when it is small; a huge one keeps its property names, types, and required list. */
function compactSchema(schema: unknown): unknown {
  if (JSON.stringify(schema ?? null).length <= MAX_SCHEMA_CHARS || !isObject(schema)) return schema;
  const properties = isObject(schema.properties) ? schema.properties : {};
  const slim: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    slim[key] = isObject(value)
      ? {
          ...(value.type !== undefined ? { type: value.type } : {}),
          ...(typeof value.description === "string" ? { description: value.description.slice(0, 200) } : {}),
        }
      : {};
  }
  return { type: "object", properties: slim, ...(Array.isArray(schema.required) ? { required: schema.required } : {}) };
}

/** Lowercase words of a query, without small filler words. */
export function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word));
}

/** Splits a tool name such as createIssue or create_issue into its words. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

/**
 * How well a tool matches the query's words: the server's name counts most for picking a service, the tool's own
 * name next, then its description. A word matches the start of a word, so "deploy" finds "deployments".
 */
export function scoreTool(tool: McpGatewayTool, words: readonly string[]): number {
  const server = nameWords(tool.server);
  const name = nameWords(tool.name);
  const description = (tool.description ?? "").toLowerCase().split(/[^a-z0-9]+/u);
  let score = 0;
  let matched = 0;
  for (const word of words) {
    const hits = (list: readonly string[]) =>
      list.some((entry) => entry.startsWith(word) || (word.startsWith(entry) && entry.length >= 4));
    const best = hits(name) ? 4 : hits(server) ? 3 : hits(description) ? 1 : 0;
    if (best > 0) matched += 1;
    score += best;
  }
  if (matched === 0) return 0;
  // Every query word found beats a few strong hits.
  return score + (matched === words.length ? 2 : 0);
}

function callResult(result: unknown): McpToolsCallResult {
  if (!isObject(result)) return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
  const content = Array.isArray(result.content) ? result.content.filter(isObject) : [];
  return {
    content: content.length > 0 ? content : [{ type: "text", text: "The tool returned nothing." }],
    ...(result.isError === true ? { isError: true } : {}),
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
  };
}

function failed(text: string): McpToolsCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

function problemText(name: string, error: unknown, tool?: string): string {
  if (error instanceof RpcError && error.code === SIGN_IN_CODE) {
    return `Sign in to ${name} first. Use connect_service to ask the person, then try again.`;
  }
  const message = error instanceof Error ? error.message.trim() : String(error);
  if (error instanceof RpcError) {
    return tool ? `${name} turned down ${tool}: ${message || "no reason given."}` : `${name}: ${message}`;
  }
  return message || `${name} could not be reached.`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}
