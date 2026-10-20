import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CommandId, type EnvironmentDescriptor, EnvironmentId } from "@zli-v2/contracts";
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

  it("does not replay events the subscription snapshot already contains", async () => {
    const database = new Database({ path: ":memory:" });
    const engine = new Engine({ database, environment });
    const server = new RpcServer({ engine, environment, token: "test-token" });
    await server.start();
    resources.push({ database, server });
    for (const [index, path] of ["C:/workspace/a", "C:/workspace/b"].entries()) {
      await engine.dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(`00000000-0000-4000-8000-00000000017${index}`),
        command: { type: "project.register", path },
      });
    }
    const socket = await connected(server);

    socket.send(JSON.stringify({ type: "subscribe", afterSequence: 0 }));
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "projection", projection: { lastSequence: 2 } });
    socket.send(
      JSON.stringify({
        type: "command",
        request: {
          protocolVersion: 1,
          commandId: "00000000-0000-4000-8000-000000000172",
          command: { type: "project.register", path: "C:/workspace/c" },
        },
      }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "event", envelope: { sequence: 3 } });
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

  it("stores uploaded images on disk and records only their paths", async () => {
    const attachmentsDir = await mkdtemp(join(tmpdir(), "zli-rpc-attachments-"));
    try {
      const database = new Database({ path: ":memory:" });
      const engine = new Engine({ database, environment });
      const server = new RpcServer({ engine, environment, token: "test-token", attachmentsDir });
      await server.start();
      resources.push({ database, server });
      const threadId = "00000000-0000-4000-8000-000000000163";
      const project = await engine.dispatchPromise({
        protocolVersion: 1,
        commandId: "00000000-0000-4000-8000-000000000160",
        command: { type: "project.register", path: attachmentsDir },
      } as never);
      await engine.dispatchPromise({
        protocolVersion: 1,
        commandId: "00000000-0000-4000-8000-000000000161",
        command: {
          type: "worktree.import",
          worktreeId: "00000000-0000-4000-8000-000000000162",
          projectId: project.result?.projectId,
          path: attachmentsDir,
          branch: "main",
        },
      } as never);
      await engine.dispatchPromise({
        protocolVersion: 1,
        commandId: "00000000-0000-4000-8000-000000000164",
        command: {
          type: "thread.start",
          threadId,
          worktreeId: "00000000-0000-4000-8000-000000000162",
          provider: "codex",
          cwd: attachmentsDir,
        },
      } as never);
      const socket = await connected(server);
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const send = (commandId: string, attachment: Record<string, unknown>) =>
        socket.send(
          JSON.stringify({
            type: "command",
            request: {
              protocolVersion: 1,
              commandId,
              command: { type: "thread.send", threadId, text: "look", attachments: [attachment] },
            },
          }),
        );

      send("00000000-0000-4000-8000-000000000165", {
        name: "shot.png",
        mimeType: "image/png",
        dataBase64: png.toString("base64"),
      });
      await expect(nextMessage(socket)).resolves.toMatchObject({ type: "response", response: { accepted: true } });
      const sent = (await engine.eventsAfter(0)).find((entry) => entry.event.type === "thread.send.requested");
      const event = sent?.event as { attachments?: Array<{ name: string; path: string }> } | undefined;
      const attachments = event?.attachments ?? [];
      expect(attachments).toHaveLength(1);
      expect(attachments[0]?.path.startsWith(join(attachmentsDir, threadId))).toBe(true);
      expect(await readFile(attachments[0]?.path ?? "")).toEqual(png);
      expect(JSON.stringify(await engine.eventsAfter(0))).not.toContain(png.toString("base64"));

      send("00000000-0000-4000-8000-000000000166", {
        name: "fake.gif",
        mimeType: "image/gif",
        dataBase64: png.toString("base64"),
      });
      await expect(nextMessage(socket)).resolves.toMatchObject({
        type: "response",
        response: {
          commandId: "00000000-0000-4000-8000-000000000166",
          accepted: false,
          error: { code: "invalid_request", message: "Attachment fake.gif is not a image/gif image." },
        },
      });

      send("00000000-0000-4000-8000-000000000167", {
        name: "hosts",
        mimeType: "image/png",
        path: join(attachmentsDir, "..", "elsewhere.png"),
      });
      await expect(nextMessage(socket)).resolves.toMatchObject({
        type: "response",
        response: { accepted: false, error: { code: "invalid_request" } },
      });
      socket.close();
    } finally {
      await rm(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("serves worktree files directly without recording file commands as events", async () => {
    const root = await mkdtemp(join(tmpdir(), "zli-rpc-files-"));
    try {
      await writeFile(join(root, "notes.txt"), "secret draft\n");
      const database = new Database({ path: ":memory:" });
      const engine = new Engine({ database, environment });
      const server = new RpcServer({ engine, environment, token: "test-token" });
      await server.start();
      resources.push({ database, server });
      const worktreeId = "00000000-0000-4000-8000-000000000171";
      const project = await engine.dispatchPromise({
        protocolVersion: 1,
        commandId: "00000000-0000-4000-8000-000000000170",
        command: { type: "project.register", path: root },
      } as never);
      await engine.dispatchPromise({
        protocolVersion: 1,
        commandId: "00000000-0000-4000-8000-000000000172",
        command: {
          type: "worktree.import",
          worktreeId,
          projectId: project.result?.projectId,
          path: root,
          branch: "main",
        },
      } as never);
      const eventsBefore = await engine.eventsAfter(0);
      const socket = await connected(server);
      const command = (commandId: string, body: Record<string, unknown>) =>
        socket.send(JSON.stringify({ type: "command", request: { protocolVersion: 1, commandId, command: body } }));

      command("00000000-0000-4000-8000-000000000173", { type: "files.read", worktreeId, path: "notes.txt" });
      const read = await nextMessage(socket);
      expect(read).toMatchObject({
        type: "response",
        response: {
          commandId: "00000000-0000-4000-8000-000000000173",
          accepted: true,
          result: { path: "notes.txt", content: "secret draft\n", binary: false, lineEnding: "lf" },
        },
      });
      const version = (read.response as { result: { version: string } }).result.version;

      command("00000000-0000-4000-8000-000000000174", {
        type: "files.write",
        worktreeId,
        path: "notes.txt",
        content: "secret final\n",
        expectedVersion: version,
      });
      await expect(nextMessage(socket)).resolves.toMatchObject({
        response: { accepted: true, result: { status: "saved", path: "notes.txt" } },
      });
      expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("secret final\n");

      command("00000000-0000-4000-8000-000000000175", { type: "files.read", worktreeId, path: "missing.txt" });
      await expect(nextMessage(socket)).resolves.toMatchObject({
        response: {
          accepted: false,
          error: { code: "invalid_request", message: "File not found: missing.txt" },
        },
      });

      command("00000000-0000-4000-8000-000000000176", {
        type: "files.read",
        worktreeId: "00000000-0000-4000-8000-000000000179",
        path: "notes.txt",
      });
      await expect(nextMessage(socket)).resolves.toMatchObject({
        response: { accepted: false, error: { code: "invalid_request", message: "Worktree does not exist." } },
      });

      const direct = await engine.dispatchPromise({
        protocolVersion: 1,
        commandId: "00000000-0000-4000-8000-000000000177",
        command: { type: "files.read", worktreeId, path: "notes.txt" },
      } as never);
      expect(direct.status).toBe("rejected");

      expect(await engine.eventsAfter(0)).toEqual(eventsBefore);
      expect(JSON.stringify(database.raw.prepare("SELECT * FROM commands").all())).not.toContain("secret");
      socket.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an oversized frame before the hello handshake", async () => {
    const server = await makeServer();
    const socket = new WebSocket(server.url());
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send("x".repeat(128 * 1024));
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: "error",
      error: { code: "invalid_request", message: "RPC frame is too large." },
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
    expect(providers.map((provider) => provider.provider)).toEqual([
      "codex",
      "claude-code",
      "cursor-agent",
      "droid",
      "opencode",
      "gemini",
      "copilot",
      "kimi",
      "qwen",
      "goose",
    ]);
    expect(
      providers.every((provider) => provider.status === "missing" && provider.reason === "Provider discovery failed."),
    ).toBe(true);
    socket.close();
  });
});
