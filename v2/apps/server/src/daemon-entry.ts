import { createServer, type Socket } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TerminalId, WorktreeId } from "@zli-v2/contracts";

import { NodePtyFactory } from "./terminal/NodePtyFactory.js";
import { TerminalService } from "./terminal/TerminalService.js";

const protocolVersion = Number.parseInt(process.env.ZLI_DAEMON_PROTOCOL_VERSION ?? "1", 10);
const daemonVersion = process.env.ZLI_DAEMON_VERSION ?? "zli-v2-daemon/1";
const token = process.env.ZLI_DAEMON_TOKEN;
const endpointPath = process.env.ZLI_DAEMON_ENDPOINT_PATH;

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
  await mkdir(dirname(endpointPath), { recursive: true });
  await writeFile(endpointPath, JSON.stringify(endpoint), "utf8");
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
    if (
      request.type !== "hello" ||
      request.token !== token ||
      request.protocolVersion !== protocolVersion
    ) {
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
      case "terminal.create":
        send(client.socket, {
          type: "result",
          terminal: await terminals.create({
            terminalId: TerminalId.parse(request.terminalId),
            worktreeId: WorktreeId.parse(request.worktreeId),
            cwd: String(request.cwd),
            shell: String(request.shell),
            cols: Number(request.cols),
            rows: Number(request.rows),
            title: String(request.title),
          }),
        });
        return;
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
        const attachment = terminals.attach(
          TerminalId.parse(request.terminalId),
          Number(request.afterSequence ?? 0),
        );
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

function send(socket: Socket, message: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
