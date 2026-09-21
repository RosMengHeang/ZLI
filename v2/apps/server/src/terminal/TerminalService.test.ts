import { describe, expect, it } from "vitest";

import { TerminalId, WorktreeId } from "@zli-v2/contracts";

import {
  TerminalError,
  TerminalService,
  type PtyFactory,
  type PtyProcess,
  type TerminalStreamMessage,
} from "./TerminalService.js";

const terminalId = TerminalId.parse("00000000-0000-4000-8000-000000000101");
const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000201");

class FakePty implements PtyProcess {
  readonly pid = 4242;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killed = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { code: number; signal: number | null }) => void>();

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killed += 1;
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (event: { code: number; signal: number | null }) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  emit(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  exit(code = 0, signal: number | null = null): void {
    for (const listener of this.exitListeners) listener({ code, signal });
  }
}

function fakeFactory(pty: FakePty): PtyFactory {
  return { spawn: async () => pty };
}

async function createService(
  pty: FakePty,
  options: ConstructorParameters<typeof TerminalService>[1] = {},
): Promise<TerminalService> {
  const service = new TerminalService(fakeFactory(pty), options);
  await service.create({
    terminalId,
    worktreeId,
    cwd: "C:\\workspace\\tree",
    shell: "powershell.exe",
    cols: 120,
    rows: 32,
    title: "shell",
  });
  return service;
}

async function nextMessage(
  subscription: { next(): Promise<TerminalStreamMessage | undefined> },
): Promise<TerminalStreamMessage> {
  const message = await subscription.next();
  if (!message) throw new Error("Expected a terminal message.");
  return message;
}

describe("TerminalService", () => {
  it("retains output before attach and replays it by sequence cursor", async () => {
    const pty = new FakePty();
    const service = await createService(pty);
    pty.emit("first\n");
    pty.emit("second\n");

    const attached = service.attach(terminalId, 1);
    expect(attached.snapshot.truncated).toBe(false);
    expect(attached.snapshot.chunks.map((chunk) => chunk.bytesBase64)).toEqual([
      Buffer.from("second\n").toString("base64"),
    ]);
    attached.subscription.close();
  });

  it("reports truncation when the cursor predates the bounded history", async () => {
    const pty = new FakePty();
    const service = await createService(pty, { maxChunks: 2, maxBytes: 1024 });
    pty.emit("one");
    pty.emit("two");
    pty.emit("three");

    const attached = service.attach(terminalId, 0);
    expect(attached.snapshot.truncated).toBe(true);
    expect(attached.snapshot.chunks.map((chunk) => chunk.sequence)).toEqual([2, 3]);
    attached.subscription.close();
  });

  it("retains no more than the configured 5,000-line tail", async () => {
    const pty = new FakePty();
    const service = await createService(pty);
    for (let index = 0; index < 5_100; index += 1) pty.emit(`line-${index}\n`);

    const attached = service.attach(terminalId, 0);
    expect(attached.snapshot.truncated).toBe(true);
    expect(attached.snapshot.chunks).toHaveLength(5_000);
    expect(attached.snapshot.chunks[0]?.sequence).toBe(101);
    attached.subscription.close();
  });

  it("keeps retention bounded by bytes and preserves UTF-8 boundaries", async () => {
    const pty = new FakePty();
    const service = await createService(pty, { maxChunks: 20, maxBytes: 8 });
    pty.emit("🙂🙂🙂");

    const attached = service.attach(terminalId, 0);
    const bytes = Buffer.from(attached.snapshot.chunks[0]?.bytesBase64 ?? "", "base64");
    expect(bytes.toString("utf8")).not.toContain("�");
    expect(bytes.length).toBeLessThanOrEqual(8);
    attached.subscription.close();
  });

  it("turns a slow subscriber into a snapshot-required recovery instead of unbounded growth", async () => {
    const pty = new FakePty();
    const service = await createService(pty, { maxPendingChunks: 2, maxPendingBytes: 100 });
    const attached = service.attach(terminalId, 0);
    pty.emit("one");
    pty.emit("two");
    pty.emit("three");

    expect(await nextMessage(attached.subscription)).toMatchObject({ kind: "chunk" });
    expect(await nextMessage(attached.subscription)).toMatchObject({ kind: "chunk" });
    expect(await nextMessage(attached.subscription)).toMatchObject({
      kind: "snapshot_required",
      terminalId,
    });
    attached.subscription.close();
  });

  it("supports multiple subscribers and delivers exit exactly once", async () => {
    const pty = new FakePty();
    const service = await createService(pty);
    const first = service.attach(terminalId, 0);
    const second = service.attach(terminalId, 0);
    pty.emit("hello");
    pty.exit(7, null);

    await expect(nextMessage(first.subscription)).resolves.toMatchObject({ kind: "chunk" });
    await expect(nextMessage(second.subscription)).resolves.toMatchObject({ kind: "chunk" });
    await expect(nextMessage(first.subscription)).resolves.toMatchObject({
      kind: "exit",
      code: 7,
    });
    await expect(nextMessage(second.subscription)).resolves.toMatchObject({
      kind: "exit",
      code: 7,
    });
    first.subscription.close();
    second.subscription.close();
  });

  it("caps writes, validates resize, and makes stop idempotent", async () => {
    const pty = new FakePty();
    const service = await createService(pty);
    service.write(terminalId, "dir\r\n");
    service.resize(terminalId, 140, 40);
    await expect(Promise.resolve().then(() => service.write(terminalId, "x".repeat(512 * 1024 + 1)))).rejects.toMatchObject({
      code: "input_too_large",
    });
    expect(() => service.resize(terminalId, 0, 40)).toThrowError(TerminalError);
    service.stop(terminalId);
    service.stop(terminalId);
    expect(pty.writes).toEqual(["dir\r\n"]);
    expect(pty.resizes).toEqual([{ cols: 140, rows: 40 }]);
    expect(pty.killed).toBe(1);
  });

  it("surfaces PTY spawn failures without leaving a phantom session", async () => {
    const service = new TerminalService({
      spawn: async () => {
        throw new Error("node-pty unavailable");
      },
    });

    await expect(
      service.create({
        terminalId,
        worktreeId,
        cwd: "C:\\workspace\\tree",
        shell: "powershell.exe",
        cols: 120,
        rows: 32,
        title: "shell",
      }),
    ).rejects.toMatchObject({ code: "spawn_failed" });
    expect(service.list()).toEqual([]);
  });
});
