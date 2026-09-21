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
        stdout: { on: (_event: "data", listener: (chunk: string) => void) => { output = listener; } },
        stderr: { on: () => undefined },
        once: () => undefined,
        kill: () => { killed = true; },
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
          stdout: { on: (_event: "data", listener: (chunk: string) => void) => { output = listener; } },
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
});
