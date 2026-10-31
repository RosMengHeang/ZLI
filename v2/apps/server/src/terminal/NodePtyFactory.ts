import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

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

type ProcessEntry = { pid: number; ppid: number; pgid: number };

type NodePtyFactoryOptions = {
  load?: () => Promise<NodePtyModule>;
  platform?: NodeJS.Platform;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Every process on the machine. Not used on Windows. */
  listProcesses?: () => Promise<ProcessEntry[]>;
};

const requireForNodePty = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

async function listProcesses(): Promise<ProcessEntry[]> {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid="], {
    timeout: 2_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split("\n").flatMap((line) => {
    const [pid = 0, ppid = 0, pgid = 0] = line.trim().split(/\s+/u).map(Number);
    return pid > 0 && Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)
      ? [{ pid, ppid, pgid }]
      : [];
  });
}

/** Every process below `rootPid`, parents before children. */
function descendants(processes: ProcessEntry[], rootPid: number): ProcessEntry[] {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of processes) {
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry);
    else children.set(entry.ppid, [entry]);
  }
  const found: ProcessEntry[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

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
  private readonly listProcesses: () => Promise<ProcessEntry[]>;

  constructor(options: NodePtyFactoryOptions = {}) {
    this.load = options.load ?? (() => Promise.resolve(requireForNodePty("node-pty") as NodePtyModule));
    this.platform = options.platform ?? process.platform;
    this.signal = options.signal ?? ((pid, signal) => process.kill(pid, signal));
    this.listProcesses = options.listProcesses ?? listProcesses;
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
    if (force) void this.killTree(ptyProcess);
    else this.signalShell(ptyProcess, "SIGHUP");
  }

  /**
   * Background jobs run in process groups of their own, and they keep a SIGHUP the shell ignored,
   * so killing only the shell's group would leave them running. They are found while they are still
   * the shell's children, because once the shell dies they are handed to init.
   */
  private async killTree(ptyProcess: NodePtyProcess): Promise<void> {
    const shellPid = ptyProcess.pid;
    let processes: ProcessEntry[] = [];
    try {
      processes = await this.listProcesses();
    } catch {
      // Without a process list the shell's own group is still killed.
    }
    // The shell's group is killed last, and the daemon's own group never.
    const groups = new Set<number>([shellPid, process.pid]);
    for (const entry of descendants(processes, shellPid)) {
      if (entry.pgid > 1 && !groups.has(entry.pgid)) {
        groups.add(entry.pgid);
        this.trySignal(-entry.pgid, "SIGKILL");
      }
      this.trySignal(entry.pid, "SIGKILL");
    }
    this.signalShell(ptyProcess, "SIGKILL");
  }

  private signalShell(ptyProcess: NodePtyProcess, signal: NodeJS.Signals): void {
    if (this.trySignal(-ptyProcess.pid, signal)) return;
    try {
      ptyProcess.kill(signal);
    } catch {
      // Already gone.
    }
  }

  private trySignal(pid: number, signal: NodeJS.Signals): boolean {
    try {
      this.signal(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}
