import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolve } from "node:path";

import { TERMINAL_DAEMON_VERSION } from "@zli-v2/contracts";

type DaemonEndpoint = {
  protocolVersion: number;
  daemonVersion: string;
  pid: number;
  host: string;
  port: number;
  token: string;
};

export async function ensureDesktopDaemon(options: {
  endpointPath: string;
  entryPath: string;
  timeoutMs?: number;
  stopProcess?: (pid: number) => void;
}): Promise<DaemonEndpoint> {
  const endpointPath = resolve(options.endpointPath);
  const existing = await readEndpoint(endpointPath);
  if (existing && (await handshake(existing))) {
    if (existing.daemonVersion === TERMINAL_DAEMON_VERSION) return existing;
    // An older daemon rejects newer requests (agent launch arguments, for one), and once replaced
    // its PTYs would keep running with nothing attached.
    (options.stopProcess ?? stopProcess)(existing.pid);
  }

  const token = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [resolve(options.entryPath)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ZLI_DAEMON_ENDPOINT_PATH: endpointPath,
      ZLI_DAEMON_PROTOCOL_VERSION: "1",
      ZLI_DAEMON_VERSION: TERMINAL_DAEMON_VERSION,
      ZLI_DAEMON_TOKEN: token,
    },
  });
  child.unref();

  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    const endpoint = await readEndpoint(endpointPath);
    if (endpoint?.token === token && (await handshake(endpoint))) return endpoint;
    await delay(25);
  }
  throw new Error("Timed out waiting for the desktop terminal daemon.");
}

async function readEndpoint(path: string): Promise<DaemonEndpoint | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isEndpoint(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function handshake(endpoint: DaemonEndpoint, timeoutMs = 1_000): Promise<boolean> {
  const socket = createConnection({ host: endpoint.host, port: endpoint.port });
  const timer = setTimeout(() => socket.destroy(new Error("Daemon handshake timed out.")), timeoutMs);
  socket.setEncoding("utf8");
  try {
    await new Promise<void>((resolveConnection, rejectConnection) => {
      socket.once("connect", resolveConnection);
      socket.once("error", rejectConnection);
    });
    socket.write(`${JSON.stringify({ type: "hello", protocolVersion: 1, token: endpoint.token })}\n`);
    const response = await readLine(socket);
    return Boolean(response && response.type === "hello" && response.protocolVersion === 1);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

function readLine(
  socket: ReturnType<typeof createConnection>,
): Promise<{ type?: unknown; protocolVersion?: unknown } | undefined> {
  return new Promise((resolveLine, rejectLine) => {
    let buffer = "";
    const onData = (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      try {
        resolveLine(JSON.parse(buffer.slice(0, newline)) as { type?: unknown; protocolVersion?: unknown });
      } catch {
        resolveLine(undefined);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      rejectLine(error);
    };
    const onClose = () => {
      cleanup();
      resolveLine(undefined);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function isEndpoint(value: unknown): value is DaemonEndpoint {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<DaemonEndpoint>;
  return (
    input.protocolVersion === 1 &&
    typeof input.daemonVersion === "string" &&
    input.host === "127.0.0.1" &&
    typeof input.pid === "number" &&
    typeof input.port === "number" &&
    typeof input.token === "string" &&
    input.token.length > 0
  );
}

/** The pid is self-reported by a daemon that just proved it holds the endpoint token. */
function stopProcess(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid);
  } catch {
    // Already exited.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
