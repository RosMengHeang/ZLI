import { TerminalAttachSnapshot, type TerminalId, TerminalStreamMessage } from "@zli-v2/contracts";

import type { DaemonConnection } from "../daemon/DaemonSupervisor.js";
import type { PtyFactory, PtyProcess, PtySpawnInput } from "./TerminalService.js";

type Connection = Pick<DaemonConnection, "request" | "onMessage" | "onClose" | "close">;

/**
 * Upper bound for one joined output event. Terminal history is trimmed by whole chunks, so chunks
 * much larger than this would make reattach replays lose more scrollback than they keep.
 */
const MAX_JOINED_OUTPUT_CHARS = 16 * 1024;

type RemotePtyFactoryOptions = {
  connect(): Promise<Connection>;
};

export class RemotePtyFactory implements PtyFactory {
  constructor(private readonly supervisor: RemotePtyFactoryOptions) {}

  async spawn(input: PtySpawnInput): Promise<PtyProcess> {
    if (!input.terminalId || !input.worktreeId || !input.title) {
      throw new Error("Remote PTY creation requires terminal identity and title.");
    }
    const connection = await this.supervisor.connect();
    try {
      const created = await connection.request({
        type: "terminal.create",
        terminalId: input.terminalId,
        worktreeId: input.worktreeId,
        title: input.title,
        cwd: input.cwd,
        ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
        shell: input.shell,
        ...(input.args && input.args.length > 0 ? { args: input.args } : {}),
        ...(input.envOverrides ? { envOverrides: input.envOverrides } : {}),
        ...(input.pathPrepend ? { pathPrepend: input.pathPrepend } : {}),
        cols: input.cols,
        rows: input.rows,
      });
      const pid = readPid(created);
      const reused = isAlreadyExists(created);
      if (pid === 0 && !reused && !hasCreatedTerminal(created)) {
        throw new Error(readError(created) ?? "Terminal daemon did not create the PTY.");
      }
      const process = new RemotePtyProcess(connection, input.terminalId, pid, reused);
      process.startListening();
      const attachment = await connection.request({
        type: "terminal.attach",
        terminalId: input.terminalId,
        afterSequence: 0,
      });
      const snapshot = readSnapshot(attachment, input.terminalId);
      process.acceptSnapshot(snapshot);
      return process;
    } catch (error) {
      connection.close();
      throw error;
    }
  }
}

class RemotePtyProcess implements PtyProcess {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { code: number; signal: number | null }) => void>();
  private readonly bufferedData: string[] = [];
  private readonly pendingLiveMessages: TerminalStreamMessage[] = [];
  private readonly decoder = new TextDecoder("utf-8");
  private exitEvent: { code: number; signal: number | null } | undefined;
  private unsubscribe: (() => void) | undefined;
  private unsubscribeClose: (() => void) | undefined;
  private snapshotReady = false;
  private lastSequence = 0;
  private pendingData = "";
  private flushScheduled = false;

  constructor(
    private readonly connection: Connection,
    private readonly terminalId: TerminalId,
    readonly pid: number,
    readonly reused: boolean,
  ) {}

  write(data: string): void {
    void this.connection.request({ type: "terminal.write", terminalId: this.terminalId, data });
  }

  resize(cols: number, rows: number): void {
    void this.connection.request({ type: "terminal.resize", terminalId: this.terminalId, cols, rows });
  }

  kill(): void {
    void this.connection.request({ type: "terminal.stop", terminalId: this.terminalId });
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    for (const data of this.bufferedData.splice(0)) listener(data);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (event: { code: number; signal: number | null }) => void): () => void {
    this.exitListeners.add(listener);
    if (this.exitEvent) listener(this.exitEvent);
    return () => this.exitListeners.delete(listener);
  }

  acceptSnapshot(snapshot: TerminalAttachSnapshot): void {
    for (const chunk of snapshot.chunks) this.acceptBytes(chunk.bytesBase64);
    this.lastSequence = snapshot.nextSequence;
    this.snapshotReady = true;
    for (const message of this.pendingLiveMessages.splice(0)) this.acceptMessage(message);
  }

  startListening(): void {
    this.unsubscribe = this.connection.onMessage((value) => {
      if (!value || typeof value !== "object") return;
      const message = value as { type?: unknown; message?: unknown };
      if (message.type !== "terminal") return;
      const parsed = TerminalStreamMessage.safeParse(message.message);
      if (!parsed.success) return;
      if (!this.snapshotReady) this.pendingLiveMessages.push(parsed.data);
      else this.acceptMessage(parsed.data);
    });
    this.unsubscribeClose = this.connection.onClose(() => this.acceptExit({ code: 1, signal: null }));
  }

  private acceptMessage(message: TerminalStreamMessage): void {
    if (message.kind === "chunk") {
      if (message.chunk.terminalId !== this.terminalId || message.chunk.sequence <= this.lastSequence) return;
      this.lastSequence = message.chunk.sequence;
      this.acceptBytes(message.chunk.bytesBase64);
    } else if (message.kind === "exit") {
      if (message.terminalId !== this.terminalId) return;
      this.acceptExit({ code: message.code, signal: message.signal });
    }
  }

  // A multi-byte character can straddle two chunks, so decoding keeps state across them.
  private acceptBytes(bytesBase64: string): void {
    const data = this.decoder.decode(Buffer.from(bytesBase64, "base64"), { stream: true });
    if (data.length > 0) this.acceptData(data);
  }

  /**
   * One socket read from the daemon can carry hundreds of output lines that are parsed synchronously.
   * Delivered one by one, they become one stream frame each and overflow the bounded subscriber queues,
   * which then force clients to resync from a snapshot. Output from the same read is joined instead.
   */
  private acceptData(data: string): void {
    if (this.dataListeners.size === 0) {
      this.bufferedData.push(data);
      return;
    }
    this.pendingData += data;
    if (this.pendingData.length >= MAX_JOINED_OUTPUT_CHARS) {
      this.flushData();
      return;
    }
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.flushData();
    });
  }

  private flushData(): void {
    const data = this.pendingData;
    if (data.length === 0) return;
    this.pendingData = "";
    if (this.dataListeners.size === 0) this.bufferedData.push(data);
    else for (const listener of this.dataListeners) listener(data);
  }

  private acceptExit(event: { code: number; signal: number | null }): void {
    if (this.exitEvent) return;
    this.flushData();
    this.exitEvent = event;
    this.unsubscribe?.();
    this.unsubscribeClose?.();
    for (const listener of this.exitListeners) listener(event);
    this.connection.close();
  }
}

function readPid(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const terminal = (value as { terminal?: { pid?: unknown } }).terminal;
  return typeof terminal?.pid === "number" ? terminal.pid : 0;
}

function isAlreadyExists(value: unknown): boolean {
  return readError(value)?.toLowerCase().includes("already exists") ?? false;
}

function hasCreatedTerminal(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const terminal = (value as { terminal?: unknown }).terminal;
  return Boolean(terminal && typeof terminal === "object");
}

function readError(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

function readSnapshot(value: unknown, terminalId: TerminalId): TerminalAttachSnapshot {
  if (!value || typeof value !== "object") throw new Error("Daemon did not return a terminal snapshot.");
  return TerminalAttachSnapshot.parse({
    ...((value as { snapshot?: unknown }).snapshot as object),
    terminalId,
  });
}
