import { createRequire } from "node:module";

import { planSpawn } from "@zli-v2/shared";

import { prependPath } from "../browser-tool/browserTool.js";
import type { PtyFactory, PtyProcess, PtySpawnInput } from "./TerminalService.js";

type NodePtyProcess = {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
};

type NodePtyModule = {
  /** On Windows a string is appended verbatim to the command line instead of being re-quoted. */
  spawn(shell: string, args: string[] | string, options: Record<string, unknown>): NodePtyProcess;
};

type NodePtyFactoryOptions = {
  load?: () => Promise<NodePtyModule>;
  platform?: NodeJS.Platform;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
};

const requireForNodePty = createRequire(import.meta.url);

function childPtyEnv(
  source: NodeJS.ProcessEnv | undefined,
  overrides: Record<string, string> | undefined,
  pathPrepend: string | undefined,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const inherited = { ...(source ?? process.env), ...overrides };
  const env = pathPrepend ? prependPath(inherited, pathPrepend, platform) : inherited;
  delete env.ZLI_DAEMON_TOKEN;
  delete env.ZLI_DAEMON_ENDPOINT_PATH;
  delete env.ZLI_RUNTIME_TOKEN;
  return env;
}

export class NodePtyFactory implements PtyFactory {
  private readonly load: () => Promise<NodePtyModule>;
  private readonly platform: NodeJS.Platform;
  private readonly signal: (pid: number, signal: NodeJS.Signals) => void;

  constructor(options: NodePtyFactoryOptions = {}) {
    this.load = options.load ?? (() => Promise.resolve(requireForNodePty("node-pty") as NodePtyModule));
    this.platform = options.platform ?? process.platform;
    this.signal = options.signal ?? ((pid, signal) => process.kill(pid, signal));
  }

  async spawn(input: PtySpawnInput): Promise<PtyProcess> {
    const nodePty = await this.load();
    const env = childPtyEnv(input.env, input.envOverrides, input.pathPrepend, this.platform);
    if (this.platform === "win32" && env.TERM === undefined) env.TERM = "xterm-256color";
    // npm and Cursor install .cmd/.ps1 shims on Windows; planSpawn routes them through cmd.exe or
    // PowerShell with cmd-safe quoting. Its cmd.exe line is pre-quoted, so node-pty must not quote it again.
    const plan = planSpawn(input.shell, input.args ?? [], this.platform, env);
    const args = plan.windowsVerbatimArguments ? plan.args.join(" ") : plan.args;
    const ptyProcess = nodePty.spawn(plan.command, args, {
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      env,
      name: "xterm-256color",
    });
    return {
      pid: ptyProcess.pid,
      write: (data) => ptyProcess.write(data),
      resize: (cols, rows) => ptyProcess.resize(cols, rows),
      kill: (force) => this.kill(ptyProcess, force === true),
      onData: (listener) => {
        const subscription = ptyProcess.onData(listener);
        return () => subscription.dispose();
      },
      onExit: (listener) => {
        const subscription = ptyProcess.onExit((event) =>
          listener({ code: event.exitCode, signal: event.signal ?? null }),
        );
        return () => subscription.dispose();
      },
    };
  }

  /**
   * On Windows node-pty ends the whole console process tree. Elsewhere the shell leads its own
   * process group, and an interactive shell ignores SIGTERM, so the group gets SIGHUP, as when a
   * terminal window closes: the shell exits and hangs up its jobs. SIGKILL is the fallback.
   */
  private kill(ptyProcess: NodePtyProcess, force: boolean): void {
    if (this.platform === "win32") {
      ptyProcess.kill();
      return;
    }
    const signal = force ? "SIGKILL" : "SIGHUP";
    try {
      this.signal(-ptyProcess.pid, signal);
    } catch {
      try {
        ptyProcess.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }
}
