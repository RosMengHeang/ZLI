import { describe, expect, it, vi } from "vitest";

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

  it("routes a Windows .cmd agent shim through cmd.exe with a verbatim command line", async () => {
    const spawned: Array<{ shell: string; args: string[] | string; env: NodeJS.ProcessEnv }> = [];
    const factory = new NodePtyFactory({ platform: "win32", load: async () => recordingModule(spawned) });

    await factory.spawn({
      cwd: "C:\\workspace\\tree",
      shell: "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd",
      args: ["--dangerously-skip-permissions", "--model", "claude-sonnet-4-5"],
      envOverrides: { TERM: "xterm-256color", COLORTERM: "truecolor" },
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe", ZLI_DAEMON_TOKEN: "secret" },
      cols: 120,
      rows: 32,
    });

    expect(spawned[0]?.shell).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(spawned[0]?.args).toBe(
      '/d /s /c "^"C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd^" ^"--dangerously-skip-permissions^" ^"--model^" ^"claude-sonnet-4-5^""',
    );
    expect(spawned[0]?.env).toMatchObject({ TERM: "xterm-256color", COLORTERM: "truecolor" });
    expect(spawned[0]?.env.ZLI_DAEMON_TOKEN).toBeUndefined();
  });

  it("puts the browser shim first on PATH under the key Windows already uses", async () => {
    const spawned: Array<{ shell: string; args: string[] | string; env: NodeJS.ProcessEnv }> = [];
    const factory = new NodePtyFactory({ platform: "win32", load: async () => recordingModule(spawned) });

    await factory.spawn({
      cwd: "C:\\workspace\\tree",
      shell: "powershell.exe",
      envOverrides: { ZLI_WORKTREE_ID: "wt-1" },
      pathPrepend: "C:\\ZLI\\bin",
      env: { Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
      cols: 120,
      rows: 32,
    });

    expect(spawned[0]?.env).toMatchObject({
      Path: "C:\\ZLI\\bin;C:\\Windows\\System32",
      ZLI_WORKTREE_ID: "wt-1",
      SystemRoot: "C:\\Windows",
    });
    expect(spawned[0]?.env.PATH).toBeUndefined();
  });

  it("passes agent arguments as an argv array to an executable", async () => {
    const spawned: Array<{ shell: string; args: string[] | string; env: NodeJS.ProcessEnv }> = [];
    const factory = new NodePtyFactory({ platform: "linux", load: async () => recordingModule(spawned) });

    await factory.spawn({
      cwd: "/workspace",
      shell: "/usr/local/bin/droid",
      args: ["--auto", "high"],
      cols: 80,
      rows: 24,
    });

    expect(spawned[0]).toMatchObject({ shell: "/usr/local/bin/droid", args: ["--auto", "high"] });
  });

  it("hangs up the shell's process group on stop and kills the group when forced", async () => {
    const signals: Array<[number, string]> = [];
    const ptyKills: Array<string | undefined> = [];
    let groupSignalFails = false;
    const factory = new NodePtyFactory({
      platform: "linux",
      load: async () => killRecordingModule(ptyKills),
      signal: (pid, signal) => {
        if (groupSignalFails) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
        signals.push([pid, signal]);
      },
      listProcesses: async () => [{ pid: 31, ppid: 1, pgid: 31 }],
    });
    const pty = await factory.spawn({ cwd: "/workspace", shell: "/bin/bash", cols: 80, rows: 24 });

    pty.kill();
    pty.kill(true);
    await vi.waitFor(() =>
      expect(signals).toEqual([
        [-31, "SIGHUP"],
        [-31, "SIGKILL"],
      ]),
    );
    expect(ptyKills).toEqual([]);

    groupSignalFails = true;
    pty.kill();
    expect(ptyKills).toEqual(["SIGHUP"]);
  });

  it("kills the shell's jobs and their process groups before the shell when forced", async () => {
    const signals: Array<[number, string]> = [];
    const factory = new NodePtyFactory({
      platform: "darwin",
      load: async () => killRecordingModule([]),
      signal: (pid, signal) => signals.push([pid, signal]),
      listProcesses: async () => [
        { pid: 1, ppid: 0, pgid: 1 },
        { pid: 31, ppid: 1, pgid: 31 },
        { pid: 40, ppid: 31, pgid: 40 },
        { pid: 41, ppid: 40, pgid: 40 },
        { pid: 42, ppid: 41, pgid: 42 },
        { pid: 50, ppid: 31, pgid: 31 },
        { pid: 60, ppid: 1, pgid: 60 },
      ],
    });
    const pty = await factory.spawn({ cwd: "/workspace", shell: "/bin/zsh", cols: 80, rows: 24 });

    pty.kill(true);
    await vi.waitFor(() => expect(signals.at(-1)).toEqual([-31, "SIGKILL"]));
    expect(signals).toEqual([
      [-40, "SIGKILL"],
      [40, "SIGKILL"],
      [50, "SIGKILL"],
      [41, "SIGKILL"],
      [-42, "SIGKILL"],
      [42, "SIGKILL"],
      [-31, "SIGKILL"],
    ]);
  });

  it("still kills the shell's group when the process list cannot be read", async () => {
    const signals: Array<[number, string]> = [];
    const factory = new NodePtyFactory({
      platform: "linux",
      load: async () => killRecordingModule([]),
      signal: (pid, signal) => signals.push([pid, signal]),
      listProcesses: async () => {
        throw new Error("spawn ps ENOENT");
      },
    });
    const pty = await factory.spawn({ cwd: "/workspace", shell: "/bin/bash", cols: 80, rows: 24 });

    pty.kill(true);
    await vi.waitFor(() => expect(signals).toEqual([[-31, "SIGKILL"]]));
  });

  it("leaves stopping a Windows terminal to node-pty", async () => {
    const signals: string[] = [];
    const ptyKills: Array<string | undefined> = [];
    const factory = new NodePtyFactory({
      platform: "win32",
      load: async () => killRecordingModule(ptyKills),
      signal: (_pid, signal) => signals.push(signal),
    });
    const pty = await factory.spawn({ cwd: "C:\\workspace", shell: "powershell.exe", cols: 80, rows: 24 });

    pty.kill();
    pty.kill(true);
    expect(ptyKills).toEqual([undefined, undefined]);
    expect(signals).toEqual([]);
  });

  it("omits daemon credentials and the runtime token from the child environment", async () => {
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
          const env = options.env as NodeJS.ProcessEnv | undefined;
          spawned.push({ ...(env === undefined ? {} : { env }) });
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
      ZLI_RUNTIME_TOKEN: "runtime-token",
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
      expect(spawned[1]?.env?.ZLI_RUNTIME_TOKEN).toBeUndefined();
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

function recordingModule(spawned: Array<{ shell: string; args: string[] | string; env: NodeJS.ProcessEnv }>) {
  return {
    spawn: (shell: string, args: string[] | string, options: Record<string, unknown>) => {
      spawned.push({ shell, args, env: options.env as NodeJS.ProcessEnv });
      return {
        pid: 11,
        write: () => undefined,
        resize: () => undefined,
        kill: () => undefined,
        onData: () => ({ dispose: () => undefined }),
        onExit: () => ({ dispose: () => undefined }),
      };
    },
  };
}

function killRecordingModule(kills: Array<string | undefined>) {
  return {
    spawn: () => ({
      pid: 31,
      write: () => undefined,
      resize: () => undefined,
      kill: (signal?: string) => kills.push(signal),
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    }),
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
