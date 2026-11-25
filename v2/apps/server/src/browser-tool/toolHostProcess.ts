import { type ChildProcess, spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";

import type { BrowserToolConfig, ToolHostEndpoint } from "./browserTool.js";

const START_TIMEOUT_MS = 15_000;
const MAX_RESTARTS = 5;

type Spawn = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;

/**
 * Runs the shared tool host (zli-tool-host.js) for this runtime and keeps it running. Until it answers, and
 * after it stops for good, endpoint() is undefined and agents get ZLI's servers as their own processes.
 */
export class ToolHostProcess {
  #endpoint: ToolHostEndpoint | undefined;
  #child: ChildProcess | undefined;
  #stopped = false;
  #restarts = 0;
  readonly #spawn: Spawn;

  constructor(
    private readonly config: Pick<BrowserToolConfig, "command" | "controlFile"> & { toolHostScript: string },
    private readonly endpointFile: string,
    options: { spawn?: Spawn; log?: (message: string, detail?: Record<string, unknown>) => void } = {},
  ) {
    this.#spawn =
      options.spawn ?? ((command, args, env) => spawn(command, [...args], { env, stdio: "ignore", windowsHide: true }));
    this.log = options.log ?? (() => undefined);
  }

  private readonly log: (message: string, detail?: Record<string, unknown>) => void;

  endpoint(): ToolHostEndpoint | undefined {
    return this.#endpoint;
  }

  async start(): Promise<void> {
    await rm(this.endpointFile, { force: true });
    const child = this.#spawn(
      this.config.command,
      [this.config.toolHostScript, "--endpoint-file", this.endpointFile, "--parent-pid", String(process.pid)],
      { ...process.env, ELECTRON_RUN_AS_NODE: "1", ZLI_BROWSER_CONTROL_FILE: this.config.controlFile },
    );
    this.#child = child;
    child.once("exit", (code) => {
      if (this.#child !== child) return;
      this.#endpoint = undefined;
      this.#child = undefined;
      if (this.#stopped) return;
      this.log("tool host exited", { code });
      if (this.#restarts >= MAX_RESTARTS) return;
      this.#restarts += 1;
      setTimeout(() => void this.start().catch(() => undefined), 1_000 * this.#restarts).unref();
    });
    child.once("error", () => undefined);
    const endpoint = await this.waitForEndpoint(child);
    if (endpoint) this.#endpoint = endpoint;
  }

  stop(): void {
    this.#stopped = true;
    this.#endpoint = undefined;
    this.#child?.kill();
    this.#child = undefined;
  }

  private async waitForEndpoint(child: ChildProcess): Promise<ToolHostEndpoint | undefined> {
    const until = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < until && this.#child === child && child.exitCode === null) {
      try {
        const parsed = JSON.parse(await readFile(this.endpointFile, "utf8")) as {
          pid?: unknown;
          port?: unknown;
          token?: unknown;
        };
        if (parsed.pid === child.pid && typeof parsed.port === "number" && typeof parsed.token === "string") {
          return { url: `http://127.0.0.1:${parsed.port}`, token: parsed.token };
        }
      } catch {
        // Not written yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.log("tool host did not start");
    return undefined;
  }
}
