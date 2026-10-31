import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TerminalId, WorktreeId } from "@zli-v2/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodePtyFactory } from "./NodePtyFactory.js";
import {
  type PtyFactory,
  type PtyProcess,
  TerminalError,
  TerminalService,
  type TerminalStreamMessage,
} from "./TerminalService.js";

const terminalId = TerminalId.parse("00000000-0000-4000-8000-000000000101");
const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000201");

class FakePty implements PtyProcess {
  readonly pid = 4242;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  readonly kills: boolean[] = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { code: number; signal: number | null }) => void>();

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(force?: boolean): void {
    this.kills.push(force === true);
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
    worktreePath: "C:\\workspace\\tree",
    cwd: "C:\\workspace\\tree",
    shell: "powershell.exe",
    cols: 120,
    rows: 32,
    title: "shell",
  });
  return service;
}

async function nextMessage(subscription: {
  next(): Promise<TerminalStreamMessage | undefined>;
}): Promise<TerminalStreamMessage> {
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

  it("gives a subscriber room again once it reads queued chunks", async () => {
    const pty = new FakePty();
    const service = await createService(pty, { maxPendingChunks: 2, maxPendingBytes: 100 });
    const attached = service.attach(terminalId, 0);
    pty.emit("one");
    pty.emit("two");
    expect(await nextMessage(attached.subscription)).toMatchObject({ kind: "chunk", chunk: { sequence: 1 } });
    pty.emit("three");

    expect(await nextMessage(attached.subscription)).toMatchObject({ kind: "chunk", chunk: { sequence: 2 } });
    expect(await nextMessage(attached.subscription)).toMatchObject({ kind: "chunk", chunk: { sequence: 3 } });
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

  it("caps writes, validates resize, and kills a terminal stopped twice", async () => {
    const pty = new FakePty();
    const service = await createService(pty);
    service.write(terminalId, "dir\r\n");
    service.resize(terminalId, 140, 40);
    await expect(
      Promise.resolve().then(() => service.write(terminalId, "x".repeat(512 * 1024 + 1))),
    ).rejects.toMatchObject({
      code: "input_too_large",
    });
    expect(() => service.resize(terminalId, 0, 40)).toThrowError(TerminalError);
    service.stop(terminalId);
    service.stop(terminalId);
    expect(pty.writes).toEqual(["dir\r\n"]);
    expect(pty.resizes).toEqual([{ cols: 140, rows: 40 }]);
    expect(pty.kills).toEqual([false, true]);
    pty.exit(0, 1);
    service.stop(terminalId);
    expect(pty.kills).toEqual([false, true]);
  });

  it("kills a stopped terminal that is still running after the grace period", async () => {
    vi.useFakeTimers();
    try {
      const pty = new FakePty();
      const service = await createService(pty, { stopGraceMs: 1_000 });
      service.stop(terminalId);
      vi.advanceTimersByTime(999);
      expect(pty.kills).toEqual([false]);
      vi.advanceTimersByTime(1);
      expect(pty.kills).toEqual([false, true]);

      const quick = new FakePty();
      const quickService = await createService(quick, { stopGraceMs: 1_000 });
      quickService.stopAll();
      quick.exit(0, 1);
      vi.advanceTimersByTime(5_000);
      expect(quick.kills).toEqual([false]);
      expect(quickService.get(terminalId).status).toBe("exited");
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a released terminal once it has exited, so its id can be used again", async () => {
    const first = new FakePty();
    const second = new FakePty();
    const ptys = [first, second];
    const service = new TerminalService({
      spawn: async () => {
        const next = ptys.shift();
        if (!next) throw new Error("No more fake terminals.");
        return next;
      },
    });
    const request = {
      terminalId,
      worktreeId,
      worktreePath: "C:\\workspace\\tree",
      cwd: "C:\\workspace\\tree",
      shell: "powershell.exe",
      cols: 80,
      rows: 24,
      title: "shell",
    };
    const exits: string[] = [];
    service.subscribeExit((id) => exits.push(id));
    await service.create(request);
    await expect(service.create(request)).rejects.toMatchObject({ code: "already_exists" });

    service.release(terminalId);
    expect(first.kills).toEqual([false]);
    expect(service.get(terminalId).status).toBe("running");
    first.exit(0, 1);
    expect(exits).toEqual([terminalId]);
    expect(service.list()).toEqual([]);

    await service.create(request);
    expect(service.get(terminalId).status).toBe("running");
    second.exit(0, null);
    service.release(terminalId);
    expect(second.kills).toEqual([]);
    expect(service.list()).toEqual([]);
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
        worktreePath: "C:\\workspace\\tree",
        cwd: "C:\\workspace\\tree",
        shell: "powershell.exe",
        cols: 120,
        rows: 32,
        title: "shell",
      }),
    ).rejects.toMatchObject({
      code: "spawn_failed",
      message: "Unable to start terminal in C:\\workspace\\tree. (node-pty unavailable)",
    });
    expect(service.list()).toEqual([]);
  });

  it("spawns in a worktree subdirectory and rejects paths outside the worktree", async () => {
    const spawned: string[] = [];
    const service = new TerminalService({
      spawn: async (input) => {
        spawned.push(input.cwd);
        return new FakePty();
      },
    });
    const nestedId = TerminalId.parse("00000000-0000-4000-8000-000000000102");
    await service.create({
      terminalId: nestedId,
      worktreeId,
      worktreePath: "C:\\workspace\\tree",
      cwd: "src\\pkg",
      shell: "powershell.exe",
      cols: 80,
      rows: 24,
      title: "nested",
    });
    await expect(
      service.create({
        terminalId,
        worktreeId,
        worktreePath: "C:\\workspace\\tree",
        cwd: "C:\\Windows\\System32",
        shell: "powershell.exe",
        cols: 80,
        rows: 24,
        title: "escape",
      }),
    ).rejects.toMatchObject({ code: "cwd_rejected" });
    await expect(
      service.create({
        terminalId,
        worktreeId,
        worktreePath: "C:\\workspace\\tree",
        cwd: "..\\outside",
        shell: "powershell.exe",
        cols: 80,
        rows: 24,
        title: "escape",
      }),
    ).rejects.toMatchObject({ code: "cwd_rejected" });
    await expect(
      service.create({
        terminalId,
        worktreeId,
        worktreePath: "C:\\workspace\\tree",
        cwd: "C:\\workspace\\tree-evil",
        shell: "powershell.exe",
        cols: 80,
        rows: 24,
        title: "sibling",
      }),
    ).rejects.toMatchObject({ code: "cwd_rejected" });
    expect(spawned).toEqual(["C:\\workspace\\tree\\src\\pkg"]);
    expect(service.list().map((terminal) => terminal.terminalId)).toEqual([nestedId]);
  });
});

