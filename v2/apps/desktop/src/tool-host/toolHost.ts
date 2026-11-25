import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { createAgentMcpServer } from "../agent-tool/mcp.js";
import { createZliBrowserClient } from "../browser-tool/client.js";
import { createMcpServer, type McpServer } from "../browser-tool/mcp.js";
import { createMobileMcpServer } from "../mobile-tool/mcp.js";

/**
 * ZLI's own MCP servers (zli, zli-browser, zli-mobile) for every agent at once, over streamable HTTP.
 * Started as three stdio processes per agent they cost about 330 MB per chat; here they share one process.
 * Each agent's URL names its worktree and working folder, which the stdio servers read from their
 * environment and their own working folder.
 */
export const TOOL_SERVER_NAMES = ["zli", "zli-browser", "zli-mobile"] as const;
export type ToolServerName = (typeof TOOL_SERVER_NAMES)[number];

/** Who is calling: the agent's worktree and working folder, as the stdio servers would know them. */
export type ToolCaller = { worktreeId?: string; cwd?: string };

/** The part of the URL after the server name. base64url JSON keeps paths with any characters intact. */
export function encodeCaller(caller: ToolCaller): string {
  const compact: { w?: string; c?: string } = {};
  if (caller.worktreeId) compact.w = caller.worktreeId;
  if (caller.cwd) compact.c = caller.cwd;
  return Buffer.from(JSON.stringify(compact), "utf8").toString("base64url");
}

export function decodeCaller(value: string): ToolCaller | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { w?: unknown; c?: unknown };
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return {
      ...(typeof parsed.w === "string" && parsed.w ? { worktreeId: parsed.w } : {}),
      ...(typeof parsed.c === "string" && parsed.c ? { cwd: parsed.c } : {}),
    };
  } catch {
    return undefined;
  }
}

export type ToolHostOptions = {
  /** The desktop's endpoint file, which every tool call reads to reach ZLI. */
  controlFile: string;
  /** Bearer token agents send. Generated when not given. */
  token?: string;
  /** Builds a server for one caller; tests replace it. */
  createServer?: (name: ToolServerName, caller: ToolCaller) => McpServer;
};

export type ToolHost = { port: number; token: string; close(): Promise<void> };

/** Most servers a host keeps. A worktree removed long ago drops out first when this fills. */
const MAX_CACHED_SERVERS = 500;
/** A tool call can carry a screenshot; anything far larger is not a real MCP message. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export async function startToolHost(options: ToolHostOptions): Promise<ToolHost> {
  const token = options.token ?? randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const build = options.createServer ?? ((name, caller) => defaultServer(name, caller, options.controlFile));
  const servers = new Map<string, McpServer>();

  const serverFor = (name: ToolServerName, key: string, caller: ToolCaller): McpServer => {
    const cacheKey = `${name}/${key}`;
    const cached = servers.get(cacheKey);
    if (cached) {
      // Refreshes its place, so the least recently used server is the one dropped.
      servers.delete(cacheKey);
      servers.set(cacheKey, cached);
      return cached;
    }
    const created = build(name, caller);
    servers.set(cacheKey, created);
    if (servers.size > MAX_CACHED_SERVERS) {
      const oldest = servers.keys().next().value;
      if (oldest !== undefined) servers.delete(oldest);
    }
    return created;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const authorization = Buffer.from(request.headers.authorization ?? "");
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
      return reply(response, 401, { error: "unauthorized" });
    }
    const match = /^\/mcp\/([a-z-]+)\/([A-Za-z0-9_-]*)$/u.exec((request.url ?? "").split("?")[0] ?? "");
    const name = match?.[1] as ToolServerName | undefined;
    const caller = match ? decodeCaller(match[2] ?? "") : undefined;
    if (!name || !TOOL_SERVER_NAMES.includes(name) || !caller) return reply(response, 404, { error: "not found" });
    // Streamable HTTP lets a client open a stream for server-sent messages. These servers never send any.
    if (request.method === "GET") return reply(response, 405, { error: "method not allowed" });
    if (request.method === "DELETE") return reply(response, 200, {});
    if (request.method !== "POST") return reply(response, 405, { error: "method not allowed" });
    let message: unknown;
    try {
      message = JSON.parse(await readBody(request));
    } catch {
      return reply(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
    }
    const server = serverFor(name, match?.[2] ?? "", caller);
    if (Array.isArray(message)) {
      const answers = (await Promise.all(message.map((item) => server.handleMessage(item)))).filter(
        (answer) => answer !== undefined,
      );
      return answers.length > 0 ? reply(response, 200, answers) : accepted(response);
    }
    const answer = await server.handleMessage(message);
    return answer === undefined ? accepted(response) : reply(response, 200, answer);
  };

  const http: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) reply(response, 500, { error: "The tool host failed." });
      else response.end();
    });
  });
  // Tool calls can wait on the person, such as an app card or a device prompt, for minutes.
  http.requestTimeout = 0;
  http.headersTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("The tool host has no port.");
  return {
    port: address.port,
    token,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

function defaultServer(name: ToolServerName, caller: ToolCaller, controlFile: string): McpServer {
  const env = {
    ZLI_BROWSER_CONTROL_FILE: controlFile,
    ...(caller.worktreeId ? { ZLI_WORKTREE_ID: caller.worktreeId } : {}),
  };
  // Without a folder the call carries none, and ZLI goes by the worktree id alone.
  const cwd = () => caller.cwd as string;
  if (name === "zli") {
    return createAgentMcpServer(
      createZliBrowserClient({
        env,
        cwd,
        notRunningMessage: "ZLI is not running, so other agents cannot be reached.",
        serviceName: "ZLI",
      }),
    );
  }
  if (name === "zli-mobile") {
    return createMobileMcpServer(
      createZliBrowserClient({
        env,
        cwd,
        notRunningMessage: "ZLI is not running, so its Mobile panel is unavailable.",
        serviceName: "ZLI's mobile service",
      }),
      caller.cwd ? cwd : undefined,
    );
  }
  return createMcpServer(createZliBrowserClient({ env, cwd }));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("The request is too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function accepted(response: ServerResponse): void {
  response.writeHead(202);
  response.end();
}
