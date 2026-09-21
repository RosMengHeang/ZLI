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
});
