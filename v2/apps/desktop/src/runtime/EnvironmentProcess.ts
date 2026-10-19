import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

type EnvironmentChild = {
  stdout: { on(event: "data", listener: (chunk: string | Buffer) => void): void };
  stderr: { on(event: "data", listener: (chunk: string | Buffer) => void): void };
  once(event: "error" | "close", listener: (...args: unknown[]) => void): void;
  kill(): void;
};

type EnvironmentProcessOptions = {
  serverEntryPath: string;
  databasePath: string;
  timeoutMs?: number;
  launcher?: (input: { serverEntryPath: string; databasePath: string; token: string }) => EnvironmentChild;
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
    this.startPromise = new Promise<EnvironmentDescriptorLine>((resolve, reject) => {
      const child = (this.options.launcher ?? defaultLauncher)({
        serverEntryPath: this.options.serverEntryPath,
        databasePath: this.options.databasePath,
        token: this.token,
      });
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
        if (this.child === child) {
          this.child = undefined;
          this.startPromise = undefined;
        }
        finish(new Error(`ZLI server exited before ready (${String(args[0] ?? "unknown")}).`));
      });
    });
    return this.startPromise;
  }

  stop(): void {
    this.child?.kill();
    this.child = undefined;
    this.startPromise = undefined;
  }

  async stopAndWait(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const closed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
    this.stop();
    await closed;
  }
}

function defaultLauncher(input: { serverEntryPath: string; databasePath: string; token: string }): EnvironmentChild {
  const runtimeNode = process.env.ZLI_TEST_PROVIDER === "mock" ? process.env.ZLI_RUNTIME_NODE : undefined;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ZLI_DATABASE_PATH: input.databasePath,
    ZLI_RUNTIME_TOKEN: input.token,
  };
  if (runtimeNode) delete environment.ELECTRON_RUN_AS_NODE;
  else environment.ELECTRON_RUN_AS_NODE = "1";
  return spawn(runtimeNode ?? process.execPath, [input.serverEntryPath], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
}
