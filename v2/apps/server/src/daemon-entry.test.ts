import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { accept, writeDaemonEndpointFile } from "./daemon-entry.js";
import { TerminalService } from "./terminal/TerminalService.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it("writes the daemon endpoint file as owner read/write only", async () => {
  const endpointPath = join(await tempDirectory(), "runtime", "daemon.json");
  const contents = JSON.stringify({ token: "secret-token" });

  await writeDaemonEndpointFile(endpointPath, contents);

  expect(await readFile(endpointPath, "utf8")).toBe(contents);
  await expectOwnerReadWriteOnly(endpointPath);
});

it("tightens an existing daemon endpoint file when replacing it", async () => {
  const endpointPath = join(await tempDirectory(), "daemon.json");
  await writeFile(endpointPath, "old-token", "utf8");
  if (process.platform !== "win32") {
    await chmod(endpointPath, 0o666);
    expect((await stat(endpointPath)).mode & 0o777).toBe(0o666);
  }
  const contents = JSON.stringify({ token: "replacement-token" });

  await writeDaemonEndpointFile(endpointPath, contents);

  expect(await readFile(endpointPath, "utf8")).toBe(contents);
  await expectOwnerReadWriteOnly(endpointPath);
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zli-daemon-endpoint-"));
  directories.push(directory);
  return directory;
}

async function expectOwnerReadWriteOnly(endpointPath: string): Promise<void> {
  const mode = (await stat(endpointPath)).mode & 0o777;
  if (process.platform === "win32") {
    expect(mode & 0o200).not.toBe(0);
    return;
  }
  expect(mode).toBe(0o600);
}

it("drops daemon credential env after reading it and still accepts that token", async () => {
  const previous = {
    token: process.env.ZLI_DAEMON_TOKEN,
    endpointPath: process.env.ZLI_DAEMON_ENDPOINT_PATH,
    protocolVersion: process.env.ZLI_DAEMON_PROTOCOL_VERSION,
    version: process.env.ZLI_DAEMON_VERSION,
  };
  process.env.ZLI_DAEMON_TOKEN = "reconnect-token";
  process.env.ZLI_DAEMON_ENDPOINT_PATH = "/tmp/zli-daemon-endpoint.json";
  process.env.ZLI_DAEMON_PROTOCOL_VERSION = "1";
  process.env.ZLI_DAEMON_VERSION = "zli-v2-daemon/1";
  vi.resetModules();
  try {
    const { accept: acceptFresh } = await import("./daemon-entry.js");
    expect(process.env.ZLI_DAEMON_TOKEN).toBeUndefined();
    expect(process.env.ZLI_DAEMON_ENDPOINT_PATH).toBeUndefined();
    expect(process.env.ZLI_DAEMON_PROTOCOL_VERSION).toBe("1");
    expect(process.env.ZLI_DAEMON_VERSION).toBe("zli-v2-daemon/1");

    const writes: string[] = [];
    const socket = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn(),
      destroyed: false,
      write: (data: string) => {
        writes.push(data);
        return true;
      },
    });
    const service = new TerminalService({
      spawn: async () => {
        throw new Error("unused");
      },
    });
    acceptFresh(socket as unknown as Socket, service);
    socket.emit("data", `${JSON.stringify({ type: "hello", token: "reconnect-token", protocolVersion: 1 })}\n`);
    expect(writes).toEqual([`${JSON.stringify({ type: "hello", protocolVersion: 1 })}\n`]);

    const deniedWrites: string[] = [];
    const end = vi.fn();
    const denied = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
      destroy: vi.fn(),
      end,
      destroyed: false,
      write: (data: string) => {
        deniedWrites.push(data);
        return true;
      },
    });
    acceptFresh(denied as unknown as Socket, service);
    denied.emit("data", `${JSON.stringify({ type: "hello", token: "other-token", protocolVersion: 1 })}\n`);
    expect(deniedWrites).toEqual([`${JSON.stringify({ type: "error", message: "unauthorized" })}\n`]);
    expect(end).toHaveBeenCalledOnce();
  } finally {
    restoreEnv("ZLI_DAEMON_TOKEN", previous.token);
    restoreEnv("ZLI_DAEMON_ENDPOINT_PATH", previous.endpointPath);
    restoreEnv("ZLI_DAEMON_PROTOCOL_VERSION", previous.protocolVersion);
    restoreEnv("ZLI_DAEMON_VERSION", previous.version);
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

it("rejects terminal cwd escapes and argv, and accepts a worktree subdirectory", async () => {
  const previous = {
    token: process.env.ZLI_DAEMON_TOKEN,
    endpointPath: process.env.ZLI_DAEMON_ENDPOINT_PATH,
    protocolVersion: process.env.ZLI_DAEMON_PROTOCOL_VERSION,
  };
  process.env.ZLI_DAEMON_TOKEN = "cwd-token";
  process.env.ZLI_DAEMON_ENDPOINT_PATH = "/tmp/zli-daemon-endpoint.json";
  process.env.ZLI_DAEMON_PROTOCOL_VERSION = "1";
  vi.resetModules();
  try {
    const { accept: acceptFresh } = await import("./daemon-entry.js");
    const { TerminalService: FreshTerminalService } = await import("./terminal/TerminalService.js");
    const spawned: string[] = [];
    const launches: Array<{ args?: string[]; envOverrides?: Record<string, string>; pathPrepend?: string }> = [];
    const service = new FreshTerminalService({
      spawn: async (input: {
        cwd: string;
        args?: string[];
        envOverrides?: Record<string, string>;
        pathPrepend?: string;
      }) => {
        spawned.push(input.cwd);
        launches.push({
          ...(input.args ? { args: input.args } : {}),
          ...(input.envOverrides ? { envOverrides: input.envOverrides } : {}),
          ...(input.pathPrepend ? { pathPrepend: input.pathPrepend } : {}),
        });
        return {
          pid: 9,
          write() {},
          resize() {},
          kill() {},
          onData() {
            return () => undefined;
          },
          onExit() {
            return () => undefined;
          },
        };
      },
    });
    const writes: string[] = [];
    const socket = Object.assign(new EventEmitter(), {
      setEncoding: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn(),
      destroyed: false,
      write: (data: string) => {
        writes.push(data);
        return true;
      },
    });
    acceptFresh(socket as unknown as Socket, service);
    const request = async (payload: unknown) => {
      const before = writes.length;
      socket.emit("data", `${JSON.stringify(payload)}\n`);
      await vi.waitFor(() => {
        expect(writes.length).toBeGreaterThan(before);
      });
      return JSON.parse(writes[writes.length - 1] ?? "") as { type: string; message?: string };
    };
    expect(await request({ type: "hello", token: "cwd-token", protocolVersion: 1 })).toEqual({
      type: "hello",
      protocolVersion: 1,
    });
    const outside = {
      type: "terminal.create",
      terminalId: "00000000-0000-4000-8000-000000000111",
      worktreeId: "00000000-0000-4000-8000-000000000112",
      worktreePath: "/repo/tree",
      cwd: "/etc/passwd",
      shell: "/bin/bash",
      cols: 80,
      rows: 24,
      title: "escape",
    };
    expect(await request(outside)).toMatchObject({
      type: "error",
      message: "Terminal cwd must stay inside the worktree.",
    });
    expect(await request({ ...outside, cwd: "src", argv: ["-c", "id"] })).toMatchObject({
      type: "error",
      message: "Terminal launch does not accept argv.",
    });
    expect(await request({ ...outside, cwd: "src", args: "--force" })).toMatchObject({
      type: "error",
      message: "Terminal launch arguments are invalid.",
    });
    expect(await request({ ...outside, cwd: "src", args: [], envOverrides: { PATH: "/tmp/evil" } })).toMatchObject({
      type: "error",
      message: "Terminal environment override is not allowed: PATH",
    });
    expect(await request({ ...outside, cwd: "src/pkg", title: "nested" })).toMatchObject({ type: "result" });
    expect(
      await request({
        ...outside,
        terminalId: "00000000-0000-4000-8000-000000000113",
        cwd: "src",
        shell: "/usr/local/bin/droid",
        args: ["--auto", "high"],
        envOverrides: { TERM: "xterm-256color", COLORTERM: "truecolor" },
      }),
    ).toMatchObject({ type: "result" });
    expect(spawned).toEqual(["/repo/tree/src/pkg", "/repo/tree/src"]);
    expect(launches).toEqual([
      {},
      { args: ["--auto", "high"], envOverrides: { TERM: "xterm-256color", COLORTERM: "truecolor" } },
    ]);

    const controlFile = resolve("/data/zli/browser-control.json");
    const shimDir = resolve("/data/zli/bin");
    const browser = (n: number, extra: Record<string, unknown>) => ({
      ...outside,
      terminalId: `00000000-0000-4000-8000-00000000012${n}`,
      cwd: "src",
      ...extra,
    });
    expect(
      await request(browser(1, { envOverrides: { ZLI_WORKTREE_ID: "00000000-0000-4000-8000-000000000999" } })),
    ).toMatchObject({ type: "error", message: "Terminal environment override is not allowed: ZLI_WORKTREE_ID" });
    expect(
      await request(browser(2, { envOverrides: { ZLI_BROWSER_CONTROL_FILE: "relative/control.json" } })),
    ).toMatchObject({
      type: "error",
      message: "Terminal environment override is not allowed: ZLI_BROWSER_CONTROL_FILE",
    });
    expect(await request(browser(3, { envOverrides: { OPENCODE_CONFIG_CONTENT: "not json" } }))).toMatchObject({
      type: "error",
      message: "Terminal environment override is not allowed: OPENCODE_CONFIG_CONTENT",
    });
    expect(await request(browser(4, { pathPrepend: "relative/bin" }))).toMatchObject({
      type: "error",
      message: "Terminal PATH addition is invalid.",
    });
    expect(await request(browser(5, { pathPrepend: `${shimDir}${delimiter}${resolve("/evil")}` }))).toMatchObject({
      type: "error",
      message: "Terminal PATH addition is invalid.",
    });
    const accepted = {
      ZLI_WORKTREE_ID: outside.worktreeId,
      ZLI_BROWSER_CONTROL_FILE: controlFile,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: {} }),
    };
    expect(await request(browser(6, { envOverrides: accepted, pathPrepend: shimDir }))).toMatchObject({
      type: "result",
    });
    expect(launches.at(-1)).toEqual({ envOverrides: accepted, pathPrepend: shimDir });
  } finally {
    restoreEnv("ZLI_DAEMON_TOKEN", previous.token);
    restoreEnv("ZLI_DAEMON_ENDPOINT_PATH", previous.endpointPath);
    restoreEnv("ZLI_DAEMON_PROTOCOL_VERSION", previous.protocolVersion);
  }
});

