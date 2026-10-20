import { type EnvironmentDescriptor, EnvironmentId } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import type { TerminalService } from "../terminal/TerminalService.js";
import { RpcServer } from "./Server.js";

const environment: EnvironmentDescriptor = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000101"),
  label: "RPC test environment",
  protocolVersion: 1,
  capabilities: { eventReplay: true },
};

const resources: Array<{ database: Database; server: RpcServer }> = [];

async function makeServer() {
  const database = new Database({ path: ":memory:" });
  const engine = new Engine({ database, environment });
  const server = new RpcServer({ engine, environment, token: "test-token" });
  await server.start();
  resources.push({ database, server });
  return server;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      socket.off("error", onError);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    };
    const onError = (error: Error) => {
      socket.off("message", onMessage);
      reject(error);
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
}

async function connected(server: RpcServer) {
  const socket = new WebSocket(server.url());
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      token: "test-token",
      environmentId: environment.environmentId,
    }),
  );
  await expect(nextMessage(socket)).resolves.toMatchObject({ type: "hello" });
  return socket;
}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.server.stop();
    resource.database.close();
  }
});

describe("authenticated local RPC server", () => {
  it("authenticates the handshake and streams a projection subscription", async () => {
    const server = await makeServer();
    const socket = await connected(server);

    socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: "projection",
      projection: { environment: { environmentId: environment.environmentId } },
    });
    socket.close();
  });

  it("rejects an invalid token before accepting commands", async () => {
    const server = await makeServer();
    const socket = new WebSocket(server.url());
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        token: "wrong-token",
        environmentId: environment.environmentId,
      }),
    );

    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: "error",
      error: { code: "unauthorized" },
    });
    socket.close();
  });

  it("dispatches commands through the durable engine and returns typed responses", async () => {
    const server = await makeServer();
    const socket = await connected(server);

    socket.send(
      JSON.stringify({
        type: "command",
        request: {
          protocolVersion: 1,
          commandId: "00000000-0000-4000-8000-000000000102",
          command: { type: "project.register", path: "C:/workspace/rpc" },
        },
      }),
    );

    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: "response",
      response: {
        commandId: "00000000-0000-4000-8000-000000000102",
        accepted: true,
      },
    });
    socket.close();
  });

  it("sends terminal keystrokes and resizes to the PTY without recording them as events", async () => {
    const database = new Database({ path: ":memory:" });
    const engine = new Engine({ database, environment });
    const writes: Array<[string, string]> = [];
    const resizes: Array<[string, number, number]> = [];
    const terminalService = {
      write: (terminalId: string, data: string) => writes.push([terminalId, data]),
      resize: (terminalId: string, cols: number, rows: number) => resizes.push([terminalId, cols, rows]),
    } as unknown as TerminalService;
    const server = new RpcServer({ engine, environment, token: "test-token", terminalService });
    await server.start();
    resources.push({ database, server });
    const socket = await connected(server);
    const terminalId = "00000000-0000-4000-8000-000000000150";

    socket.send(
      JSON.stringify({
        type: "command",
        request: {
          protocolVersion: 1,
          commandId: "00000000-0000-4000-8000-000000000151",
          command: { type: "terminal.write", terminalId, data: "hunter2\r" },
        },
      }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "response", response: { accepted: true } });
    socket.send(
      JSON.stringify({
        type: "command",
        request: {
          protocolVersion: 1,
          commandId: "00000000-0000-4000-8000-000000000152",
          command: { type: "terminal.resize", terminalId, cols: 90, rows: 20 },
        },
      }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "response", response: { accepted: true } });

    expect(writes).toEqual([[terminalId, "hunter2\r"]]);
    expect(resizes).toEqual([[terminalId, 90, 20]]);
    expect(await engine.eventsAfter(0)).toEqual([]);
    expect(JSON.stringify(database.raw.prepare("SELECT * FROM commands").all())).not.toContain("hunter2");
    socket.close();
  });

  it("attaches Codex, Claude Code, and Cursor discovery to projection snapshots", async () => {
    const database = new Database({ path: ":memory:" });
    const engine = new Engine({ database, environment });
    const server = new RpcServer({
      engine,
      environment,
      token: "test-token",
      discoverProviders: async () => [
        { provider: "codex", displayName: "Codex", status: "found", path: "/bin/codex", version: "codex 0.1.0" },
        {
          provider: "claude-code",
          displayName: "Claude Code",
          status: "missing",
          reason: "Claude Code CLI was not found on PATH or in known install locations.",
        },
        {
          provider: "cursor-agent",
          displayName: "Cursor",
          status: "missing",
          reason: "Cursor CLI was not found on PATH or in known install locations.",
        },
        {
          provider: "droid",
          displayName: "Droid",
          status: "found",
          path: "C:\\Users\\dev\\bin\\droid.exe",
        },
      ],
    });
    await server.start();
    resources.push({ database, server });
    const socket = await connected(server);

    socket.send(JSON.stringify({ type: "projection.get" }));
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: "projection",
      projection: {
        providers: [
          { provider: "codex", status: "found", path: "/bin/codex", version: "codex 0.1.0" },
          { provider: "claude-code", status: "missing" },
          { provider: "cursor-agent", status: "missing" },
          { provider: "droid", status: "found", path: "C:\\Users\\dev\\bin\\droid.exe" },
        ],
      },
    });
    socket.close();
  });

  it("reports every listed CLI missing when discovery fails", async () => {
    const database = new Database({ path: ":memory:" });
    const engine = new Engine({ database, environment });
    const server = new RpcServer({
      engine,
      environment,
      token: "test-token",
      discoverProviders: async () => {
        throw new Error("probe failed");
      },
    });
    await server.start();
    resources.push({ database, server });
    const socket = await connected(server);

    socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
    const message = await nextMessage(socket);
    expect(message).toMatchObject({ type: "projection" });
    const providers = (message.projection as { providers: Array<{ provider: string; status: string; reason: string }> })
      .providers;
    expect(providers.map((provider) => provider.provider)).toEqual(["codex", "claude-code", "cursor-agent", "droid"]);
    expect(
      providers.every((provider) => provider.status === "missing" && provider.reason === "Provider discovery failed."),
    ).toBe(true);
    expect(providers.map((provider) => provider.provider)).not.toContain("opencode");
    socket.close();
  });
});
