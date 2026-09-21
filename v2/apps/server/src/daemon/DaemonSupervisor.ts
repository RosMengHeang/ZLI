import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
};

export class DaemonSupervisor {
  private readonly endpointPath: string;
  private readonly protocolVersion: number;
  private readonly daemonVersion: string;
  private readonly waitTimeoutMs: number;
  private readonly launchDaemon: (input: LaunchInput) => Promise<DaemonEndpoint | { pid: number }>;

  constructor(options: SupervisorOptions) {
    this.endpointPath = resolve(options.endpointPath);
    this.protocolVersion = options.protocolVersion ?? 1;
    this.daemonVersion = options.daemonVersion ?? "zli-v2-daemon/1";
    this.waitTimeoutMs = options.waitTimeoutMs ?? 5_000;
    this.launchDaemon = options.launch ?? defaultLaunch;
  }

  async ensure(): Promise<DaemonEndpoint> {
    const existing = await this.readEndpoint();
    if (existing && this.isCompatible(existing) && (await this.handshake(existing))) return existing;

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
      endpoint.token.length > 0 &&
      isProcessAlive(endpoint.pid)
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
      const pending = this.pending.shift();
      if (pending) {
        try {
          pending.resolve(JSON.parse(line) as unknown);
        } catch (error) {
          pending.reject(error instanceof Error ? error : new Error("Invalid daemon response."));
        }
      } else {
        try {
          for (const listener of this.messageListeners) listener(JSON.parse(line) as unknown);
        } catch {
          // Ignore unsolicited malformed daemon frames; the next valid frame can still be consumed.
        }
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private fail(error: Error): void {
    if (this.closed && this.pending.length === 0) return;
    this.closed = true;
    for (const pending of this.pending.splice(0)) pending.reject(error);
  }
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
  const child = spawn(process.execPath, [entryPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      ZLI_DAEMON_ENDPOINT_PATH: input.endpointPath,
      ZLI_DAEMON_PROTOCOL_VERSION: String(input.protocolVersion),
      ZLI_DAEMON_VERSION: input.daemonVersion,
      ZLI_DAEMON_TOKEN: input.token,
    },
  });
  child.unref();
  if (!child.pid) throw new Error("Terminal daemon did not receive a process id.");
  return { pid: child.pid };
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

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
