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

  it("omits daemon credentials from the child environment when the parent has them", async () => {
    const previous = {
      token: process.env.ZLI_DAEMON_TOKEN,
      endpointPath: process.env.ZLI_DAEMON_ENDPOINT_PATH,
      version: process.env.ZLI_DAEMON_VERSION,
    };
    process.env.ZLI_DAEMON_TOKEN = "parent-token";
    process.env.ZLI_DAEMON_ENDPOINT_PATH = "/tmp/parent-endpoint.json";
    process.env.ZLI_DAEMON_VERSION = "zli-v2-daemon/1";
    const spawned: Array<{ env?: NodeJS.ProcessEnv }> = [];
    const factory = new NodePtyFactory({
      platform: "linux",
      load: async () => ({
        spawn: (_shell: string, _args: string[], options: Record<string, unknown>) => {
          spawned.push({ env: options.env as NodeJS.ProcessEnv | undefined });
          return {
            pid: 7,
            write: () => undefined,
            resize: () => undefined,
            kill: () => undefined,
            onData: () => ({ dispose: () => undefined }),
            onExit: () => ({ dispose: () => undefined }),
          };
        },
      }),
    });
    const explicitEnv: NodeJS.ProcessEnv = {
      ZLI_DAEMON_TOKEN: "explicit-token",
      ZLI_DAEMON_ENDPOINT_PATH: "/tmp/explicit-endpoint.json",
      ZLI_DAEMON_VERSION: "kept-version",
      TERM: "xterm-256color",
    };

    try {
      await factory.spawn({ cwd: "/workspace", shell: "bash", cols: 80, rows: 24 });
      expect(spawned[0]?.env?.ZLI_DAEMON_TOKEN).toBeUndefined();
      expect(spawned[0]?.env?.ZLI_DAEMON_ENDPOINT_PATH).toBeUndefined();
      expect(spawned[0]?.env?.ZLI_DAEMON_VERSION).toBe("zli-v2-daemon/1");
      expect(process.env.ZLI_DAEMON_TOKEN).toBe("parent-token");
      expect(process.env.ZLI_DAEMON_ENDPOINT_PATH).toBe("/tmp/parent-endpoint.json");

      await factory.spawn({ cwd: "/workspace", shell: "bash", cols: 80, rows: 24, env: explicitEnv });
      expect(spawned[1]?.env?.ZLI_DAEMON_TOKEN).toBeUndefined();
      expect(spawned[1]?.env?.ZLI_DAEMON_ENDPOINT_PATH).toBeUndefined();
      expect(spawned[1]?.env?.ZLI_DAEMON_VERSION).toBe("kept-version");
      expect(spawned[1]?.env?.TERM).toBe("xterm-256color");
      expect(explicitEnv.ZLI_DAEMON_TOKEN).toBe("explicit-token");
      expect(explicitEnv.ZLI_DAEMON_ENDPOINT_PATH).toBe("/tmp/explicit-endpoint.json");
    } finally {
      restoreEnv("ZLI_DAEMON_TOKEN", previous.token);
      restoreEnv("ZLI_DAEMON_ENDPOINT_PATH", previous.endpointPath);
      restoreEnv("ZLI_DAEMON_VERSION", previous.version);
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
