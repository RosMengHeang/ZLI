import { randomInt } from "node:crypto";
import { connect as netConnect } from "node:net";

import { type ProcessRunner, type RunningProcess, runChecked } from "../ProcessRunner.js";
import {
  SCRCPY_SERVER_DEVICE_PATH,
  ScrcpyVideoParser,
  scrcpyServerArgs,
  scrcpySocketName,
  type VideoEvent,
} from "./protocol.js";

/** The parts of a socket the session uses, so tests can stand in for the adb tunnel. */
export type ScrcpySocket = {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  write(data: Buffer): unknown;
  destroy(): unknown;
};

export type ScrcpySessionOptions = {
  readonly runner: ProcessRunner;
  readonly adb: string;
  readonly serial: string;
  readonly env: NodeJS.ProcessEnv;
  /** The verified scrcpy-server file on this computer. */
  readonly serverPath: string;
  readonly onVideo: (event: VideoEvent) => void;
  readonly onClose: (reason: string) => void;
  readonly connect?: (port: number) => ScrcpySocket;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly scid?: number;
  readonly connectTimeoutMs?: number;
};

/**
 * Mirrors one Android device the way the scrcpy client does: push the server, open an adb forward tunnel,
 * start the server, then connect the video socket and the control socket in that order.
 */
export class ScrcpySession {
  readonly #options: ScrcpySessionOptions;
  readonly #scid: number;
  #port: number | undefined;
  #server: RunningProcess | undefined;
  #video: ScrcpySocket | undefined;
  #control: ScrcpySocket | undefined;
  #closed = false;
  #serverOutput = "";

  private constructor(options: ScrcpySessionOptions) {
    this.#options = options;
    this.#scid = options.scid ?? randomInt(0, 0x7fff_ffff);
  }

  static async start(options: ScrcpySessionOptions): Promise<ScrcpySession> {
    const session = new ScrcpySession(options);
    try {
      await session.#start();
    } catch (cause) {
      await session.close("start failed");
      throw cause;
    }
    return session;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Sends one encoded control message. Returns false when the session has ended. */
  send(message: Buffer): boolean {
    if (this.#closed || !this.#control) return false;
    this.#control.write(message);
    return true;
  }

  async close(reason = "closed"): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#video?.destroy();
    this.#control?.destroy();
    this.#server?.kill();
    const { runner, adb, serial, env } = this.#options;
    if (this.#port !== undefined)
      await runner
        .run(adb, ["-s", serial, "forward", "--remove", `tcp:${this.#port}`], { env, timeoutMs: 10_000 })
        .catch(() => undefined);
    this.#options.onClose(reason);
  }

  async #start(): Promise<void> {
    const { runner, adb, serial, env } = this.#options;
    await runChecked(runner, adb, ["-s", serial, "push", this.#options.serverPath, SCRCPY_SERVER_DEVICE_PATH], {
      env,
      timeoutMs: 60_000,
    });
    const forward = await runChecked(
      runner,
      adb,
      ["-s", serial, "forward", "tcp:0", `localabstract:${scrcpySocketName(this.#scid)}`],
      { env, timeoutMs: 15_000 },
    );
    const port = Number(forward.stdout.toString("utf8").trim());
    if (!Number.isInteger(port) || port <= 0) throw new Error("adb did not open a port for the screen stream.");
    this.#port = port;
    const server = runner.spawn(adb, ["-s", serial, "shell", ...scrcpyServerArgs(this.#scid)], { env });
    this.#server = server;
    const keepOutput = (chunk: Buffer) => {
      this.#serverOutput = `${this.#serverOutput}${chunk.toString("utf8")}`.slice(-2_000);
    };
    server.onStdout(keepOutput);
    server.onStderr(keepOutput);
    void server.exited.then(() => {
      if (!this.#closed)
        void this.close(`The scrcpy server stopped: ${this.#serverOutput.trim().slice(-300) || "no reason given"}`);
    });

    const parser = new ScrcpyVideoParser();
    const video = await this.#connectWithFirstByte(port);
    this.#video = video.socket;
    const deliver = (chunk: Buffer) => {
      try {
        for (const event of parser.push(chunk)) this.#options.onVideo(event);
      } catch (cause) {
        void this.close(cause instanceof Error ? cause.message : String(cause));
      }
    };
    deliver(video.first);
    video.socket.on("data", deliver);
    video.socket.on("close", () => void this.close("The device closed the screen stream."));

    const control = (this.#options.connect ?? defaultConnect)(port);
    // The device sends clipboard and acknowledgement messages that ZLI does not use; reading them keeps the socket flowing.
    control.on("data", () => undefined);
    control.on("error", () => undefined);
    control.on("close", () => void this.close("The device closed the control channel."));
    this.#control = control;
  }

  /**
   * adb accepts a forward connection before the server listens, then drops it. The first byte proves the
   * server is on the other end, so the connection is retried until one arrives.
   */
  async #connectWithFirstByte(port: number): Promise<{ socket: ScrcpySocket; first: Buffer }> {
    const sleep =
      this.#options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const deadline = Date.now() + (this.#options.connectTimeoutMs ?? 10_000);
    let lastError = "the server did not answer";
    while (Date.now() < deadline && !this.#closed) {
      const socket = (this.#options.connect ?? defaultConnect)(port);
      const outcome = await new Promise<{ first: Buffer } | { error: string }>((resolve) => {
        socket.on("data", (chunk) => resolve({ first: chunk }));
        socket.on("close", () => resolve({ error: "the tunnel closed" }));
        socket.on("error", (error) => resolve({ error: error.message }));
      });
      if ("first" in outcome) return { socket, first: outcome.first };
      socket.destroy();
      lastError = outcome.error;
      await sleep(100);
    }
    throw new Error(
      `Could not connect to the scrcpy server: ${lastError}. ${this.#serverOutput.trim().slice(-300)}`.trim(),
    );
  }
}

function defaultConnect(port: number): ScrcpySocket {
  const socket = netConnect({ host: "127.0.0.1", port });
  socket.setNoDelay(true);
  return socket;
}
