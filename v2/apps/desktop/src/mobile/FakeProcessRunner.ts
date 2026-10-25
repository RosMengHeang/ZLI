import type { ProcessRunner, RunningProcess, RunOptions, RunResult, SpawnOptions } from "./ProcessRunner.js";

export type FakeCall = { command: string; args: string[]; options: RunOptions | SpawnOptions | undefined };

export type FakeRunHandler = (
  command: string,
  args: readonly string[],
  options: RunOptions | undefined,
) => (Partial<Omit<RunResult, "stdout">> & { stdout?: string | Buffer }) | undefined;

/** A process the test drives by hand: it emits output and exits when told to. */
export class FakeProcess implements RunningProcess {
  readonly pid = 4242;
  readonly written: string[] = [];
  readonly #stdout: Array<(chunk: Buffer) => void> = [];
  readonly #stderr: Array<(chunk: Buffer) => void> = [];
  #resolve: (code: number | null) => void = () => undefined;
  readonly exited = new Promise<number | null>((resolve) => {
    this.#resolve = resolve;
  });
  killed = false;
  inputEnded = false;

  /** Called for each write to stdin, so a test can answer prompts. */
  onWrite: ((process: FakeProcess, data: string) => void) | undefined;

  constructor(
    readonly command: string,
    readonly args: readonly string[],
  ) {}

  onStdout(listener: (chunk: Buffer) => void): void {
    this.#stdout.push(listener);
  }

  onStderr(listener: (chunk: Buffer) => void): void {
    this.#stderr.push(listener);
  }

  write(data: string): void {
    this.written.push(data);
    this.onWrite?.(this, data);
  }

  endInput(): void {
    this.inputEnded = true;
  }

  kill(): void {
    this.killed = true;
    this.exit(null);
  }

  emit(output: string | Buffer, stream: "stdout" | "stderr" = "stdout"): void {
    const chunk = Buffer.isBuffer(output) ? output : Buffer.from(output);
    for (const listener of stream === "stdout" ? this.#stdout : this.#stderr) listener(chunk);
  }

  exit(code: number | null): void {
    this.#resolve(code);
  }
}

/** Records every command and answers from the handler; unanswered commands succeed with no output. */
export class FakeProcessRunner implements ProcessRunner {
  readonly calls: FakeCall[] = [];
  readonly spawned: FakeProcess[] = [];

  constructor(
    readonly handler: FakeRunHandler = () => undefined,
    readonly spawnHandler: (process: FakeProcess) => void = () => undefined,
  ) {}

  async run(command: string, args: readonly string[], options?: RunOptions): Promise<RunResult> {
    this.calls.push({ command, args: [...args], options });
    const answer = this.handler(command, args, options) ?? {};
    const stdout = answer.stdout ?? "";
    return {
      code: answer.code ?? 0,
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
      stderr: answer.stderr ?? "",
      timedOut: answer.timedOut ?? false,
    };
  }

  spawn(command: string, args: readonly string[], options?: SpawnOptions): RunningProcess {
    this.calls.push({ command, args: [...args], options });
    const process = new FakeProcess(command, args);
    this.spawned.push(process);
    this.spawnHandler(process);
    return process;
  }

  /** The argument lists of every call to a command whose name ends with `name`. */
  argsOf(name: string): string[][] {
    return this.calls.filter((call) => call.command.endsWith(name)).map((call) => call.args);
  }
}
