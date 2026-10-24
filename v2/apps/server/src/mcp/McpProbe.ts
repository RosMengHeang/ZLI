import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import {
  isHttpServer,
  MAX_MCP_TOOL_NAME,
  MAX_MCP_TOOLS,
  type McpServerConfig,
  type McpToolInfo,
} from "@zli-v2/contracts";

import { runMcpBridge, SIGN_IN_CODE } from "./bridge/mcpBridge.js";
import type { StdioServerSpec } from "./bridge/stdioRelay.js";
import { spawnMcpServer, startProblem, stopMcpServer } from "./spawnServer.js";

export type McpProbeOutcome = {
  ok: boolean;
  tools: McpToolInfo[];
  problem?: string;
  needsSignIn?: boolean;
};

export type McpProbeOptions = {
  /** The sign-in token for remote servers. force=true after a 401 asks for a refreshed one. */
  getToken?: (force: boolean) => Promise<string | undefined>;
  onSignInRejected?: (token: string) => void | Promise<void>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  clientVersion?: string;
  /** Replaces starting a local server. */
  spawn?: (spec: StdioServerSpec) => ChildProcess;
};

export type McpProbe = (server: McpServerConfig, options?: McpProbeOptions) => Promise<McpProbeOutcome>;

/** A way to reach one server: send it messages, hear back through the handlers given to connect. */
export type ProbeConnection = { send(message: unknown): void; close(): Promise<void> };
export type ProbeHandlers = { onMessage(message: unknown): void; onClosed(problem: string): void };
export type ProbeConnect = (handlers: ProbeHandlers) => ProbeConnection;

const DEFAULT_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = "2025-06-18";
const MAX_DESCRIPTION = 1_000;
const MAX_PAGES = 100;
const METHOD_NOT_FOUND = -32601;
const BRIDGE_CLOSE_WAIT_MS = 4_000;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

class ProbeFailure extends Error {}

/**
 * Connects to a server the way an agent would and lists its tools. Local servers start as a process and
 * are stopped afterwards; remote ones go through the connect bridge in this process. Turned-off tools are
 * listed too, so the person sees everything the server offers.
 */
export const probeMcpServer: McpProbe = (server, options = {}) =>
  runProbe(server.name, isHttpServer(server) ? remoteConnect(server, options) : stdioConnect(server, options), options);

export async function runProbe(
  name: string,
  connect: ProbeConnect,
  options: { timeoutMs?: number; clientVersion?: string } = {},
): Promise<McpProbeOutcome> {
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  let closed: string | undefined;
  let nextId = 1;
  let connection: ProbeConnection | undefined;
  const outbox: unknown[] = [];
  const send = (message: unknown) => {
    if (connection) connection.send(message);
    else outbox.push(message);
  };

  const handlers: ProbeHandlers = {
    onMessage(message) {
      for (const item of Array.isArray(message) ? message : [message]) {
        if (!isObject(item)) continue;
        if (typeof item.method === "string") {
          // Requests from the server, such as ping or roots/list, still need an answer.
          if (isId(item.id)) {
            send(
              item.method === "ping"
                ? { jsonrpc: "2.0", id: item.id, result: {} }
                : {
                    jsonrpc: "2.0",
                    id: item.id,
                    error: { code: METHOD_NOT_FOUND, message: "ZLI's connection test does not support this." },
                  },
            );
          }
          continue;
        }
        if (!isId(item.id)) continue;
        const key = idKey(item.id);
        const waiting = pending.get(key);
        if (!waiting) continue;
        pending.delete(key);
        if (isObject(item.error)) {
          const code = typeof item.error.code === "number" ? item.error.code : 0;
          const text = typeof item.error.message === "string" ? item.error.message : "";
          waiting.reject(new RpcError(code, text));
        } else {
          waiting.resolve(item.result);
        }
      }
    },
    onClosed(problem) {
      closed ??= problem;
      for (const waiting of pending.values()) waiting.reject(new ProbeFailure(closed));
      pending.clear();
    },
  };

  const request = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (closed) return Promise.reject(new ProbeFailure(closed));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(idKey(id), { resolve, reject });
      send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    });
  };

  const talk = async (): Promise<McpProbeOutcome> => {
    try {
      await request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "zli", version: options.clientVersion ?? "1" },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return { ok: true, tools: await listTools(request) };
    } catch (error) {
      return failure(name, error);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = new Promise<McpProbeOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, tools: [], problem: `${name} did not answer within ${seconds(timeoutMs)}.` }),
      timeoutMs,
    );
  });
  try {
    connection = connect(handlers);
    for (const message of outbox.splice(0)) connection.send(message);
    return await Promise.race([talk(), timeout]);
  } catch (error) {
    return failure(name, error);
  } finally {
    clearTimeout(timer);
    closed ??= `${name} test ended.`;
    pending.clear();
    await connection?.close().catch(() => undefined);
  }
}

