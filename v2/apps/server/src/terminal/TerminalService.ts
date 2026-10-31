import { TerminalChunk, type TerminalId, type TerminalProjection, type WorktreeId } from "@zli-v2/contracts";

import { resolveTerminalCwd, TerminalCwdError } from "./terminalCwd.js";

export type PtySpawnInput = {
  terminalId?: TerminalId;
  worktreeId?: WorktreeId;
  title?: string;
  cwd: string;
  worktreePath?: string;
  shell: string;
  /** Arguments for `shell`. Agent terminals use this to launch a CLI; plain shells get none. */
  args?: string[];
  /** Applied on top of the inherited environment after daemon secrets are removed. */
  envOverrides?: Record<string, string>;
  /** Directory placed first on the inherited PATH, whatever case the PATH key has. */
  pathPrepend?: string;
  cols: number;
  rows: number;
  env?: NodeJS.ProcessEnv;
};

export type PtyProcess = {
  readonly pid: number;
  readonly reused?: boolean;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Asks the process to end. `force` is set when an earlier request went unanswered. */
  kill(force?: boolean): void;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (event: { code: number; signal: number | null }) => void): () => void;
};

export type PtyFactory = {
  spawn(input: PtySpawnInput): Promise<PtyProcess>;
};

export type TerminalCreateRequest = {
  terminalId: TerminalId;
  worktreeId: WorktreeId;
  worktreePath: string;
  cwd: string;
  shell: string;
  args?: string[];
  envOverrides?: Record<string, string>;
  pathPrepend?: string;
  cols: number;
  rows: number;
  title: string;
  env?: NodeJS.ProcessEnv;
};

export type TerminalServiceOptions = {
  maxChunks?: number;
  maxBytes?: number;
  maxLines?: number;
  maxPendingChunks?: number;
  maxPendingBytes?: number;
  maxWriteBytes?: number;
  /** How long a stopped terminal gets to exit before it is killed outright. */
  stopGraceMs?: number;
};

export type TerminalStreamMessage =
  | { kind: "chunk"; chunk: TerminalChunk }
  | { kind: "snapshot_required"; terminalId: TerminalId; nextSequence: number }
  | { kind: "exit"; terminalId: TerminalId; code: number; signal: number | null };

export type TerminalAttachSnapshot = {
  terminalId: TerminalId;
  chunks: TerminalChunk[];
  nextSequence: number;
  truncated: boolean;
};

export type TerminalSubscription = {
  next(): Promise<TerminalStreamMessage | undefined>;
  close(): void;
};

export type TerminalAttachment = {
  snapshot: TerminalAttachSnapshot;
  subscription: TerminalSubscription;
};

type HistoryEntry = {
  chunk: TerminalChunk;
  bytes: number;
  lines: number;
};

type TerminalSession = {
  projection: TerminalProjection;
  pty: PtyProcess;
  reused: boolean;
  history: HistoryEntry[];
  historyBytes: number;
  historyLines: number;
  subscribers: Set<Subscriber>;
  stopRequested: boolean;
  forceTimer: ReturnType<typeof setTimeout> | undefined;
  releaseOnExit: boolean;
  exitDelivered: boolean;
};

class Subscriber {
  private readonly queue: TerminalStreamMessage[] = [];
  private readonly waiters: Array<(message: TerminalStreamMessage | undefined) => void> = [];
  private closed = false;
  private overflowed = false;
  private pendingBytes = 0;
  private queuedChunks = 0;

  constructor(
    private readonly terminalId: TerminalId,
    private readonly maxChunks: number,
    private readonly maxBytes: number,
    private readonly nextSequence: () => number,
  ) {}

  next(): Promise<TerminalStreamMessage | undefined> {
    const message = this.queue.shift();
    if (message) {
      if (message.kind === "chunk") {
        this.pendingBytes -= Buffer.byteLength(message.chunk.bytesBase64, "base64");
        this.queuedChunks -= 1;
      }
      return Promise.resolve(message);
    }
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  push(message: TerminalStreamMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    if (message.kind === "chunk") {
      const size = Buffer.byteLength(message.chunk.bytesBase64, "base64");
      if (this.overflowed || this.queuedChunks >= this.maxChunks || this.pendingBytes + size > this.maxBytes) {
        if (!this.overflowed) {
          this.overflowed = true;
          this.queue.push({
            kind: "snapshot_required",
            terminalId: this.terminalId,
            nextSequence: this.nextSequence(),
          });
        }
        return;
      }
      this.pendingBytes += size;
      this.queuedChunks += 1;
    }
    this.queue.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.pendingBytes = 0;
    this.queuedChunks = 0;
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }
}

export class TerminalError extends Error {
  constructor(
    readonly code:
      | "already_exists"
      | "not_found"
      | "invalid_size"
      | "input_too_large"
      | "spawn_failed"
      | "cwd_rejected",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TerminalError";
  }
}

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly exitListeners = new Set<
    (terminalId: TerminalId, event: { code: number; signal: number | null }) => void
  >();
  private readonly outputListeners = new Set<(terminalId: TerminalId, data: string) => void>();
  private readonly maxChunks: number;
  private readonly maxBytes: number;
  private readonly maxLines: number;
  private readonly maxPendingChunks: number;
  private readonly maxPendingBytes: number;
  private readonly maxWriteBytes: number;
  private readonly stopGraceMs: number;

