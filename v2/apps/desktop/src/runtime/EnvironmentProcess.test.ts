import { describe, expect, it } from "vitest";

import { EnvironmentProcess } from "./EnvironmentProcess.js";

describe("EnvironmentProcess", () => {
  it("waits for the authenticated server descriptor and ignores unrelated stdout", async () => {
    let output: ((chunk: string) => void) | undefined;
    let killed = false;
    const process = new EnvironmentProcess({
      serverEntryPath: "server.js",
      databasePath: "runtime.sqlite",
      launcher: () => ({
        stdout: {
          on: (_event: "data", listener: (chunk: string) => void) => {
            output = listener;
          },
        },
        stderr: { on: () => undefined },
        once: () => undefined,
        kill: () => {
          killed = true;
        },
      }),
      timeoutMs: 500,
    });
    const started = process.start();
    output?.("diagnostic\n");
    output?.('{"url":"ws://127.0.0.1:4321/rpc","token":"secret"}\n');
    await expect(started).resolves.toEqual({ url: "ws://127.0.0.1:4321/rpc", token: "secret" });
    process.stop();
    expect(killed).toBe(true);
  });

  it("recreates the environment after a server exit while keeping its runtime token", async () => {
    let output: ((chunk: string) => void) | undefined;
    let close: ((code?: number) => void) | undefined;
    let launches = 0;
    const process = new EnvironmentProcess({
      serverEntryPath: "server.js",
      databasePath: "runtime.sqlite",
      launcher: () => {
        launches += 1;
        return {
          stdout: {
            on: (_event: "data", listener: (chunk: string) => void) => {
              output = listener;
            },
          },
          stderr: { on: () => undefined },
          once: (event: "error" | "close", listener: (...args: unknown[]) => void) => {
            if (event === "close") close = listener as (code?: number) => void;
          },
          kill: () => undefined,
        };
      },
      timeoutMs: 500,
    });

    const first = process.start();
    output?.('{"url":"ws://127.0.0.1:4321/rpc","token":"secret"}\n');
    await expect(first).resolves.toEqual({ url: "ws://127.0.0.1:4321/rpc", token: "secret" });
    close?.(1);

    const second = process.start();
    output?.('{"url":"ws://127.0.0.1:4322/rpc","token":"secret"}\n');
    await expect(second).resolves.toEqual({ url: "ws://127.0.0.1:4322/rpc", token: "secret" });
    expect(launches).toBe(2);
    process.stop();
  });

  it("waits for the environment child to close during an awaited stop", async () => {
    let output: ((chunk: string) => void) | undefined;
    const closeListeners: Array<(...args: unknown[]) => void> = [];
    let killed = false;
    const process = new EnvironmentProcess({
      serverEntryPath: "server.js",
      databasePath: "runtime.sqlite",
      launcher: () => ({
        stdout: {
          on: (_event: "data", listener: (chunk: string) => void) => {
            output = listener;
          },
        },
        stderr: { on: () => undefined },
        once: (event: "error" | "close", listener: (...args: unknown[]) => void) => {
          if (event === "close") closeListeners.push(listener);
        },
        kill: () => {
          killed = true;
        },
      }),
    });
    const started = process.start();
    output?.('{"url":"ws://127.0.0.1:4321/rpc","token":"secret"}\n');
    await started;
    let stopped = false;

    const stopping = process.stopAndWait().then(() => {
      stopped = true;
    });
    await Promise.resolve();

    expect(killed).toBe(true);
    expect(stopped).toBe(false);
    for (const listener of closeListeners) listener(0);
    await stopping;
    expect(stopped).toBe(true);
  });

  it("ends the server's stdin to stop it, and kills it only if it does not exit in time", async () => {
    const launch = (options: { closesOnEnd: boolean }) => {
      let output: ((chunk: string) => void) | undefined;
      const closeListeners: Array<(...args: unknown[]) => void> = [];
      const events: string[] = [];
      const close = () => {
        for (const listener of closeListeners) listener(0);
      };
      const environment = new EnvironmentProcess({
        serverEntryPath: "server.js",
        databasePath: "runtime.sqlite",
        launcher: () => ({
          stdin: {
            end: () => {
              events.push("stdin-end");
              if (options.closesOnEnd) close();
            },
          },
          stdout: {
            on: (_event: "data", listener: (chunk: string) => void) => {
              output = listener;
            },
          },
          stderr: { on: () => undefined },
          once: (event: "error" | "close", listener: (...args: unknown[]) => void) => {
            if (event === "close") closeListeners.push(listener);
          },
          kill: () => {
            events.push("kill");
            close();
          },
        }),
      });
      return { environment, events, ready: () => output?.('{"url":"ws://127.0.0.1:4321/rpc","token":"secret"}\n') };
    };

    const graceful = launch({ closesOnEnd: true });
    const first = graceful.environment.start();
    graceful.ready();
    await first;
    await graceful.environment.shutdown(1_000);
    expect(graceful.events).toEqual(["stdin-end"]);

    const stuck = launch({ closesOnEnd: false });
    const second = stuck.environment.start();
    stuck.ready();
    await second;
    await stuck.environment.shutdown(20);
    expect(stuck.events).toEqual(["stdin-end", "kill"]);
  });
});