async function listTools(request: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
  const tools: McpToolInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let result: unknown;
    try {
      result = await request("tools/list", cursor ? { cursor } : {});
    } catch (error) {
      // A server without tools may not know the method at all.
      if (page === 0 && error instanceof RpcError && error.code === METHOD_NOT_FOUND) return tools;
      throw error;
    }
    const listed = isObject(result) && Array.isArray(result.tools) ? result.tools : [];
    for (const tool of listed) {
      if (!isObject(tool) || typeof tool.name !== "string") continue;
      if (tool.name.length === 0 || tool.name.length > MAX_MCP_TOOL_NAME) continue;
      const description = typeof tool.description === "string" ? tool.description.trim() : "";
      tools.push({
        name: tool.name,
        ...(description ? { description: description.slice(0, MAX_DESCRIPTION) } : {}),
      });
      if (tools.length >= MAX_MCP_TOOLS) return tools;
    }
    const next = isObject(result) ? result.nextCursor : undefined;
    if (typeof next !== "string" || next === "" || next === cursor) return tools;
    cursor = next;
  }
  return tools;
}

function failure(name: string, error: unknown): McpProbeOutcome {
  if (error instanceof RpcError && error.code === SIGN_IN_CODE) {
    return { ok: false, tools: [], needsSignIn: true, problem: `Sign in to ${name} first.` };
  }
  if (error instanceof RpcError) {
    const text = sentence(error.message);
    const problem = !text
      ? `${name} answered with an error.`
      : text.startsWith(name)
        ? text
        : `${name} answered with an error: ${text}`;
    return { ok: false, tools: [], problem };
  }
  if (error instanceof ProbeFailure) return { ok: false, tools: [], problem: error.message };
  return { ok: false, tools: [], problem: `ZLI could not test ${name}. ${sentence(String(error))}`.trim() };
}

function stdioConnect(server: Exclude<McpServerConfig, { transport: "http" }>, options: McpProbeOptions): ProbeConnect {
  return (handlers) => {
    const spec: StdioServerSpec = { command: server.command, args: [...server.args], env: { ...server.env } };
    let child: ChildProcess;
    try {
      child = (options.spawn ?? ((value) => spawnMcpServer(value, ["pipe", "pipe", "pipe"])))(spec);
    } catch (error) {
      throw new ProbeFailure(startProblem(server.command, error));
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4_000);
    });
    child.once("error", (error) => handlers.onClosed(startProblem(server.command, error)));
    child.once("close", () => handlers.onClosed(stoppedProblem(server.name, stderr)));
    child.stdin?.on("error", () => undefined);
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      lines.on("line", (line) => {
        const message = parseJson(line);
        if (message !== undefined) handlers.onMessage(message);
      });
    }
    return {
      send: (message) => {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      },
      close: async () => stopMcpServer(child),
    };
  };
}

function remoteConnect(
  server: Extract<McpServerConfig, { transport: "http" }>,
  options: McpProbeOptions,
): ProbeConnect {
  return (handlers) => {
    const input = new PassThrough();
    const done = runMcpBridge({
      url: server.url,
      name: server.name,
      headers: { ...server.headers },
      getToken: options.getToken ?? (async () => undefined),
      ...(options.onSignInRejected ? { onSignInRejected: options.onSignInRejected } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      input,
      output: {
        write: (line: string) => {
          const message = parseJson(line);
          if (message !== undefined) handlers.onMessage(message);
        },
      },
    });
    done.then(
      () => handlers.onClosed(`${server.name} closed the connection.`),
      () => handlers.onClosed(`${server.name} closed the connection.`),
    );
    return {
      send: (message) => {
        input.write(`${JSON.stringify(message)}\n`);
      },
      close: async () => {
        input.end();
        let wait: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          done.catch(() => undefined),
          new Promise((resolve) => {
            wait = setTimeout(resolve, BRIDGE_CLOSE_WAIT_MS);
          }),
        ]);
        clearTimeout(wait);
      },
    };
  };
}

function stoppedProblem(name: string, stderr: string): string {
  const last = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
  return last
    ? `${name} stopped before it answered: ${sentence(last.slice(0, 300))}`
    : `${name} stopped before it answered.`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function seconds(ms: number): string {
  const value = Math.round(ms / 1000);
  return value === 1 ? "1 second" : `${value} seconds`;
}

function parseJson(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function idKey(id: string | number): string {
  return `${typeof id}:${id}`;
}