it("isolates a reset runtime socket without crashing the terminal daemon", () => {
  const socket = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
    destroy: vi.fn(),
  });
  const service = new TerminalService({
    spawn: async () => {
      throw new Error("unused");
    },
  });
  accept(socket as unknown as Socket, service);
  expect(() => socket.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).not.toThrow();
  expect(socket.destroy).toHaveBeenCalledOnce();
});

it("stops its terminals and exits when an authenticated client asks it to shut down", async () => {
  const previous = { token: process.env.ZLI_DAEMON_TOKEN, endpointPath: process.env.ZLI_DAEMON_ENDPOINT_PATH };
  process.env.ZLI_DAEMON_TOKEN = "shutdown-token";
  process.env.ZLI_DAEMON_ENDPOINT_PATH = "/tmp/zli-daemon-endpoint.json";
  vi.resetModules();
  try {
    const { accept: acceptFresh } = await import("./daemon-entry.js");
    const { DaemonLifecycle } = await import("./daemon/DaemonLifecycle.js");
    let stopped = 0;
    let exits = 0;
    const terminals = {
      list: () => [],
      stopAll: () => {
        stopped += 1;
      },
      subscribeExit: () => () => undefined,
    };
    const lifecycle = new DaemonLifecycle({ terminals, exit: () => (exits += 1), idleMs: 60_000 });
    const writes: string[] = [];
    const connect = () => {
      const socket = Object.assign(new EventEmitter(), {
        setEncoding: vi.fn(),
        destroy: vi.fn(),
        end: vi.fn(),
        destroyed: false,
        write: (data: string) => {
          writes.push(data);
          return true;
        },
      });
      acceptFresh(socket as unknown as Socket, terminals as unknown as TerminalService, lifecycle);
      return socket;
    };
    connect().emit("data", `${JSON.stringify({ type: "shutdown" })}\n`);
    expect(writes).toEqual([`${JSON.stringify({ type: "error", message: "unauthorized" })}\n`]);
    expect(stopped).toBe(0);

    const authed = connect();
    authed.emit("data", `${JSON.stringify({ type: "hello", token: "shutdown-token", protocolVersion: 1 })}\n`);
    authed.emit("data", `${JSON.stringify({ type: "shutdown" })}\n`);
    await vi.waitFor(() => expect(exits).toBe(1));
    expect(stopped).toBe(1);
    expect(writes.at(-1)).toBe(`${JSON.stringify({ type: "result", accepted: true })}\n`);
  } finally {
    restoreEnv("ZLI_DAEMON_TOKEN", previous.token);
    restoreEnv("ZLI_DAEMON_ENDPOINT_PATH", previous.endpointPath);
  }
});
