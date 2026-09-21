import { describe, expect, it } from "vitest";

import { NodePtyFactory } from "./NodePtyFactory.js";

describe("NodePtyFactory", () => {
  it("spawns node-pty with a bounded terminal shape and forwards lifecycle events", async () => {
    const dataListeners: Array<(data: string) => void> = [];
    const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
    const writes: string[] = [];
    const spawned: unknown[] = [];
    const factory = new NodePtyFactory({
      load: async () => ({
        spawn: (shell: string, args: string[], options: Record<string, unknown>) => {
          spawned.push({ shell, args, options });
          return {
            pid: 2024,
            write: (data: string) => writes.push(data),
            resize: () => undefined,
            kill: () => undefined,
            onData: (listener: (data: string) => void) => {
              dataListeners.push(listener);
              return { dispose: () => undefined };
            },
            onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
              exitListeners.push(listener);
              return { dispose: () => undefined };
            },
          };
        },
      }),
    });

    const process = await factory.spawn({
      cwd: "C:\\workspace\\tree",
      shell: "powershell.exe",
      cols: 120,
      rows: 32,
    });
    expect(spawned).toMatchObject([
      {
        shell: "powershell.exe",
        args: [],
        options: { cwd: "C:\\workspace\\tree", cols: 120, rows: 32, name: "xterm-256color" },
      },
    ]);
    process.write("echo ok");
    expect(writes).toEqual(["echo ok"]);
    process.onData(() => undefined);
    process.onExit(() => undefined);
    expect(dataListeners).toHaveLength(1);
    expect(exitListeners).toHaveLength(1);
  });
});
