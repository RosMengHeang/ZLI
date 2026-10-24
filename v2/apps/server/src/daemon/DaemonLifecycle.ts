import type { TerminalService } from "../terminal/TerminalService.js";

export const DAEMON_IDLE_EXIT_MS = 60_000;
const STOP_TIMEOUT_MS = 3_000;
const STOP_POLL_MS = 50;

type Timers = {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
};

const globalTimers: Timers = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Decides when the detached terminal daemon exits: when the app asks it to on quit, or once no app
 * has been connected for a minute and none of its terminals are running. A daemon with live
 * terminals stays up, so an app that crashed can adopt them on its next launch.
 */
export class DaemonLifecycle {
  private clients = 0;
  private idleTimer: unknown;
  private exiting = false;
  private exited = false;
  private readonly timers: Timers;
  private readonly idleMs: number;
  private readonly stopTimeoutMs: number;

  constructor(
    private readonly options: {
      terminals: Pick<TerminalService, "list" | "stopAll" | "subscribeExit">;
      exit(): void;
      idleMs?: number;
      stopTimeoutMs?: number;
      timers?: Timers;
    },
  ) {
    this.timers = options.timers ?? globalTimers;
    this.idleMs = options.idleMs ?? DAEMON_IDLE_EXIT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    options.terminals.subscribeExit(() => this.checkIdle());
    this.checkIdle();
  }

  clientConnected(): void {
    this.clients += 1;
    this.checkIdle();
  }

  clientDisconnected(): void {
    this.clients = Math.max(0, this.clients - 1);
    this.checkIdle();
  }

  /** Stops every terminal and waits, up to a few seconds, for them to exit. */
  async stopTerminals(): Promise<void> {
    this.exiting = true;
    this.clearIdle();
    this.options.terminals.stopAll();
    const deadline = Date.now() + this.stopTimeoutMs;
    while (this.running() && Date.now() < deadline) {
      await new Promise<void>((resolve) => this.timers.setTimeout(resolve, STOP_POLL_MS));
    }
  }

  exit(): void {
    if (this.exited) return;
    this.exited = true;
    this.exiting = true;
    this.clearIdle();
    this.options.exit();
  }

  private running(): boolean {
    return this.options.terminals.list().some((terminal) => terminal.status === "running");
  }

  private checkIdle(): void {
    if (this.exiting) return;
    if (this.clients > 0 || this.running()) {
      this.clearIdle();
      return;
    }
    this.idleTimer ??= this.timers.setTimeout(() => {
      this.idleTimer = undefined;
      if (!this.exiting && this.clients === 0 && !this.running()) this.exit();
    }, this.idleMs);
  }

  private clearIdle(): void {
    if (this.idleTimer === undefined) return;
    this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
