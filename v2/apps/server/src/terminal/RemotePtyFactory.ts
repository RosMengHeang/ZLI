import {
  TerminalAttachSnapshot,
  TerminalId,
  TerminalStreamMessage,
} from "@zli-v2/contracts";

import type { DaemonConnection } from "../daemon/DaemonSupervisor.js";
import type { PtyFactory, PtyProcess, PtySpawnInput } from "./TerminalService.js";

type Connection = Pick<DaemonConnection, "request" | "onMessage" | "close">;

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
        shell: input.shell,
        cols: input.cols,
        rows: input.rows,
      });
      const pid = readPid(created);
      const attachment = await connection.request({
        type: "terminal.attach",
        terminalId: input.terminalId,
        afterSequence: 0,
      });
      const snapshot = readSnapshot(attachment, input.terminalId);
      const process = new RemotePtyProcess(connection, input.terminalId, pid);
      process.acceptSnapshot(snapshot);
      process.startListening();
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
  private exitEvent: { code: number; signal: number | null } | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly connection: Connection,
    private readonly terminalId: TerminalId,
    readonly pid: number,
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
    for (const chunk of snapshot.chunks) this.acceptData(Buffer.from(chunk.bytesBase64, "base64").toString("utf8"));
  }

  startListening(): void {
    this.unsubscribe = this.connection.onMessage((value) => {
      if (!value || typeof value !== "object") return;
      const message = value as { type?: unknown; message?: unknown };
      if (message.type !== "terminal") return;
      const parsed = TerminalStreamMessage.safeParse(message.message);
      if (!parsed.success) return;
      if (parsed.data.kind === "chunk") {
        if (parsed.data.chunk.terminalId !== this.terminalId) return;
        this.acceptData(Buffer.from(parsed.data.chunk.bytesBase64, "base64").toString("utf8"));
      } else if (parsed.data.kind === "exit") {
        if (parsed.data.terminalId !== this.terminalId) return;
        this.acceptExit({ code: parsed.data.code, signal: parsed.data.signal });
      }
    });
  }

  private acceptData(data: string): void {
    if (this.dataListeners.size === 0) this.bufferedData.push(data);
    else for (const listener of this.dataListeners) listener(data);
  }

  private acceptExit(event: { code: number; signal: number | null }): void {
    if (this.exitEvent) return;
    this.exitEvent = event;
    this.unsubscribe?.();
    for (const listener of this.exitListeners) listener(event);
    this.connection.close();
  }
}

function readPid(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const terminal = (value as { terminal?: { pid?: unknown } }).terminal;
  return typeof terminal?.pid === "number" ? terminal.pid : 0;
}

function readSnapshot(value: unknown, terminalId: TerminalId): TerminalAttachSnapshot {
  if (!value || typeof value !== "object") throw new Error("Daemon did not return a terminal snapshot.");
  return TerminalAttachSnapshot.parse({
    ...((value as { snapshot?: unknown }).snapshot as object),
    terminalId,
  });
}
