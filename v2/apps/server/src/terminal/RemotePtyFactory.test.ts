import { TerminalId, WorktreeId } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { RemotePtyFactory } from "./RemotePtyFactory.js";

const terminalId = TerminalId.parse("00000000-0000-4000-8000-000000000501");
const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000502");

class FakeConnection {
  readonly requests: unknown[] = [];
  private readonly listeners = new Set<(message: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(
    private readonly existing = false,
    private readonly includePid = true,
    private readonly emitDuringAttach = false,
  ) {}

  async request(message: unknown): Promise<unknown> {
    this.requests.push(message);
    const request = message as { type: string };
    if (request.type === "terminal.create")
      return this.existing
        ? { type: "error", message: "Terminal already exists: shell" }
        : { type: "result", terminal: this.includePid ? { pid: 8080 } : { terminalId, status: "running" } };
    if (request.type === "terminal.attach") {
      if (this.emitDuringAttach) {
        this.emit({
          type: "terminal",
          message: {
            kind: "chunk",
            chunk: { terminalId, sequence: 2, bytesBase64: Buffer.from("during attach\n").toString("base64") },
          },
        });
      }
      return {
        type: "snapshot",
        snapshot: {
          terminalId,
          chunks: [{ terminalId, sequence: 1, bytesBase64: Buffer.from("before\n").toString("base64") }],
          nextSequence: 1,
          truncated: false,
        },
      };
    }
    return { type: "result", accepted: true };
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {}

  disconnect(): void {
    for (const listener of this.closeListeners) listener();
  }

  emit(message: unknown): void {
    for (const listener of this.listeners) listener(message);
  }
}

describe("RemotePtyFactory", () => {
  it("accepts a successful terminal projection when the daemon omits its internal PID", async () => {
    const connection = new FakeConnection(false, false);
    const factory = new RemotePtyFactory({ connect: async () => connection });

    const pty = await factory.spawn({
      terminalId,
      worktreeId,
      title: "shell",
      cwd: "C:\\workspace\\tree",
      shell: "powershell.exe",
      cols: 120,
      rows: 32,
    });

    expect(pty.pid).toBe(0);
  });

  it("adopts an existing daemon session and buffers output until the PTY listener is ready", async () => {
    const connection = new FakeConnection();
    const factory = new RemotePtyFactory({ connect: async () => connection });
    const pty = await factory.spawn({
      terminalId,
      worktreeId,
      title: "shell",
      cwd: "C:\\workspace\\tree",
      shell: "powershell.exe",
      cols: 120,
      rows: 32,
    });
    const data: string[] = [];
    const exits: Array<{ code: number; signal: number | null }> = [];
    pty.onData((value) => data.push(value));
    pty.onExit((event) => exits.push(event));
    connection.emit({
      type: "terminal",
      message: {
        kind: "chunk",
        chunk: { terminalId, sequence: 2, bytesBase64: Buffer.from("after\n").toString("base64") },
      },
    });
    await Promise.resolve();
    connection.emit({ type: "terminal", message: { kind: "exit", terminalId, code: 0, signal: null } });

    expect(data).toEqual(["before\n", "after\n"]);
    expect(exits).toEqual([{ code: 0, signal: null }]);
    expect(connection.requests).toEqual([
      expect.objectContaining({ type: "terminal.create", terminalId, worktreeId }),
      expect.objectContaining({ type: "terminal.attach", terminalId, afterSequence: 0 }),
    ]);
  });

  it("ignores writes, resizes, and stops that fail because the terminal already exited", async () => {
    const connection = new FakeConnection();
    const factory = new RemotePtyFactory({ connect: async () => connection });
    const pty = await factory.spawn({
      terminalId,
      worktreeId,
      title: "shell",
      cwd: "/work/tree",
      shell: "/bin/bash",
      cols: 120,
      rows: 32,
    });
    const closed = new Error("Terminal daemon connection closed.");
    connection.request = async () => {
      throw closed;
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      pty.write("ls\n");
      pty.resize(100, 30);
      pty.kill();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("preserves output emitted while the initial daemon snapshot is attaching", async () => {
    const connection = new FakeConnection(false, true, true);
    const factory = new RemotePtyFactory({ connect: async () => connection });
    const pty = await factory.spawn({
      terminalId,
      worktreeId,
      title: "shell",
      cwd: "C:\\workspace\\tree",
      shell: "powershell.exe",
      cols: 120,
      rows: 32,
    });
    const data: string[] = [];
    pty.onData((value) => data.push(value));

    expect(data).toEqual(["before\n", "during attach\n"]);
  });

  it("decodes a multi-byte character split across two chunks", async () => {
    const connection = new FakeConnection();
    const factory = new RemotePtyFactory({ connect: async () => connection });
    const pty = await factory.spawn({
      terminalId,
      worktreeId,
      title: "shell",
      cwd: "C:\\workspace\\tree",
      shell: "powershell.exe",
      cols: 120,
      rows: 32,
    });
    const data: string[] = [];
    pty.onData((value) => data.push(value));
    const bytes = Buffer.from("€", "utf8");
    connection.emit({
      type: "terminal",
      message: {
        kind: "chunk",
        chunk: { terminalId, sequence: 2, bytesBase64: bytes.subarray(0, 1).toString("base64") },
      },
    });
    connection.emit({
      type: "terminal",
      message: { kind: "chunk", chunk: { terminalId, sequence: 3, bytesBase64: bytes.subarray(1).toString("base64") } },
    });
    await Promise.resolve();

    expect(data.join("")).toBe("before\n€");
  });

  it("joins output parsed from one daemon read into a single data event", async () => {
    const connection = new FakeConnection();
    const factory = new RemotePtyFactory({ connect: async () => connection });
    const pty = await factory.spawn({
      terminalId,
      worktreeId,
      title: "shell",
      cwd: "/workspace/tree",
      shell: "/bin/sh",
      cols: 120,
      rows: 32,
    });
    const data: string[] = [];
    pty.onData((value) => data.push(value));
    for (let sequence = 2; sequence <= 40; sequence += 1) {
      connection.emit({
        type: "terminal",
        message: {
          kind: "chunk",
          chunk: { terminalId, sequence, bytesBase64: Buffer.from(`line ${sequence}\n`).toString("base64") },
        },
      });
    }

    expect(data).toEqual(["before\n"]);
    await Promise.resolve();
    expect(data).toHaveLength(2);
    expect(data[1]).toBe(Array.from({ length: 39 }, (_, index) => `line ${index + 2}\n`).join(""));
  });

  it("splits a large burst into bounded data events", async () => {
    const connection = new FakeConnection();
    const factory = new RemotePtyFactory({ connect: async () => connection });
    const pty = await factory.spawn({
      terminalId,
      worktreeId,
      title: "shell",
      cwd: "/workspace/tree",
      shell: "/bin/sh",
      cols: 120,
      rows: 32,
    });
    const data: string[] = [];
    pty.onData((value) => data.push(value));
    const line = `${"x".repeat(1023)}\n`;
    for (let sequence = 2; sequence <= 41; sequence += 1) {
      connection.emit({
        type: "terminal",
        message: { kind: "chunk", chunk: { terminalId, sequence, bytesBase64: Buffer.from(line).toString("base64") } },
      });
    }
    await Promise.resolve();

    expect(data.slice(1).map((value) => value.length)).toEqual([16 * 1024, 16 * 1024, 8 * 1024]);
    expect(data.slice(1).join("")).toBe(line.repeat(40));
  });

  it("delivers pending output before the exit", async () => {
    const connection = new FakeConnection();
    const factory = new RemotePtyFactory({ connect: async () => connection });
    const pty = await factory.spawn({
      terminalId,
      worktreeId,
      title: "shell",
      cwd: "/workspace/tree",
      shell: "/bin/sh",
      cols: 120,
      rows: 32,
    });
    const order: string[] = [];
    pty.onData((value) => order.push(value));
    pty.onExit((event) => order.push(`exit ${event.code}`));
    connection.emit({
      type: "terminal",
      message: {
        kind: "chunk",
        chunk: { terminalId, sequence: 2, bytesBase64: Buffer.from("bye\n").toString("base64") },
      },
    });
    connection.emit({ type: "terminal", message: { kind: "exit", terminalId, code: 3, signal: null } });

    expect(order).toEqual(["before\n", "bye\n", "exit 3"]);
  });

  it("attaches to a daemon-owned terminal after the environment server restarts", async () => {
    const connection = new FakeConnection(true);
    const factory = new RemotePtyFactory({ connect: async () => connection });

    const pty = await factory.spawn({
      terminalId,
      worktreeId,
      title: "shell",
      cwd: "C:\\workspace\\tree",
      shell: "powershell.exe",
      cols: 120,
      rows: 32,
    });

    expect(pty.pid).toBe(0);
    expect(connection.requests.map((request) => (request as { type: string }).type)).toEqual([
      "terminal.create",
      "terminal.attach",
    ]);
  });

  it("forwards agent launch arguments and environment hints to the daemon", async () => {
    const connection = new FakeConnection();
    const factory = new RemotePtyFactory({ connect: async () => connection });

    await factory.spawn({
      terminalId,
      worktreeId,
      title: "Codex",
      cwd: "C:\\workspace\\tree",
      shell: "C:\\Tools\\codex.exe",
      args: ["--dangerously-bypass-approvals-and-sandbox"],
      envOverrides: { TERM: "xterm-256color", COLORTERM: "truecolor" },
      env: { SECRET: "not forwarded" },
      cols: 120,
      rows: 32,
    });

    const create = connection.requests[0] as Record<string, unknown>;
    expect(create).toMatchObject({
      type: "terminal.create",
      shell: "C:\\Tools\\codex.exe",
      args: ["--dangerously-bypass-approvals-and-sandbox"],
      envOverrides: { TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    expect(create).not.toHaveProperty("env");
  });

  it("reports a terminal exit when its daemon connection is lost", async () => {
    const connection = new FakeConnection();
    const factory = new RemotePtyFactory({ connect: async () => connection });
    const pty = await factory.spawn({
      terminalId,
      worktreeId,
      title: "shell",
      cwd: "C:\\workspace\\tree",
      shell: "powershell.exe",
      cols: 120,
      rows: 32,
    });
    const exits: Array<{ code: number; signal: number | null }> = [];
    pty.onExit((event) => exits.push(event));

    connection.disconnect();

    expect(exits).toEqual([{ code: 1, signal: null }]);
  });
});
