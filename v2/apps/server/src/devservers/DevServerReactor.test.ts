import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

import {
  CommandId,
  type EnvironmentDescriptor,
  EnvironmentId,
  ProjectId,
  TerminalId,
  WorktreeId,
} from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import { TerminalReactor } from "../terminal/TerminalReactor.js";
import { type PtyProcess, TerminalService } from "../terminal/TerminalService.js";
import { DevServerReactor, probePort } from "./DevServerReactor.js";

const environment: EnvironmentDescriptor = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000b01"),
  label: "dev server test environment",
  protocolVersion: 1,
  capabilities: { terminals: true, eventReplay: true },
};
const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000b02");
const shellId = TerminalId.parse("00000000-0000-4000-8000-000000000b03");
const agentId = TerminalId.parse("00000000-0000-4000-8000-000000000b04");

class FakePty implements PtyProcess {
  readonly pid = 4242;
  private readonly data = new Set<(data: string) => void>();
  private readonly exits = new Set<(event: { code: number; signal: number | null }) => void>();
  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(listener: (data: string) => void): () => void {
    this.data.add(listener);
    return () => this.data.delete(listener);
  }
  onExit(listener: (event: { code: number; signal: number | null }) => void): () => void {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }
  print(text: string): void {
    for (const listener of this.data) listener(text);
  }
  exit(): void {
    for (const listener of this.exits) listener({ code: 0, signal: null });
  }
}

function command(type: string, value: Record<string, unknown>) {
  return {
    protocolVersion: 1 as const,
    commandId: CommandId.parse(randomUUID()),
    command: { type, ...value },
  } as never;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function setup(options: { alive?: (url: string) => boolean } = {}) {
  const database = new Database({ path: ":memory:" });
  const engine = new Engine({ database, environment });
  const ptys = new Map<string, FakePty>();
  const terminals = new TerminalService({
    spawn: async (input) => {
      const pty = new FakePty();
      ptys.set(String(input.terminalId), pty);
      return pty;
    },
  });
  const terminalReactor = new TerminalReactor(engine, terminals, { resolveAgentCli: async () => "/usr/bin/claude" });
  const probed: string[] = [];
  const reactor = new DevServerReactor(engine, terminals, {
    probeIntervalMs: 60_000,
    probe: async (url) => {
      probed.push(url);
      return options.alive?.(url) ?? true;
    },
  });
  cleanups.push(() => {
    reactor.stop();
    terminalReactor.stop();
    database.close();
  });
  const project = await engine.dispatchPromise(command("project.register", { path: "/workspace/app" }));
  await engine.dispatchPromise(
    command("worktree.create", {
      worktreeId,
      projectId: ProjectId.parse(project.result?.projectId),
      path: "/workspace/app-tree",
      workspaceRoot: "/workspace",
      branch: "feature/dev",
    }),
  );
  const open = async (terminalId: string, agent?: boolean) => {
    await engine.dispatchPromise(
      command("terminal.create", {
        terminalId,
        worktreeId,
        cwd: "/workspace/app-tree",
        shell: "/bin/bash",
        title: "Terminal",
        cols: 80,
        rows: 24,
        ...(agent ? { agent: { provider: "claude-code" } } : {}),
      }),
    );
    await engine.waitForReactors();
    const pty = ptys.get(terminalId);
    if (!pty) throw new Error("terminal did not start");
    return pty;
  };
  const settle = async () => {
    await reactor.waitForIdle();
    await engine.waitForReactors();
  };
  return { engine, reactor, open, settle, probed };
}

describe("DevServerReactor", () => {
  it("records a shell's server for its worktree once, however often it reprints", async () => {
    const { engine, open, settle } = await setup();
    const pty = await open(shellId);
    pty.print("\r\n  VITE v5.4.0  ready in 300 ms\r\n\r\n  ➜  Local:   http://localhost:5173/\r\n");
    await settle();
    const first = await engine.projection();
    expect(first.devServers).toEqual([
      expect.objectContaining({ worktreeId, terminalId: shellId, url: "http://localhost:5173/", port: 5173 }),
    ]);

    pty.print("  ➜  Local:   http://localhost:5173/\r\n");
    await settle();
    expect((await engine.projection()).lastSequence).toBe(first.lastSequence);
  });

  it("ignores addresses printed in agent terminals", async () => {
    const { engine, open, settle } = await setup();
    const pty = await open(agentId, true);
    pty.print("The app is running at http://localhost:3000\r\n");
    await settle();
    expect((await engine.projection()).devServers ?? []).toEqual([]);
  });

  it("forgets a server when its terminal exits", async () => {
    const { engine, open, settle } = await setup();
    const pty = await open(shellId);
    pty.print("Listening on http://127.0.0.1:8000\n");
    await settle();
    expect((await engine.projection()).devServers).toHaveLength(1);
    pty.exit();
    await settle();
    expect((await engine.projection()).devServers).toEqual([]);
  });

  it("forgets a server after three checks in a row find its port closed", async () => {
    let alive = true;
    const { engine, reactor, open, settle, probed } = await setup({ alive: () => alive });
    const pty = await open(shellId);
    pty.print("Server running at http://localhost:4000/\n");
    await settle();
    alive = false;
    await reactor.checkAll();
    await reactor.checkAll();
    expect((await engine.projection()).devServers).toHaveLength(1);
    await reactor.checkAll();
    await settle();
    expect((await engine.projection()).devServers).toEqual([]);
    expect(probed).toEqual(Array(3).fill("http://localhost:4000/"));
  });

  it("rejects a recorded address that is not on this machine", async () => {
    const { engine, open } = await setup();
    await open(shellId);
    const receipt = await engine.dispatchPromise(
      command("devserver.detected", { terminalId: shellId, url: "http://192.168.1.4:3000/" }),
    );
    expect(receipt).toMatchObject({ status: "rejected", error: { code: "unsupported_command" } });
    expect((await engine.projection()).devServers ?? []).toEqual([]);
  });
});

describe("probePort", () => {
  it("reports whether a loopback port accepts connections", async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    expect(await probePort(`http://localhost:${address.port}/`)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probePort(`http://127.0.0.1:${address.port}/`, 300)).toBe(false);
  });
});
