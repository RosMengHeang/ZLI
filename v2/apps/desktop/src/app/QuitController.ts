const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Chats a quit would cut off mid-turn: working, or waiting on the person inside a turn. */
export function busyAgentCount(projection: { threads: readonly { status: string }[] } | undefined): number {
  return projection?.threads.filter((thread) => thread.status === "working" || thread.status === "waiting").length ?? 0;
}

export function quitWarning(busyCount: number): string {
  return busyCount === 1
    ? "An agent is still working. Quitting ZLI stops it in the middle of its turn."
    : `${busyCount} agents are still working. Quitting ZLI stops them in the middle of their turns.`;
}

/**
 * Runs the app's quit: asks first when agents are mid-turn, then stops the runtime and the terminal
 * daemon before the app exits, so no ZLI process outlives it and an installer can replace its files.
 */
export class QuitController {
  private phase: "running" | "confirming" | "stopping" | "stopped" = "running";
  private confirmed = false;
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly options: {
      /** Starts the quit again once the shutdown has finished; Electron's app.quit. */
      quit(): void;
      busyAgents(): number;
      confirm(busyCount: number): Promise<boolean>;
      shutdown(): Promise<void>;
      log?: (message: string, error: unknown) => void;
      timeoutMs?: number;
    },
  ) {}

  /** True once the app is past asking and on its way out, when windows may close. */
  get exiting(): boolean {
    return this.phase === "stopping" || this.phase === "stopped";
  }

  /** Handles Electron's before-quit: holds the quit until the person agrees and the shutdown is done. */
  beforeQuit(event: { preventDefault(): void }): void {
    if (this.phase === "stopped") return;
    event.preventDefault();
    if (this.phase !== "running") return;
    const busyCount = this.confirmed ? 0 : this.options.busyAgents();
    if (busyCount === 0) {
      void this.stop().then(() => this.options.quit());
      return;
    }
    this.phase = "confirming";
    void this.options
      .confirm(busyCount)
      .catch(() => false)
      .then((agreed) => {
        if (this.phase !== "confirming") return;
        this.phase = "running";
        if (!agreed) return;
        this.confirmed = true;
        this.options.quit();
      });
  }

  /** Shuts down without asking, for a caller that already asked, such as Restart to update. */
  stop(): Promise<void> {
    this.confirmed = true;
    this.stopping ??= this.runShutdown();
    return this.stopping;
  }

  private async runShutdown(): Promise<void> {
    this.phase = "stopping";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.options.shutdown(),
        new Promise<void>((resolveTimeout) => {
          timer = setTimeout(resolveTimeout, this.options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      this.options.log?.("ZLI could not stop everything before quitting", error);
    } finally {
      clearTimeout(timer);
      this.phase = "stopped";
    }
  }
}
