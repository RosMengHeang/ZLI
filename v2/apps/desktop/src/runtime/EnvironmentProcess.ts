import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

type EnvironmentChild = {
  /** Ending it asks the server to stop its agents and exit. */
  stdin?: { end(): void } | null;
  stdout: { on(event: "data", listener: (chunk: string | Buffer) => void): void };
  stderr: { on(event: "data", listener: (chunk: string | Buffer) => void): void };
  once(event: "error" | "close", listener: (...args: unknown[]) => void): void;
  kill(): void;
};

type LaunchInput = {
  serverEntryPath: string;
  databasePath: string;
  token: string;
  extraEnv?: Readonly<Record<string, string>>;
};

type EnvironmentProcessOptions = {
  serverEntryPath: string;
  databasePath: string;
  timeoutMs?: number;
  /**
   * Added to the server's environment, which agent processes inherit. A function is called again for every server
   * it starts, so something the server uses up at start (the key handoff file) is made fresh for each one.
   */
  extraEnv?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>);
  /** Called when a server it started exits, for cleaning up what that server's start left behind. */
  onExit?: () => void;
  launcher?: (input: LaunchInput) => EnvironmentChild;
};

export type EnvironmentDescriptorLine = { url: string; token: string };

export class EnvironmentProcess {
  private child: EnvironmentChild | undefined;
  private startPromise: Promise<EnvironmentDescriptorLine> | undefined;
  private readonly token: string;

  constructor(private readonly options: EnvironmentProcessOptions) {
    this.token = randomBytes(32).toString("hex");
  }

  start(): Promise<EnvironmentDescriptorLine> {
    if (this.startPromise) return this.startPromise;
    // Prepared before the start is cached: a failure here (a key file that cannot be written) is returned once, and
    // the next start tries again instead of getting the same failure back.
    let extraEnv: Readonly<Record<string, string>> | undefined;
    try {
      const extra = this.options.extraEnv;
      extraEnv = typeof extra === "function" ? extra() : extra;
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("ZLI server failed to start."));
    }
    const starting = new Promise<EnvironmentDescriptorLine>((resolve, reject) => {
      let child: EnvironmentChild;
      try {
        child = (this.options.launcher ?? defaultLauncher)({
          serverEntryPath: this.options.serverEntryPath,
          databasePath: this.options.databasePath,
          token: this.token,
          ...(extraEnv ? { extraEnv } : {}),
        });
      } catch (error) {
        // No child to close, so nothing else clears the cached start: it is cleared once it is set, just below.
        queueMicrotask(() => {
          if (this.startPromise === starting) this.startPromise = undefined;
        });
        reject(error instanceof Error ? error : new Error("ZLI server failed to start."));
        return;
      }
      this.child = child;
      let buffer = "";
      let settled = false;
      const timer = setTimeout(
        () => finish(new Error("Timed out waiting for the ZLI environment server.")),
        this.options.timeoutMs ?? 10_000,
      );
      const finish = (error?: Error, descriptor?: EnvironmentDescriptorLine) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else if (descriptor) resolve(descriptor);
      };
      child.stdout.on("data", (chunk) => {
        buffer += Buffer.from(chunk).toString("utf8");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            try {
              const value = JSON.parse(line) as Partial<EnvironmentDescriptorLine>;
              if (typeof value.url === "string" && typeof value.token === "string" && value.token.length > 0) {
                finish(undefined, { url: value.url, token: value.token });
                return;
              }
            } catch {
              // Server diagnostics are allowed before the descriptor.
            }
          }
          newline = buffer.indexOf("\n");
        }
      });
      child.once("error", (...args) =>
        finish(args[0] instanceof Error ? args[0] : new Error("ZLI server failed to start.")),
      );
      child.once("close", (...args) => {
        this.options.onExit?.();
        if (this.child === child) {
          this.child = undefined;
          this.startPromise = undefined;
        }
        finish(new Error(`ZLI server exited before ready (${String(args[0] ?? "unknown")}).`));
      });
    });
    this.startPromise = starting;
    return starting;
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
    this.startPromise = undefined;
  }

  /**
   * Asks the server to stop its agents and exit, and kills it if it has not exited after `timeoutMs`.
   * A child without a stdin pipe is killed right away.
   */
  async shutdown(timeoutMs = 5_000): Promise<void> {
    const child = this.child;
    if (!child) return;
    const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
    this.child = undefined;
    this.startPromise = undefined;
    if (!child.stdin) {
      child.kill();
      await closed;
      return;
    }
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), timeoutMs);
    await closed;
    clearTimeout(timer);
  }

  async stopAndWait(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
    this.stop();
    await closed;
  }
}

function defaultLauncher(input: LaunchInput): EnvironmentChild {
  const runtimeNode = process.env.ZLI_TEST_PROVIDER === "mock" ? process.env.ZLI_RUNTIME_NODE : undefined;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...input.extraEnv,
    ZLI_DATABASE_PATH: input.databasePath,
    ZLI_RUNTIME_TOKEN: input.token,
    ZLI_RUNTIME_STOP_ON_STDIN_END: "1",
  };
  if (runtimeNode) delete environment.ELECTRON_RUN_AS_NODE;
  else environment.ELECTRON_RUN_AS_NODE = "1";
  return spawn(runtimeNode ?? process.execPath, [input.serverEntryPath], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
}
