import { describe, expect, it } from "vitest";

import { TerminalId, WorktreeId } from "@zli-v2/contracts";

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
  ) {}

  async request(message: unknown): Promise<unknown> {
    this.requests.push(message);
    const request = message as { type: string };
    if (request.type === "terminal.create")
      return this.existing
        ? { type: "error", message: "Terminal already exists: shell" }
        : { type: "result", terminal: this.includePid ? { pid: 8080 } : { terminalId, status: "running" } };
    if (request.type === "terminal.attach")
      return {
        type: "snapshot",
        snapshot: {
          terminalId,
          chunks: [{ terminalId, sequence: 1, bytesBase64: Buffer.from("before\n").toString("base64") }],
          nextSequence: 1,
          truncated: false,
        },
      };
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
    connection.emit({ type: "terminal", message: { kind: "exit", terminalId, code: 0, signal: null } });

    expect(data).toEqual(["before\n", "after\n"]);
    expect(exits).toEqual([{ code: 0, signal: null }]);
    expect(connection.requests).toEqual([
      expect.objectContaining({ type: "terminal.create", terminalId, worktreeId }),
      expect.objectContaining({ type: "terminal.attach", terminalId, afterSequence: 0 }),
    ]);
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
