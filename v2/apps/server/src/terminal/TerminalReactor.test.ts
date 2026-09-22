import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import {
  CommandId,
  EnvironmentId,
  ProjectId,
  TerminalId,
  WorktreeId,
  type EnvironmentDescriptor,
} from "@zli-v2/contracts";

import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import { TerminalReactor } from "./TerminalReactor.js";
import { TerminalService, type PtyFactory, type PtyProcess } from "./TerminalService.js";

const environment: EnvironmentDescriptor = {
  environmentId: EnvironmentId.parse("00000000-0000-4000-8000-000000000301"),
  label: "terminal test environment",
  protocolVersion: 1,
  capabilities: { terminals: true, eventReplay: true },
};

class FakePty implements PtyProcess {
  readonly pid = 5252;
  private readonly exits = new Set<(event: { code: number; signal: number | null }) => void>();
  readonly writes: string[] = [];

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {}

  kill(): void {}

  onData(): () => void {
    return () => undefined;
  }

  onExit(listener: (event: { code: number; signal: number | null }) => void): () => void {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }

  exit(code = 0): void {
    for (const listener of this.exits) listener({ code, signal: null });
  }
}

function command(type: string, value: Record<string, unknown>) {
  return {
    protocolVersion: 1 as const,
    commandId: CommandId.parse(randomUUID()),
    command: { type, ...value },
  } as never;
}

const resources: Array<{ database: Database; reactor: TerminalReactor }> = [];

async function setup(factory: PtyFactory) {
  const database = new Database({ path: ":memory:" });
  const engine = new Engine({ database, environment });
  const reactor = new TerminalReactor(engine, new TerminalService(factory));
  resources.push({ database, reactor });
  const project = await engine.dispatchPromise(command("project.register", { path: "C:/workspace/project" }));
  const projectId = ProjectId.parse(project.result?.projectId);
  await engine.dispatchPromise(
    command("worktree.create", {
      worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000302"),
      projectId,
      path: "C:/workspace/project-tree",
      workspaceRoot: "C:/workspace",
      branch: "codex/terminal",
    }),
  );
  return { engine, reactor, worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000302") };
}

afterEach(() => {
  for (const resource of resources.splice(0)) {
    resource.reactor.stop();
    resource.database.close();
  }
});

describe("TerminalReactor", () => {
  it("does not execute historical terminal input when recovering a lost PTY", async () => {
    const original = new FakePty();
    const { engine, reactor, worktreeId } = await setup({ spawn: async () => original });
    const id = TerminalId.parse("00000000-0000-4000-8000-000000000306");
    await engine.dispatchPromise(command("terminal.create", {
      terminalId: id, worktreeId, cwd: "C:/workspace/project-tree",
      shell: "powershell.exe", title: "PowerShell", cols: 120, rows: 32,
    }));
    await reactor.waitForIdle();
    await engine.dispatchPromise(command("terminal.write", { terminalId: id, data: "deploy-production\r\n" }));
    await reactor.waitForIdle();
    expect(original.writes).toEqual(["deploy-production\r\n"]);
    reactor.stop();

    const replacement = new FakePty();
    const restored = new TerminalReactor(engine, new TerminalService({ spawn: async () => replacement }));
    try {
      await restored.restore();
      expect(replacement.writes).toEqual([]);
    } finally {
      restored.stop();
    }
  });

  it("materializes a terminal intent and forwards runtime commands to the PTY", async () => {
    const pty = new FakePty();
    const { engine, reactor, worktreeId } = await setup({ spawn: async () => pty });
    const id = TerminalId.parse("00000000-0000-4000-8000-000000000303");
    await engine.dispatchPromise(
      command("terminal.create", {
        terminalId: id,
        worktreeId,
        cwd: "C:/workspace/project-tree",
        shell: "powershell.exe",
        title: "PowerShell",
        cols: 120,
        rows: 32,
      }),
    );
    await engine.waitForReactors();
    expect((await engine.projection()).terminals).toMatchObject([
      { terminalId: id, status: "running" },
    ]);

    await engine.dispatchPromise(command("terminal.write", { terminalId: id, data: "git status\r\n" }));
    expect(pty.writes).toEqual(["git status\r\n"]);
    reactor.stop();
  });

  it("projects a failed terminal startup and does not leave it running", async () => {
    const { engine } = await setup({ spawn: async () => { throw new Error("spawn denied"); } });
    const id = TerminalId.parse("00000000-0000-4000-8000-000000000304");
    await engine.dispatchPromise(
      command("terminal.create", {
        terminalId: id,
        worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000302"),
        cwd: "C:/workspace/project-tree",
        shell: "powershell.exe",
        title: "PowerShell",
        cols: 120,
        rows: 32,
      }),
    );
    await engine.waitForReactors();
    expect((await engine.projection()).terminals).toMatchObject([
      { terminalId: id, status: "failed", errorMessage: "Unable to start terminal in C:/workspace/project-tree. (spawn denied)" },
    ]);
  });

  it("projects a PTY exit once", async () => {
    const pty = new FakePty();
    const { engine, worktreeId } = await setup({ spawn: async () => pty });
    const id = TerminalId.parse("00000000-0000-4000-8000-000000000305");
    await engine.dispatchPromise(
      command("terminal.create", {
        terminalId: id,
        worktreeId,
        cwd: "C:/workspace/project-tree",
        shell: "powershell.exe",
        title: "PowerShell",
        cols: 120,
        rows: 32,
      }),
    );
    await engine.waitForReactors();
    pty.exit(9);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await engine.projection()).terminals).toMatchObject([{ terminalId: id, status: "exited" }]);
  });
});
