import { spawn as spawnChild } from "node:child_process";

export type RunOptions = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string | Buffer;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Larger output is cut off and the process killed, so a runaway command cannot exhaust memory. */
  readonly maxOutputBytes?: number;
};

export type RunResult = {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly timedOut: boolean;
};

export type SpawnOptions = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
};

/** A process that keeps running, such as the emulator or the scrcpy server. */
export type RunningProcess = {
  readonly pid: number | undefined;
  onStdout(listener: (chunk: Buffer) => void): void;
  onStderr(listener: (chunk: Buffer) => void): void;
  write(data: string): void;
  endInput(): void;
  kill(): void;
  /** Resolves with the exit code once the process ends, or null when it was killed by a signal. */
  readonly exited: Promise<number | null>;
};

/** Everything the mobile drivers run goes through this, so tests can script every command. */
export type ProcessRunner = {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
  spawn(command: string, args: readonly string[], options?: SpawnOptions): RunningProcess;
};

const DEFAULT_MAX_OUTPUT = 64 * 1024 * 1024;

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly result: RunResult,
  ) {
    super(message);
    this.name = "ProcessError";
  }
}

/** Runs a command and throws with its stderr when it fails or times out. */
export async function runChecked(
  runner: ProcessRunner,
  command: string,
  args: readonly string[],
  options?: RunOptions,
): Promise<RunResult> {
  const result = await runner.run(command, args, options);
  if (result.timedOut) throw new ProcessError(`${commandName(command)} did not finish in time.`, result);
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.toString("utf8").trim()).slice(-1_500);
    throw new ProcessError(
      `${commandName(command)} ${args[0] ?? ""} failed${detail ? `: ${detail}` : ` with exit code ${result.code}`}`,
      result,
    );
  }
  return result;
}

export function commandName(command: string): string {
  return (command.split(/[\\/]/u).pop() ?? command).replace(/\.(exe|bat|cmd)$/iu, "");
}

/**
 * Windows runs .bat and .cmd files only through cmd.exe, which re-parses the whole line. Every argument is
 * quoted, and characters cmd.exe would still expand inside quotes are refused rather than escaped.
 */
export function windowsBatchInvocation(
  command: string,
  args: readonly string[],
): { command: string; args: string[]; verbatim: true } {
  for (const value of [command, ...args]) {
    if (/["%^&|<>\r\n!]/u.test(value)) throw new Error(`Cannot pass ${JSON.stringify(value)} to a Windows batch file.`);
  }
  const line = [command, ...args].map((value) => `"${value}"`).join(" ");
  return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

function resolveInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform,
): { command: string; args: string[]; verbatim: boolean } {
  if (platform === "win32" && /\.(bat|cmd)$/iu.test(command)) return windowsBatchInvocation(command, args);
  return { command, args: [...args], verbatim: false };
}

export function createNodeProcessRunner(platform: NodeJS.Platform = process.platform): ProcessRunner {
  return {
    run: (command, args, options = {}) =>
      new Promise((resolve, reject) => {
        const invocation = resolveInvocation(command, args, platform);
        const child = spawnChild(invocation.command, invocation.args, {
          cwd: options.cwd,
          env: options.env ?? process.env,
          windowsHide: true,
          windowsVerbatimArguments: invocation.verbatim,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let size = 0;
        let timedOut = false;
        let settled = false;
        const collect = (target: Buffer[]) => (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            child.kill();
            return;
          }
          target.push(chunk);
        };
        child.stdout.on("data", collect(stdout));
        child.stderr.on("data", collect(stderr));
        const timer =
          options.timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                child.kill();
              }, options.timeoutMs);
        const abort = () => child.kill();
        options.signal?.addEventListener("abort", abort, { once: true });
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          reject(error);
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          resolve({
            code,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr).toString("utf8"),
            timedOut,
          });
        });
        child.stdin.on("error", () => undefined);
        if (options.input !== undefined) child.stdin.end(options.input);
        else child.stdin.end();
      }),
    spawn: (command, args, options = {}) => {
      const invocation = resolveInvocation(command, args, platform);
      const child = spawnChild(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        windowsVerbatimArguments: invocation.verbatim,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.on("error", () => undefined);
      const exited = new Promise<number | null>((resolve) => {
        child.on("error", () => resolve(-1));
        child.on("close", (code) => resolve(code));
      });
      return {
        pid: child.pid,
        onStdout: (listener) => {
          child.stdout.on("data", listener);
        },
        onStderr: (listener) => {
          child.stderr.on("data", listener);
        },
        write: (data) => {
          if (!child.stdin.destroyed) child.stdin.write(data);
        },
        endInput: () => child.stdin.end(),
        kill: () => {
          if (child.exitCode === null && child.signalCode === null) child.kill();
        },
        exited,
      };
    },
  };
}