  constructor(
    private readonly ptyFactory: PtyFactory,
    options: TerminalServiceOptions = {},
  ) {
    this.maxChunks = options.maxChunks ?? 5_000;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.maxLines = options.maxLines ?? 5_000;
    this.maxPendingChunks = options.maxPendingChunks ?? 8;
    this.maxPendingBytes = options.maxPendingBytes ?? 64 * 1024;
    this.maxWriteBytes = options.maxWriteBytes ?? 512 * 1024;
    this.stopGraceMs = options.stopGraceMs ?? 2_000;
  }

  async create(request: TerminalCreateRequest): Promise<TerminalProjection> {
    const key = request.terminalId as string;
    if (this.sessions.has(key)) {
      throw new TerminalError("already_exists", `Terminal already exists: ${request.terminalId}`);
    }
    validateSize(request.cols, request.rows);
    const cwd = cwdInsideWorktree(request.worktreePath, request.cwd);
    try {
      const pty = await this.ptyFactory.spawn({
        terminalId: request.terminalId,
        worktreeId: request.worktreeId,
        title: request.title,
        cwd,
        worktreePath: request.worktreePath,
        shell: request.shell,
        ...(request.args ? { args: request.args } : {}),
        ...(request.envOverrides ? { envOverrides: request.envOverrides } : {}),
        ...(request.pathPrepend ? { pathPrepend: request.pathPrepend } : {}),
        cols: request.cols,
        rows: request.rows,
        ...(request.env ? { env: request.env } : {}),
      });
      const session: TerminalSession = {
        projection: {
          terminalId: request.terminalId,
          worktreeId: request.worktreeId,
          title: request.title,
          status: "running",
          lastSequence: 0,
        },
        pty,
        reused: pty.reused === true,
        history: [],
        historyBytes: 0,
        historyLines: 0,
        subscribers: new Set(),
        stopRequested: false,
        forceTimer: undefined,
        releaseOnExit: false,
        exitDelivered: false,
      };
      this.sessions.set(key, session);
      pty.onData((data) => this.onData(session, data));
      pty.onExit((event) => this.onExit(session, event));
      return session.projection;
    } catch (error) {
      const reason = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
      throw new TerminalError("spawn_failed", `Unable to start terminal in ${cwd}. (${reason})`, {
        cause: error,
      });
    }
  }

  list(): TerminalProjection[] {
    return [...this.sessions.values()].map((session) => ({ ...session.projection }));
  }

