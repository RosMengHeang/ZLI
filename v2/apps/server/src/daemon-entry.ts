import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TERMINAL_DAEMON_VERSION, TerminalId, WorktreeId } from "@zli-v2/contracts";

import { NodePtyFactory } from "./terminal/NodePtyFactory.js";
import { TerminalService } from "./terminal/TerminalService.js";
import { TerminalCwdError } from "./terminal/terminalCwd.js";

const daemonEndpointFileMode = 0o600;
const protocolVersion = Number.parseInt(process.env.ZLI_DAEMON_PROTOCOL_VERSION ?? "1", 10);
const daemonVersion = process.env.ZLI_DAEMON_VERSION ?? TERMINAL_DAEMON_VERSION;
const token = process.env.ZLI_DAEMON_TOKEN;
const endpointPath = process.env.ZLI_DAEMON_ENDPOINT_PATH;
delete process.env.ZLI_DAEMON_TOKEN;
delete process.env.ZLI_DAEMON_ENDPOINT_PATH;

type Client = {
  socket: Socket;
  authenticated: boolean;
  subscriptions: Array<{ close(): void }>;
};

async function main(): Promise<void> {
  if (!token || !endpointPath) throw new Error("Terminal daemon environment is incomplete.");
  const terminals = new TerminalService(new NodePtyFactory());
  const server = createServer((socket) => accept(socket, terminals));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Terminal daemon did not bind.");
  const endpoint = {
    protocolVersion,
    daemonVersion,
    pid: process.pid,
    host: "127.0.0.1",
    port: address.port,
    token,
  };
  await writeDaemonEndpointFile(endpointPath, JSON.stringify(endpoint));
}

export async function writeDaemonEndpointFile(endpointPath: string, contents: string): Promise<void> {
  await mkdir(dirname(endpointPath), { recursive: true });
  try {
    await chmod(endpointPath, daemonEndpointFileMode);
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  await writeFile(endpointPath, contents, { encoding: "utf8", mode: daemonEndpointFileMode });
  await chmod(endpointPath, daemonEndpointFileMode);
}

export function accept(socket: Socket, terminals: TerminalService): void {
  const client: Client = { socket, authenticated: false, subscriptions: [] };
  socket.setEncoding("utf8");
  socket.on("error", () => socket.destroy());
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void handle(client, terminals, line);
      newline = buffer.indexOf("\n");
    }
  });
  socket.on("close", () => {
    for (const subscription of client.subscriptions) subscription.close();
  });
}

async function handle(client: Client, terminals: TerminalService, line: string): Promise<void> {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(line) as Record<string, unknown>;
  } catch {
    send(client.socket, { type: "error", message: "invalid-json" });
    return;
  }
  if (!client.authenticated) {
    if (request.type !== "hello" || request.token !== token || request.protocolVersion !== protocolVersion) {
      send(client.socket, { type: "error", message: "unauthorized" });
      client.socket.end();
      return;
    }
    client.authenticated = true;
    send(client.socket, { type: "hello", protocolVersion });
    return;
  }
  try {
    switch (request.type) {
      case "ping":
        send(client.socket, { type: "pong" });
        return;
      case "inventory":
      case "terminal.list":
        send(client.socket, { type: "result", terminals: terminals.list() });
        return;
      case "terminal.create": {
        if (request.argv !== undefined) throw new Error("Terminal launch does not accept argv.");
        const args = readLaunchArgs(request.args);
        const envOverrides = readEnvOverrides(request.envOverrides);
        const worktreePath = request.worktreePath;
        const cwd = request.cwd;
        const shell = request.shell;
        if (typeof worktreePath !== "string" || typeof cwd !== "string" || typeof shell !== "string") {
          throw new TerminalCwdError();
        }
        send(client.socket, {
          type: "result",
          terminal: await terminals.create({
            terminalId: TerminalId.parse(request.terminalId),
            worktreeId: WorktreeId.parse(request.worktreeId),
            worktreePath,
            cwd,
            shell,
            ...(args ? { args } : {}),
            ...(envOverrides ? { envOverrides } : {}),
            cols: Number(request.cols),
            rows: Number(request.rows),
            title: String(request.title),
          }),
        });
        return;
      }
      case "terminal.write":
        terminals.write(TerminalId.parse(request.terminalId), String(request.data));
        send(client.socket, { type: "result", accepted: true });
        return;
      case "terminal.resize":
        terminals.resize(TerminalId.parse(request.terminalId), Number(request.cols), Number(request.rows));
        send(client.socket, { type: "result", accepted: true });
        return;
      case "terminal.stop":
        terminals.stop(TerminalId.parse(request.terminalId));
        send(client.socket, { type: "result", accepted: true });
        return;
      case "terminal.attach": {
        const attachment = terminals.attach(TerminalId.parse(request.terminalId), Number(request.afterSequence ?? 0));
        client.subscriptions.push(attachment.subscription);
        send(client.socket, { type: "snapshot", snapshot: attachment.snapshot });
        void streamSubscription(client.socket, attachment.subscription);
        return;
      }
      default:
        send(client.socket, { type: "error", message: "unsupported-request" });
    }
  } catch (error) {
    send(client.socket, {
      type: "error",
      message: error instanceof Error ? error.message : "daemon-request-failed",
    });
  }
}

async function streamSubscription(
  socket: Socket,
  subscription: { next(): Promise<unknown | undefined> },
): Promise<void> {
  while (!socket.destroyed) {
    const message = await subscription.next();
    if (!message) return;
    send(socket, { type: "terminal", message });
  }
}

const MAX_LAUNCH_ARGS = 32;
const MAX_LAUNCH_ARG_LENGTH = 1_000;
const ALLOWED_ENV_OVERRIDES = new Set(["TERM", "COLORTERM"]);

function readLaunchArgs(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > MAX_LAUNCH_ARGS ||
    !value.every((arg) => typeof arg === "string" && arg.length <= MAX_LAUNCH_ARG_LENGTH && !arg.includes("\0"))
  ) {
    throw new Error("Terminal launch arguments are invalid.");
  }
  return value.length > 0 ? [...(value as string[])] : undefined;
}

/** Only terminal capability hints may be overridden; anything else could redirect the child's tools. */
function readEnvOverrides(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Terminal environment overrides are invalid.");
  }
  const overrides: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!ALLOWED_ENV_OVERRIDES.has(key) || typeof entry !== "string" || entry.length > 100) {
      throw new Error(`Terminal environment override is not allowed: ${key}`);
    }
    overrides[key] = entry;
  }
  return overrides;
}

function send(socket: Socket, message: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
