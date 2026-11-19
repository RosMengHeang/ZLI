import { randomUUID } from "node:crypto";

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
import { TerminalActivityReactor } from "./TerminalActivityReactor.js";
import { TerminalReactor } from "./TerminalReactor.js";
import { type PtyProcess, TerminalService } from "./TerminalService.js";

const environment: EnvironmentDescriptor = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000c01"),
  label: "terminal activity test environment",
  protocolVersion: 1,
  capabilities: { terminals: true, eventReplay: true },
};
const worktreeId = WorktreeId.parse("00000000-0000-4000-8000-000000000c02");
const agentId = TerminalId.parse("00000000-0000-4000-8000-000000000c03");
const shellId = TerminalId.parse("00000000-0000-4000-8000-000000000c04");

class FakePty implements PtyProcess {
  readonly pid = 4343;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Short thresholds so the tests run in real time: a spinner frame every 10ms is steady output.
const timing = { sustainMs: 40, burstGapMs: 60, quietMs: 150, inputGraceMs: 80 };

async function setup() {
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
  const reactor = new TerminalActivityReactor(engine, terminals, timing);
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
      branch: "feature/activity",
    }),
  );
  const open = async (terminalId: string, agent: boolean) => {
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
    await terminalReactor.waitForIdle();
    const pty = ptys.get(terminalId);
    if (!pty) throw new Error("terminal did not start");
    return pty;
  };
  /** Prints a spinner frame every 10ms for the given time, as a busy agent CLI does. */
  const spin = async (pty: FakePty, ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 10) {
      pty.print("\u001b[2K\r⠋ Working (esc to interrupt)");
      await sleep(10);
    }
  };
  const activity = async (terminalId: string) => {
    await reactor.waitForIdle();
    await engine.waitForReactors();
    return (await engine.projection()).terminals.find((terminal) => terminal.terminalId === terminalId)?.activity;
  };
  return { engine, terminals, open, spin, activity };
}

describe("TerminalActivityReactor", () => {
  it("marks an agent working while its output keeps coming, and idle once it goes quiet", async () => {
    const { open, spin, activity } = await setup();
    const pty = await open(agentId, true);
    expect(await activity(agentId)).toBeUndefined();
    await spin(pty, 120);
    expect(await activity(agentId)).toBe("working");
    await sleep(timing.quietMs + 80);
    expect(await activity(agentId)).toBe("idle");
  });

  it("leaves one redraw alone, so a repaint is not mistaken for work", async () => {
    const { open, activity } = await setup();
    const pty = await open(agentId, true);
    pty.print("\u001b[H\u001b[2J> ");
    pty.print("ready");
    await sleep(timing.quietMs + 50);
    expect(await activity(agentId)).toBeUndefined();
  });

  it("does not count the terminal answering a keystroke or a resize as work", async () => {
    const { open, terminals, activity } = await setup();
    const pty = await open(agentId, true);
    for (let index = 0; index < 8; index += 1) {
      terminals.write(agentId, "a");
      pty.print("a");
      await sleep(10);
    }
    terminals.resize(agentId, 100, 30);
    pty.print("\u001b[H\u001b[2J redrawn");
    await sleep(timing.quietMs + 50);
    expect(await activity(agentId)).toBeUndefined();
  });

  it("keeps a busy agent working while the person types into it", async () => {
    const { open, terminals, spin, activity } = await setup();
    const pty = await open(agentId, true);
    await spin(pty, 100);
    terminals.write(agentId, "next");
    await spin(pty, 100);
    expect(await activity(agentId)).toBe("working");
  });

  it("never marks a shell, which prints for all kinds of reasons", async () => {
    const { open, spin, activity } = await setup();
    const pty = await open(shellId, false);
    await spin(pty, 120);
    expect(await activity(shellId)).toBeUndefined();
  });

  it("drops a working mark when the agent's process ends", async () => {
    const { engine, open, spin, activity } = await setup();
    const pty = await open(agentId, true);
    await spin(pty, 120);
    expect(await activity(agentId)).toBe("working");
    pty.exit();
    await engine.waitForReactors();
    await sleep(20);
    const terminal = (await engine.projection()).terminals.find((entry) => entry.terminalId === agentId);
    expect(terminal?.status).toBe("exited");
    expect(terminal?.activity).toBeUndefined();
  });

  it("records only changes, so a steady agent adds no events", async () => {
    const { engine, open, spin, activity } = await setup();
    const pty = await open(agentId, true);
    await spin(pty, 120);
    await activity(agentId);
    const before = (await engine.projection()).lastSequence;
    await engine.dispatchPromise(command("terminal.activity", { terminalId: agentId, activity: "working" }));
    expect((await engine.projection()).lastSequence).toBe(before);
  });
});