  subscribeExit(
    listener: (terminalId: TerminalId, event: { code: number; signal: number | null }) => void,
  ): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Raw PTY output as it arrives, for watchers that read what a shell prints. */
  subscribeOutput(listener: (terminalId: TerminalId, data: string) => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  get(terminalId: TerminalId): TerminalProjection {
    return { ...this.session(terminalId).projection };
  }

  wasReused(terminalId: TerminalId): boolean {
    return this.session(terminalId).reused;
  }

  write(terminalId: TerminalId, data: string): void {
    if (Buffer.byteLength(data, "utf8") > this.maxWriteBytes) {
      throw new TerminalError("input_too_large", `Terminal input exceeds ${this.maxWriteBytes} bytes.`);
    }
    const session = this.session(terminalId);
    if (session.projection.status !== "running") return;
    session.pty.write(data);
  }

  resize(terminalId: TerminalId, cols: number, rows: number): void {
    validateSize(cols, rows);
    const session = this.session(terminalId);
    if (session.projection.status !== "running") return;
    session.pty.resize(cols, rows);
  }

  /**
   * Asks the terminal to end, and kills it if it is still running after a short grace period.
   * Stopping a terminal that is already stopping kills it at once.
   */
  stop(terminalId: TerminalId): void {
    this.requestStop(this.session(terminalId));
  }

  stopAll(): void {
    for (const session of this.sessions.values()) this.requestStop(session);
  }

  /**
   * Forgets a terminal and its output. A running terminal is stopped first and forgotten once it
   * exits, so its id can be used again.
   */
  release(terminalId: TerminalId): void {
    const session = this.sessions.get(terminalId as string);
    if (!session) return;
    if (session.projection.status === "running") {
      session.releaseOnExit = true;
      this.requestStop(session);
      return;
    }
    this.forget(session);
  }

  /** The newest output still in memory, decoded, up to about `maxBytes` characters. */
  recentOutput(terminalId: TerminalId, maxBytes: number): { data: string; truncated: boolean } {
    const session = this.session(terminalId);
    const oldest = session.history[0]?.chunk.sequence ?? session.projection.lastSequence + 1;
    const parts: string[] = [];
    let size = 0;
    for (let index = session.history.length - 1; index >= 0 && size < maxBytes; index -= 1) {
      const entry = session.history[index];
      if (!entry) continue;
      const text = Buffer.from(entry.chunk.bytesBase64, "base64").toString("utf8");
      parts.unshift(text);
      size += text.length;
    }
    const data = parts.join("");
    const cut = data.length > maxBytes;
    return {
      data: cut ? data.slice(-maxBytes) : data,
      truncated: cut || oldest > 1 || parts.length < session.history.length,
    };
  }

  attach(terminalId: TerminalId, afterSequence = 0): TerminalAttachment {
    const session = this.session(terminalId);
    const oldestSequence = session.history[0]?.chunk.sequence ?? session.projection.lastSequence + 1;
    const truncated = afterSequence < oldestSequence - 1;
    const chunks = session.history.filter((entry) => entry.chunk.sequence > afterSequence).map((entry) => entry.chunk);
    const subscriber = new Subscriber(
      terminalId,
      this.maxPendingChunks,
      this.maxPendingBytes,
      () => session.projection.lastSequence,
    );
    session.subscribers.add(subscriber);
    return {
      snapshot: {
        terminalId,
        chunks,
        nextSequence: session.projection.lastSequence,
        truncated,
      },
      subscription: {
        next: () => subscriber.next(),
        close: () => {
          subscriber.close();
          session.subscribers.delete(subscriber);
        },
      },
    };
  }

  private requestStop(session: TerminalSession): void {
    if (session.projection.status !== "running") return;
    if (session.stopRequested) {
      this.forceStop(session);
      return;
    }
    session.stopRequested = true;
    session.pty.kill();
    session.forceTimer = setTimeout(() => this.forceStop(session), this.stopGraceMs);
    session.forceTimer.unref?.();
  }

  private forceStop(session: TerminalSession): void {
    this.clearForceTimer(session);
    if (session.projection.status !== "running") return;
    session.pty.kill(true);
  }

  private clearForceTimer(session: TerminalSession): void {
    if (session.forceTimer === undefined) return;
    clearTimeout(session.forceTimer);
    session.forceTimer = undefined;
  }

  private forget(session: TerminalSession): void {
    this.clearForceTimer(session);
    const key = session.projection.terminalId as string;
    if (this.sessions.get(key) === session) this.sessions.delete(key);
  }

  private session(terminalId: TerminalId): TerminalSession {
    const session = this.sessions.get(terminalId as string);
    if (!session) throw new TerminalError("not_found", `Terminal does not exist: ${terminalId}`);
    return session;
  }

  private onData(session: TerminalSession, data: string): void {
    if (session.projection.status !== "running") return;
    const sequence = session.projection.lastSequence + 1;
    const bytes = trimUtf8Tail(Buffer.from(data, "utf8"), this.maxBytes);
    const chunk = TerminalChunk.parse({
      terminalId: session.projection.terminalId,
      sequence,
      bytesBase64: bytes.toString("base64"),
    });
    const entry = { chunk, bytes: bytes.length, lines: countLines(bytes) };
    session.projection = { ...session.projection, lastSequence: sequence };
    session.history.push(entry);
    session.historyBytes += entry.bytes;
    session.historyLines += entry.lines;
    while (
      session.history.length > this.maxChunks ||
      session.historyBytes > this.maxBytes ||
      session.historyLines > this.maxLines
    ) {
      const removed = session.history.shift();
      if (!removed) break;
      session.historyBytes -= removed.bytes;
      session.historyLines -= removed.lines;
    }
    for (const subscriber of session.subscribers) subscriber.push({ kind: "chunk", chunk });
    for (const listener of this.outputListeners) listener(session.projection.terminalId, data);
  }

  private onExit(session: TerminalSession, event: { code: number; signal: number | null }): void {
    if (session.exitDelivered) return;
    session.exitDelivered = true;
    this.clearForceTimer(session);
    session.projection = { ...session.projection, status: "exited" };
    const message: TerminalStreamMessage = {
      kind: "exit",
      terminalId: session.projection.terminalId,
      code: event.code,
      signal: event.signal,
    };
    for (const subscriber of session.subscribers) subscriber.push(message);
    for (const listener of this.exitListeners) listener(session.projection.terminalId, event);
    if (session.releaseOnExit) this.forget(session);
  }
}

function cwdInsideWorktree(worktreePath: string, cwd: string): string {
  try {
    return resolveTerminalCwd(worktreePath, cwd);
  } catch (error) {
    if (error instanceof TerminalCwdError) throw new TerminalError("cwd_rejected", error.message, { cause: error });
    throw error;
  }
}

function validateSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 10_000 || rows > 10_000) {
    throw new TerminalError("invalid_size", "Terminal dimensions must be integers between 1 and 10,000.");
  }
}

function countLines(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of bytes) if (byte === 10) lines += 1;
  return lines || 1;
}

function trimUtf8Tail(bytes: Buffer, maxBytes: number): Buffer {
  if (bytes.length <= maxBytes) return bytes;
  let candidate = bytes.subarray(bytes.length - maxBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (candidate.length > 0) {
    try {
      decoder.decode(candidate);
      return candidate;
    } catch {
      candidate = candidate.subarray(1);
    }
  }
  return Buffer.alloc(0);
}
