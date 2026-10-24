import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { handshake, shutdownDesktopDaemon } from "./DesktopDaemon.js";

it.each(["silent", "closed"])("rejects a %s daemon handshake without hanging startup", async (behavior) => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("data", () => {
      if (behavior === "closed") socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing TCP address");
    await expect(
      handshake(
        {
          host: "127.0.0.1",
          port: address.port,
          pid: process.pid,
          token: "test",
          protocolVersion: 1,
          daemonVersion: "zli-v2-daemon/1",
        },
        50,
      ),
    ).resolves.toBe(false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** A fake daemon that answers hello for `token` and replies to shutdown as told. */
async function fakeDaemon(token: string, onShutdown: "accept" | "refuse") {
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, newline)) as { type: string; token?: string };
        buffer = buffer.slice(newline + 1);
        requests.push(request.type);
        if (request.type === "hello") {
          socket.write(
            request.token === token
              ? `${JSON.stringify({ type: "hello", protocolVersion: 1 })}\n`
              : `${JSON.stringify({ type: "error", message: "unauthorized" })}\n`,
          );
        } else if (request.type === "shutdown") {
          socket.write(
            onShutdown === "accept"
              ? `${JSON.stringify({ type: "result", accepted: true })}\n`
              : `${JSON.stringify({ type: "error", message: "unsupported-request" })}\n`,
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  const directory = await mkdtemp(join(tmpdir(), "zli-daemon-shutdown-"));
  const endpointPath = join(directory, "runtime.sqlite.daemon.json");
  const writeEndpoint = (endpointToken: string) =>
    writeFile(
      endpointPath,
      JSON.stringify({
        protocolVersion: 1,
        daemonVersion: "zli-v2-daemon/5",
        pid: 424242,
        host: "127.0.0.1",
        port: address.port,
        token: endpointToken,
      }),
    );
  await writeEndpoint(token);
  return {
    endpointPath,
    requests,
    writeEndpoint,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it("asks the daemon to shut down and waits for it to exit", async () => {
  const daemon = await fakeDaemon("token", "accept");
  try {
    let running = 3;
    const stopped: number[] = [];
    await shutdownDesktopDaemon({
      endpointPath: daemon.endpointPath,
      isRunning: () => {
        running -= 1;
        return running > 0;
      },
      stopProcess: (pid) => stopped.push(pid),
    });
    expect(daemon.requests).toEqual(["hello", "shutdown"]);
    expect(stopped).toEqual([]);
  } finally {
    await daemon.close();
  }
});

it("stops an older daemon that has no shutdown request, once it proves the token", async () => {
  const daemon = await fakeDaemon("token", "refuse");
  try {
    const stopped: number[] = [];
    await shutdownDesktopDaemon({
      endpointPath: daemon.endpointPath,
      isRunning: () => stopped.length === 0,
      stopProcess: (pid) => stopped.push(pid),
    });
    expect(stopped).toEqual([424242]);
  } finally {
    await daemon.close();
  }
});

it("leaves the pid in a stale endpoint file alone when the token does not match", async () => {
  const daemon = await fakeDaemon("token", "accept");
  try {
    await daemon.writeEndpoint("someone-else");
    const stopped: number[] = [];
    await shutdownDesktopDaemon({
      endpointPath: daemon.endpointPath,
      isRunning: () => true,
      stopProcess: (pid) => stopped.push(pid),
    });
    expect(daemon.requests).toEqual(["hello"]);
    expect(stopped).toEqual([]);
  } finally {
    await daemon.close();
  }
});
