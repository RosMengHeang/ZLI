import { randomUUID } from "node:crypto";
import { connect } from "node:net";

import { CommandId, type DevServerProjection, type RuntimeCommand, type TerminalId } from "@zli-v2/contracts";

import type { Engine } from "../orchestration/Engine.js";
import { DevServerLineScanner } from "./devServerDetector.js";

export type DevServerProbe = (url: string) => Promise<boolean>;

type TerminalOutputSource = {
  subscribeOutput(listener: (terminalId: TerminalId, data: string) => void): () => void;
  subscribeExit(listener: (terminalId: TerminalId) => void): () => void;
};

export type DevServerReactorOptions = {
  probe?: DevServerProbe;
  probeIntervalMs?: number;
  /** Failed checks in a row before a server counts as stopped. */
  maxMisses?: number;
};

/**
 * Records local servers that shell terminals announce, and forgets them once their port stops
 * answering. Agent terminals are skipped: agent CLIs print addresses while discussing code.
 */
export class DevServerReactor {
  private readonly scanner = new DevServerLineScanner();
  private readonly misses = new Map<string, number>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly unsubscribe: Array<() => void>;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly probe: DevServerProbe;
  private readonly maxMisses: number;
  private probing = false;

  constructor(
    private readonly engine: Engine,
    terminals: TerminalOutputSource,
    options: DevServerReactorOptions = {},
  ) {
    this.probe = options.probe ?? probePort;
    this.maxMisses = options.maxMisses ?? 3;
    this.unsubscribe = [
      terminals.subscribeOutput((terminalId, data) => {
        for (const url of this.scanner.push(terminalId, data)) this.track(this.record(terminalId, url));
      }),
      terminals.subscribeExit((terminalId) => this.scanner.forget(terminalId)),
    ];
    this.timer = setInterval(() => this.track(this.checkAll()), options.probeIntervalMs ?? 3_000);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }

  async waitForIdle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.all([...this.tasks]);
    await this.engine.projection();
  }

  /** Checks every recorded server once. The interval calls this; tests call it directly. */
  async checkAll(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      const devServers = (await this.engine.projection()).devServers ?? [];
      const known = new Set(devServers.map(missKey));
      for (const key of this.misses.keys()) if (!known.has(key)) this.misses.delete(key);
      await Promise.all(devServers.map((devServer) => this.check(devServer)));
    } finally {
      this.probing = false;
    }
  }

  private async check(devServer: DevServerProjection): Promise<void> {
    const key = missKey(devServer);
    if (await this.probe(devServer.url).catch(() => false)) {
      this.misses.delete(key);
      return;
    }
    const misses = (this.misses.get(key) ?? 0) + 1;
    if (misses < this.maxMisses) {
      this.misses.set(key, misses);
      return;
    }
    this.misses.delete(key);
    await this.dispatch({ type: "devserver.stopped", terminalId: devServer.terminalId, port: devServer.port });
  }

  private async record(terminalId: TerminalId, url: string): Promise<void> {
    const terminal = (await this.engine.projection()).terminals.find(
      (candidate) => candidate.terminalId === terminalId,
    );
    if (!terminal || terminal.kind === "agent") return;
    await this.dispatch({ type: "devserver.detected", terminalId, url });
  }

  private async dispatch(command: RuntimeCommand): Promise<void> {
    // A terminal can be deleted between its output and this command; that is not an error.
    await this.engine
      .dispatchPromise({ protocolVersion: 1, commandId: CommandId.parse(randomUUID()), command })
      .catch(() => undefined);
  }

  private track(task: Promise<void>): void {
    const tracked = task.catch(() => undefined);
    this.tasks.add(tracked);
    void tracked.then(() => this.tasks.delete(tracked));
  }
}

function missKey(devServer: Pick<DevServerProjection, "terminalId" | "port">): string {
  return `${devServer.terminalId}:${devServer.port}`;
}

/**
 * True when something accepts a TCP connection on the server's port. `localhost` is tried on both
 * loopback addresses because servers often bind only one of them.
 */
export async function probePort(url: string, timeoutMs = 1_000): Promise<boolean> {
  const parsed = new URL(url);
  const port = Number(parsed.port);
  const host = parsed.hostname.replace(/^\[|\]$/gu, "");
  const hosts = host === "localhost" ? ["127.0.0.1", "::1"] : [host];
  for (const candidate of hosts) if (await canConnect(candidate, port, timeoutMs)) return true;
  return false;
}

function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
