import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TERMINAL_DAEMON_VERSION } from "@zli-v2/contracts";

export type DaemonEndpoint = {
  protocolVersion: number;
  daemonVersion: string;
  pid: number;
  host: string;
  port: number;
  token: string;
};

type LaunchInput = {
  endpointPath: string;
  protocolVersion: number;
  daemonVersion: string;
  token: string;
};

type SupervisorOptions = {
  endpointPath: string;
  protocolVersion?: number;
  daemonVersion?: string;
  waitTimeoutMs?: number;
  launch?: (input: LaunchInput) => Promise<DaemonEndpoint | { pid: number }>;
  stopProcess?: (pid: number) => void;
};

export class DaemonSupervisor {
  private readonly endpointPath: string;
  private readonly protocolVersion: number;
  private readonly daemonVersion: string;
  private readonly waitTimeoutMs: number;
  private readonly launchDaemon: (input: LaunchInput) => Promise<DaemonEndpoint | { pid: number }>;
  private readonly stopProcess: (pid: number) => void;

  constructor(options: SupervisorOptions) {
    this.endpointPath = resolve(options.endpointPath);
    this.protocolVersion = options.protocolVersion ?? 1;
    this.daemonVersion = options.daemonVersion ?? TERMINAL_DAEMON_VERSION;
    this.waitTimeoutMs = options.waitTimeoutMs ?? 5_000;
    this.launchDaemon = options.launch ?? defaultLaunch;
    this.stopProcess = options.stopProcess ?? stopDaemonProcess;
  }

  async ensure(): Promise<DaemonEndpoint> {
    const existing = await this.readEndpoint();
    if (existing && existing.host === "127.0.0.1" && (await this.handshake(existing))) {
      if (this.isCompatible(existing)) return existing;
      // A live daemon from another build would keep its PTYs running unseen once replaced.
      this.stopProcess(existing.pid);
    }

    const token = randomBytes(32).toString("hex");
    const launched = await this.launchDaemon({
      endpointPath: this.endpointPath,
      protocolVersion: this.protocolVersion,
      daemonVersion: this.daemonVersion,
      token,
    });
    if (isDaemonEndpoint(launched) && this.isCompatible(launched) && (await this.handshake(launched))) {
      return launched;
    }

    const deadline = Date.now() + this.waitTimeoutMs;
    while (Date.now() < deadline) {
      const endpoint = await this.readEndpoint();
      if (endpoint && endpoint.token === token && this.isCompatible(endpoint) && (await this.handshake(endpoint))) {
        return endpoint;
      }
      await delay(25);
    }
    throw new Error("Timed out waiting for a compatible terminal daemon.");
  }

  async connect(endpoint?: DaemonEndpoint): Promise<DaemonConnection> {
    const target = endpoint ?? (await this.ensure());
    const connection = await connectDaemon(target);
    const hello = await connection.request({
      type: "hello",
      protocolVersion: this.protocolVersion,
      token: target.token,
    });
    if (!isHelloResponse(hello, this.protocolVersion)) {
      connection.close();
      throw new Error("Terminal daemon handshake was rejected.");
    }
    return connection;
  }

  private async readEndpoint(): Promise<DaemonEndpoint | undefined> {
    try {
      const raw = JSON.parse(await readFile(this.endpointPath, "utf8")) as unknown;
      return isDaemonEndpoint(raw) ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  private isCompatible(endpoint: DaemonEndpoint): boolean {
    return (
      endpoint.protocolVersion === this.protocolVersion &&
      endpoint.daemonVersion === this.daemonVersion &&
      endpoint.host === "127.0.0.1" &&
      endpoint.port > 0 &&
      endpoint.token.length > 0
    );
  }

  private async handshake(endpoint: DaemonEndpoint): Promise<boolean> {
    try {
      const connection = await connectDaemon(endpoint);
      const response = await connection.request({
        type: "hello",
        protocolVersion: this.protocolVersion,
        token: endpoint.token,
      });
      connection.close();
      return isHelloResponse(response, this.protocolVersion);
    } catch {
      return false;
    }
  }
}

export class DaemonConnection {
  private buffer = "";
  private readonly pending: Array<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closeNotified = false;
  private closed = false;

  constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("Terminal daemon connection closed.")));
  }

  request(message: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Terminal daemon connection is closed."));
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    if (this.closeNotified) {
      listener();
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    this.fail(new Error("Terminal daemon connection closed."));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error) {
        const pending = this.pending.shift();
        pending?.reject(error instanceof Error ? error : new Error("Invalid daemon response."));
        newline = this.buffer.indexOf("\n");
        continue;
      }
      if (isUnsolicitedDaemonMessage(parsed)) {
        for (const listener of this.messageListeners) listener(parsed);
      } else {
        const pending = this.pending.shift();
        if (pending) pending.resolve(parsed);
        else for (const listener of this.messageListeners) listener(parsed);
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private fail(error: Error): void {
    if (this.closeNotified) return;
    this.closed = true;
    for (const pending of this.pending.splice(0)) pending.reject(error);
    this.closeNotified = true;
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
  }
}

function isUnsolicitedDaemonMessage(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "terminal");
}

async function connectDaemon(endpoint: DaemonEndpoint): Promise<DaemonConnection> {
  const socket = createConnection({ host: endpoint.host, port: endpoint.port });
  await new Promise<void>((resolveConnection, reject) => {
    socket.once("connect", resolveConnection);
    socket.once("error", reject);
  });
  return new DaemonConnection(socket);
}

async function defaultLaunch(input: LaunchInput): Promise<{ pid: number }> {
  const entryPath = resolve(dirname(fileURLToPath(import.meta.url)), "daemon-entry.js");
  const environment = {
    ...process.env,
    ZLI_DAEMON_ENDPOINT_PATH: input.endpointPath,
    ZLI_DAEMON_PROTOCOL_VERSION: String(input.protocolVersion),
    ZLI_DAEMON_VERSION: input.daemonVersion,
    ZLI_DAEMON_TOKEN: input.token,
  };
  const child =
    process.platform === "win32"
      ? spawn(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", `start "" /b "${process.execPath}" "${entryPath}"`],
          {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
            windowsVerbatimArguments: true,
            env: environment,
          },
        )
      : spawn(process.execPath, [entryPath], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: environment,
        });
  child.unref();
  if (!child.pid) throw new Error("Terminal daemon did not receive a process id.");
  return { pid: child.pid };
}

/** The pid is self-reported by a daemon that just proved it holds the endpoint token. */
export function stopDaemonProcess(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid);
  } catch {
    // Already exited.
  }
}

function isDaemonEndpoint(value: unknown): value is DaemonEndpoint {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<DaemonEndpoint>;
  return (
    typeof input.protocolVersion === "number" &&
    typeof input.daemonVersion === "string" &&
    typeof input.pid === "number" &&
    typeof input.host === "string" &&
    typeof input.port === "number" &&
    typeof input.token === "string"
  );
}

function isHelloResponse(value: unknown, protocolVersion: number): boolean {
  if (!value || typeof value !== "object") return false;
  const input = value as { type?: unknown; protocolVersion?: unknown };
  return input.type === "hello" && input.protocolVersion === protocolVersion;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
