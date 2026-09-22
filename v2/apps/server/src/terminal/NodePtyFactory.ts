import { createRequire } from "node:module";

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
  spawn(shell: string, args: string[], options: Record<string, unknown>): NodePtyProcess;
};

type NodePtyFactoryOptions = {
  load?: () => Promise<NodePtyModule>;
  platform?: NodeJS.Platform;
};

const requireForNodePty = createRequire(import.meta.url);

export class NodePtyFactory implements PtyFactory {
  private readonly load: () => Promise<NodePtyModule>;
  private readonly platform: NodeJS.Platform;

  constructor(options: NodePtyFactoryOptions = {}) {
    this.load = options.load ?? (() => Promise.resolve(requireForNodePty("node-pty") as NodePtyModule));
    this.platform = options.platform ?? process.platform;
  }

  async spawn(input: PtySpawnInput): Promise<PtyProcess> {
    const nodePty = await this.load();
    const env = { ...(input.env ?? process.env) };
    if (this.platform === "win32" && env.TERM === undefined) env.TERM = "xterm-256color";
    const ptyProcess = nodePty.spawn(input.shell, [], {
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
      kill: () => ptyProcess.kill(this.platform === "win32" ? undefined : "SIGTERM"),
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
}
