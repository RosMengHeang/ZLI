import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { EnvironmentId, type EnvironmentDescriptor } from "@zli-v2/contracts";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
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
});