describe("TerminalService recent output", () => {
  it("returns the newest output and says when older output was left out", async () => {
    const pty = new FakePty();
    const service = await createService(pty);
    pty.emit("first line\r\n");
    pty.emit("second line\r\n");
    expect(service.recentOutput(terminalId, 1_000)).toEqual({
      data: "first line\r\nsecond line\r\n",
      truncated: false,
    });
    expect(service.recentOutput(terminalId, 8)).toEqual({ data: "d line\r\n", truncated: true });
  });
});

// node-pty's macOS spawn-helper is only made executable when the app is packaged, so outside the packaged app
// it fails with posix_spawnp. tests/e2e/terminal-stop.spec.ts covers macOS against the packaged app.
describe.skipIf(process.platform !== "linux")("TerminalService with a real shell", () => {
  const pids: number[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  async function startBash(service: TerminalService, id: TerminalId, setup: string) {
    const directory = await mkdtemp(join(tmpdir(), "zli-terminal-stop-"));
    directories.push(directory);
    let output = "";
    const unsubscribe = service.subscribeOutput((outputId, data) => {
      if (outputId === id) output += data;
    });
    const exited = new Promise<{ code: number; signal: number | null }>((resolve) => {
      service.subscribeExit((exitId, event) => {
        if (exitId === id) resolve(event);
      });
    });
    await service.create({
      terminalId: id,
      worktreeId,
      worktreePath: directory,
      cwd: directory,
      shell: "/bin/bash",
      args: ["--norc", "--noprofile", "-i"],
      env: { ...process.env, PS1: "$ " },
      cols: 120,
      rows: 24,
      title: "bash",
    });
    service.write(id, `${setup} echo "ready:$$:$!"\r`);
    await vi.waitFor(() => expect(output).toMatch(/ready:\d+:\d+/u), { timeout: 5_000 });
    unsubscribe();
    const [, shell, job] = /ready:(\d+):(\d+)/u.exec(output) ?? [];
    const shellPid = Number(shell);
    const jobPid = Number(job);
    pids.push(shellPid, jobPid);
    expect(await isAlive(shellPid)).toBe(true);
    expect(await isAlive(jobPid)).toBe(true);
    return { shellPid, jobPid, exited };
  }

  it("ends an interactive bash and the job it started, then lets the id be used again", async () => {
    const service = new TerminalService(new NodePtyFactory(), { stopGraceMs: 60_000 });
    const id = TerminalId.parse("00000000-0000-4000-8000-000000000301");
    const { shellPid, jobPid, exited } = await startBash(service, id, "sleep 300 &");

    service.stop(id);
    await expect(withTimeout(exited, 5_000)).resolves.toMatchObject({ signal: 1 });
    expect(service.get(id).status).toBe("exited");
    await vi.waitFor(async () => expect(await isAlive(shellPid)).toBe(false), { timeout: 3_000 });
    await vi.waitFor(async () => expect(await isAlive(jobPid)).toBe(false), { timeout: 3_000 });

    service.release(id);
    expect(service.list()).toEqual([]);
    const again = await startBash(service, id, "sleep 300 &");
    service.release(id);
    await withTimeout(again.exited, 5_000);
    expect(service.list()).toEqual([]);
  }, 20_000);

  it("kills a shell that ignores the hangup once the grace period ends", async () => {
    const service = new TerminalService(new NodePtyFactory(), { stopGraceMs: 300 });
    const id = TerminalId.parse("00000000-0000-4000-8000-000000000302");
    const { shellPid, jobPid, exited } = await startBash(service, id, "trap '' HUP TERM; sleep 300 &");

    service.stop(id);
    await expect(withTimeout(exited, 5_000)).resolves.toMatchObject({ signal: 9 });
    expect(service.get(id).status).toBe("exited");
    await vi.waitFor(async () => expect(await isAlive(shellPid)).toBe(false), { timeout: 3_000 });
    await vi.waitFor(async () => expect(await isAlive(jobPid)).toBe(false), { timeout: 3_000 });
  }, 20_000);

  it("kills a shell that ignores the hangup when it is stopped again", async () => {
    const service = new TerminalService(new NodePtyFactory(), { stopGraceMs: 60_000 });
    const id = TerminalId.parse("00000000-0000-4000-8000-000000000303");
    const { shellPid, jobPid, exited } = await startBash(service, id, "trap '' HUP TERM; sleep 300 &");

    service.stop(id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(service.get(id).status).toBe("running");
    service.stop(id);
    await expect(withTimeout(exited, 5_000)).resolves.toMatchObject({ signal: 9 });
    await vi.waitFor(async () => expect(await isAlive(shellPid)).toBe(false), { timeout: 3_000 });
    await vi.waitFor(async () => expect(await isAlive(jobPid)).toBe(false), { timeout: 3_000 });
  }, 20_000);
});

/** A zombie still answers signal 0, but it has stopped running. */
async function isAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms)),
  ]);
}
