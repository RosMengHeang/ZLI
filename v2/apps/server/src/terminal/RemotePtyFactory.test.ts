import { describe, expect, it } from "vitest";

import { TerminalId, WorktreeId } from "@zli-v2/contracts";

import { RemotePtyFactory } from "./RemotePtyFactory.js";

const terminalId = TerminalId.parse("00000000-0000-4000-8000-000000000501");
const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000502");

class FakeConnection {
  readonly requests: unknown[] = [];
  private readonly listeners = new Set<(message: unknown) => void>();

  async request(message: unknown): Promise<unknown> {
    this.requests.push(message);
    const request = message as { type: string };
    if (request.type === "terminal.create") return { type: "result", terminal: { pid: 8080 } };
    if (request.type === "terminal.attach") return { type: "snapshot", snapshot: { terminalId, chunks: [{ terminalId, sequence: 1, bytesBase64: Buffer.from("before\n").toString("base64") }], nextSequence: 1, truncated: false } };
    return { type: "result", accepted: true };
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {}

  emit(message: unknown): void {
    for (const listener of this.listeners) listener(message);
  }
}

describe("RemotePtyFactory", () => {
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
    connection.emit({ type: "terminal", message: { kind: "chunk", chunk: { terminalId, sequence: 2, bytesBase64: Buffer.from("after\n").toString("base64") } } });
    connection.emit({ type: "terminal", message: { kind: "exit", terminalId, code: 0, signal: null } });

    expect(data).toEqual(["before\n", "after\n"]);
    expect(exits).toEqual([{ code: 0, signal: null }]);
    expect(connection.requests).toEqual([
      expect.objectContaining({ type: "terminal.create", terminalId, worktreeId }),
      expect.objectContaining({ type: "terminal.attach", terminalId, afterSequence: 0 }),
    ]);
  });
});
