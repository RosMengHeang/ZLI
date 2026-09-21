import { spawn } from "node:child_process";

export type GitResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type GitRunOptions = {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type GitExecutor = (
  args: readonly string[],
  options: GitRunOptions,
) => Promise<GitResult>;

export class GitProcessError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly args: readonly string[],
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitProcessError";
  }
}

export class GitProcess {
  private readonly execute: GitExecutor;
  private readonly maxOutputBytes: number;

  constructor(options: { execute?: GitExecutor; maxOutputBytes?: number } = {}) {
    this.execute = options.execute ?? executeGit;
    this.maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  }

  async run(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
    if (!options.cwd || args.length === 0) {
      throw new Error("GitProcess requires a cwd and at least one argument.");
    }
    if (options.signal?.aborted) {
      throw abortError();
    }
    const result = await this.execute(args, options);
    const bounded = {
      ...result,
      stdout: limitOutput(result.stdout, this.maxOutputBytes),
      stderr: limitOutput(result.stderr, this.maxOutputBytes),
    };
    if (bounded.code !== 0) {
      throw new GitProcessError(
        `git ${args.join(" ")} exited with code ${bounded.code}.`,
        bounded.code,
        args,
        bounded.stdout,
        bounded.stderr,
      );
    }
    return bounded;
  }
}

async function executeGit(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      child.kill();
      finish(() => reject(abortError()));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        child.kill();
        finish(() => reject(new GitProcessError("git command timed out.", -1, args, stdout, stderr)));
      }, options.timeoutMs);
    }
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => resolve({ code: code ?? -1, stdout, stderr })));
  });
}

function limitOutput(value: string, maxBytes: number): string {
  return Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
}

function abortError(): Error {
  return new DOMException("Git command was cancelled.", "AbortError");
}
