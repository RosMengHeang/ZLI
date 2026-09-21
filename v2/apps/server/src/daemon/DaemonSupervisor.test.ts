import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DaemonSupervisor, type DaemonEndpoint } from "./DaemonSupervisor.js";

const servers: Server[] = [];
const directories: string[] = [];

async function makeDaemon(endpointPath: string, token: string, protocolVersion = 1): Promise<DaemonEndpoint> {
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline)) as { type: string; token?: string; protocolVersion?: number };
      if (request.type === "hello" && request.token === token && request.protocolVersion === protocolVersion) {
        socket.write(`${JSON.stringify({ type: "hello", protocolVersion })}\n`);
      } else {
        socket.write(`${JSON.stringify({ type: "error", message: "unauthorized" })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const endpoint: DaemonEndpoint = {
    protocolVersion,
    daemonVersion: "test-daemon",
    pid: process.pid,
    host: "127.0.0.1",
    port: address.port,
    token,
  };
  await writeFile(endpointPath, JSON.stringify(endpoint), "utf8");
  return endpoint;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("DaemonSupervisor", () => {
  it("adopts a compatible daemon endpoint and authenticates it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zli-daemon-test-"));
    directories.push(directory);
    const endpointPath = join(directory, "daemon.json");
    const endpoint = await makeDaemon(endpointPath, "adopt-token");
    let launchCount = 0;
    const supervisor = new DaemonSupervisor({
      endpointPath,
      daemonVersion: "test-daemon",
      launch: async () => {
        launchCount += 1;
        return { pid: endpoint.pid };
      },
    });

    await expect(supervisor.ensure()).resolves.toEqual(endpoint);
    expect(launchCount).toBe(0);
    expect(JSON.parse(await readFile(endpointPath, "utf8"))).toMatchObject({ token: "adopt-token" });
  });

  it("relaunches when the persisted endpoint is incompatible", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zli-daemon-test-"));
    directories.push(directory);
    const endpointPath = join(directory, "daemon.json");
    await makeDaemon(endpointPath, "old-token", 0);
    let launchCount = 0;
    const supervisor = new DaemonSupervisor({
      endpointPath,
      daemonVersion: "test-daemon",
      launch: async ({ token }) => {
        launchCount += 1;
        return makeDaemon(endpointPath, token);
      },
      waitTimeoutMs: 500,
    });

    const endpoint = await supervisor.ensure();
    expect(launchCount).toBe(1);
    expect(endpoint.protocolVersion).toBe(1);
    expect(endpoint.token).not.toBe("old-token");
  });
});
