import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  CommandId,
  type EnvironmentDescriptor,
  EnvironmentId,
  ProjectId,
  TerminalId,
  WorktreeId,
} from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { type BrowserToolConfig, codexMcpArgs } from "../browser-tool/browserTool.js";
import { Database } from "../db/Database.js";
import { Engine } from "../orchestration/Engine.js";
import { WorktreeAgentFiles } from "../worktrees/WorktreeAgentFiles.js";
import { TerminalReactor, type TerminalReactorOptions } from "./TerminalReactor.js";
import { type PtyFactory, type PtyProcess, type PtySpawnInput, TerminalService } from "./TerminalService.js";

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

async function setup(
  factory: PtyFactory,
  options: TerminalReactorOptions = {},
  worktreePath = "C:/workspace/project-tree",
) {
  const database = new Database({ path: ":memory:" });
  const engine = new Engine({ database, environment });
  const reactor = new TerminalReactor(engine, new TerminalService(factory), options);
  resources.push({ database, reactor });
  const project = await engine.dispatchPromise(command("project.register", { path: "C:/workspace/project" }));
  const projectId = ProjectId.parse(project.result?.projectId);
  await engine.dispatchPromise(
    command("worktree.create", {
      worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000302"),
      projectId,
      path: worktreePath,
      workspaceRoot: "C:/workspace",
      branch: "codex/terminal",
    }),
  );
  return { engine, reactor, worktreeId: WorktreeId.parse("00000000-0000-4000-8000-000000000302") };
}

const temps: string[] = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.reactor.stop();
    resource.database.close();
  }
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("TerminalReactor", () => {
  it("does not execute historical terminal input when recovering a lost PTY", async () => {
    const original = new FakePty();
    const { engine, reactor, worktreeId } = await setup({ spawn: async () => original });
    const id = TerminalId.parse("00000000-0000-4000-8000-000000000306");
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
    expect((await engine.projection()).terminals).toMatchObject([{ terminalId: id, status: "running" }]);

    await engine.dispatchPromise(command("terminal.write", { terminalId: id, data: "git status\r\n" }));
    expect(pty.writes).toEqual(["git status\r\n"]);
    reactor.stop();
  });

  it("projects a failed terminal startup and does not leave it running", async () => {
    const { engine } = await setup({
      spawn: async () => {
        throw new Error("spawn denied");
      },
    });
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
      {
        terminalId: id,
        status: "failed",
        errorMessage: "Unable to start terminal in C:\\workspace\\project-tree. (spawn denied)",
      },
    ]);
  });

  it("launches the resolved agent CLI with its permission and model flags", async () => {
    const pty = new FakePty();
    const spawned: PtySpawnInput[] = [];
    const resolved: string[] = [];
    const { engine, reactor, worktreeId } = await setup(
      {
        spawn: async (input) => {
          spawned.push(input);
          return pty;
        },
      },
      {
        resolveAgentCli: async (provider) => {
          resolved.push(provider);
          return "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd";
        },
      },
    );
    const id = TerminalId.parse("00000000-0000-4000-8000-000000000307");
    await engine.dispatchPromise(
      command("terminal.create", {
        terminalId: id,
        worktreeId,
        cwd: "C:/workspace/project-tree",
        shell: "powershell.exe",
        title: "Claude Code",
        cols: 120,
        rows: 32,
        agent: { provider: "claude-code", model: "claude-sonnet-4-5" },
      }),
    );
    await reactor.waitForIdle();

    expect(resolved).toEqual(["claude-code"]);
    expect(spawned).toMatchObject([
      {
        shell: "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd",
        args: ["--dangerously-skip-permissions", "--model", "claude-sonnet-4-5"],
        envOverrides: { TERM: "xterm-256color", COLORTERM: "truecolor" },
      },
    ]);
    expect((await engine.projection()).terminals).toMatchObject([
      { terminalId: id, status: "running", kind: "agent", agent: { provider: "claude-code" } },
    ]);
  });

  it("fails an agent terminal with a clear message when its CLI is missing", async () => {
    const spawned: PtySpawnInput[] = [];
    const { engine, worktreeId } = await setup(
      {
        spawn: async (input) => {
          spawned.push(input);
          return new FakePty();
        },
      },
      { resolveAgentCli: async () => undefined },
    );
    const id = TerminalId.parse("00000000-0000-4000-8000-000000000308");
    await engine.dispatchPromise(
      command("terminal.create", {
        terminalId: id,
        worktreeId,
        cwd: "C:/workspace/project-tree",
        shell: "powershell.exe",
        title: "Cursor",
        cols: 120,
        rows: 32,
        agent: { provider: "cursor-agent" },
      }),
    );
    await engine.waitForReactors();

    expect(spawned).toEqual([]);
    expect((await engine.projection()).terminals).toMatchObject([
      { terminalId: id, status: "failed", errorMessage: "Cursor CLI was not found. Install it or check PATH." },
    ]);
  });

  it("relaunches an agent CLI fresh when restoring after a restart", async () => {
    const { engine, reactor, worktreeId } = await setup(
      { spawn: async () => new FakePty() },
      { resolveAgentCli: async () => "/usr/local/bin/droid" },
    );
    const id = TerminalId.parse("00000000-0000-4000-8000-000000000309");
    await engine.dispatchPromise(
      command("terminal.create", {
        terminalId: id,
        worktreeId,
        cwd: "C:/workspace/project-tree",
        shell: "powershell.exe",
        title: "Droid",
        cols: 120,
        rows: 32,
        agent: { provider: "droid", permissionMode: "supervised" },
      }),
    );
    await reactor.waitForIdle();
    reactor.stop();

    const spawned: PtySpawnInput[] = [];
    const restored = new TerminalReactor(
      engine,
      new TerminalService({
        spawn: async (input) => {
          spawned.push(input);
          return new FakePty();
        },
      }),
      { resolveAgentCli: async () => "/usr/local/bin/droid" },
    );
    try {
      await restored.restore();
      expect(spawned).toMatchObject([{ shell: "/usr/local/bin/droid", args: [] }]);
    } finally {
      restored.stop();
    }
  });

  it("gives every terminal the browser tool and registers it as an MCP server for the agent", async () => {
    const browserTool: BrowserToolConfig = {
      command: "C:\\ZLI\\ZLI.exe",
      script: "C:\\ZLI\\zli-browser.js",
      controlFile: "C:\\ZLI\\data\\browser-control.json",
      shimDir: "C:\\ZLI\\data\\bin",
      mcpConfigDir: "C:\\ZLI\\data\\mcp",
    };
    const spawned: PtySpawnInput[] = [];
    const written: Array<{ kind: string; worktreeId: string | undefined }> = [];
    const { engine, reactor, worktreeId } = await setup(
      {
        spawn: async (input) => {
          spawned.push(input);
          return new FakePty();
        },
      },
      {
        resolveAgentCli: async (provider) => `C:\\bin\\${provider}.exe`,
        browserTool,
        env: {},
        writeMcpConfig: async (_config, kind, id) => {
          written.push({ kind, worktreeId: id });
          if (kind === "copilot") throw new Error("disk full");
          return `C:\\ZLI\\data\\mcp\\${kind}-${id}.json`;
        },
      },
    );
    const create = (n: number, extra: Record<string, unknown>) =>
      engine.dispatchPromise(
        command("terminal.create", {
          terminalId: TerminalId.parse(`00000000-0000-4000-8000-00000000032${n}`),
          worktreeId,
          cwd: "C:/workspace/project-tree",
          shell: "powershell.exe",
          title: "Terminal",
          cols: 120,
          rows: 32,
          ...extra,
        }),
      );
    await create(1, {});
    await create(2, { agent: { provider: "claude-code" } });
    await create(3, { agent: { provider: "opencode" } });
    await create(4, { agent: { provider: "copilot" } });
    await reactor.waitForIdle();

    const browserEnv = { ZLI_BROWSER_CONTROL_FILE: browserTool.controlFile, ZLI_WORKTREE_ID: worktreeId };
    expect(spawned[0]).toMatchObject({
      shell: "powershell.exe",
      envOverrides: browserEnv,
      pathPrepend: browserTool.shimDir,
    });
    expect(spawned[0]?.args).toBeUndefined();
    expect(spawned[1]).toMatchObject({
      args: ["--dangerously-skip-permissions", "--mcp-config", `C:\\ZLI\\data\\mcp\\claude-${worktreeId}.json`],
      envOverrides: { TERM: "xterm-256color", COLORTERM: "truecolor", ...browserEnv },
      pathPrepend: browserTool.shimDir,
    });
    expect(JSON.parse(spawned[2]?.envOverrides?.OPENCODE_CONFIG_CONTENT ?? "")).toEqual({
      mcp: {
        "zli-browser": {
          type: "local",
          command: [browserTool.command, browserTool.script, "mcp"],
          environment: { ELECTRON_RUN_AS_NODE: "1", ...browserEnv },
          enabled: true,
        },
      },
    });
    // A failed config write drops only the MCP flag; the agent still starts.
    expect(spawned[3]).toMatchObject({ shell: "C:\\bin\\copilot.exe", args: ["--allow-all"] });
    expect(written).toEqual([
      { kind: "claude", worktreeId },
      { kind: "copilot", worktreeId },
    ]);
    expect((await engine.projection()).terminals.map((terminal) => terminal.status)).toEqual([
      "running",
      "running",
      "running",
      "running",
    ]);
  });
  it("hands MCP servers from Settings to agents even without the browser tool", async () => {
    const spawned: PtySpawnInput[] = [];
    const written: Array<{ dir: string; kind: string; names: string[] }> = [];
    const github = { name: "github", command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: "t" } };
    let servers = [github];
    const asked: unknown[] = [];
    const { engine, reactor, worktreeId } = await setup(
      {
        spawn: async (input) => {
          spawned.push(input);
          return new FakePty();
        },
      },
      {
        resolveAgentCli: async (provider) => `C:\\bin\\${provider}.exe`,
        mcpServers: async (context) => {
          asked.push(context);
          return servers;
        },
        mcpConfigDir: "C:\\ZLI\\data\\mcp",
        env: {},
        writeMcpConfig: async (dir, kind, id, specs) => {
          written.push({ dir, kind, names: specs.map((spec) => spec.name) });
          return `${dir}\\${kind}-${id}.json`;
        },
      },
    );
    const create = (n: number, agent: Record<string, unknown>) =>
      engine.dispatchPromise(
        command("terminal.create", {
          terminalId: TerminalId.parse(`00000000-0000-4000-8000-00000000033${n}`),
          worktreeId,
          cwd: "C:/workspace/project-tree",
          shell: "powershell.exe",
          title: "Terminal",
          cols: 120,
          rows: 32,
          agent,
        }),
      );
    await create(1, { provider: "claude-code" });
    await create(2, { provider: "codex" });
    await reactor.waitForIdle();
    servers = [];
    await create(3, { provider: "codex" });
    await reactor.waitForIdle();

    expect(written).toEqual([{ dir: "C:\\ZLI\\data\\mcp", kind: "claude", names: ["github"] }]);
    expect(spawned[0]?.args).toEqual([
      "--dangerously-skip-permissions",
      "--mcp-config",
      `C:\\ZLI\\data\\mcp\\claude-${worktreeId}.json`,
    ]);
    expect(spawned[0]?.pathPrepend).toBeUndefined();
    expect(spawned[1]?.args).toEqual(["--dangerously-bypass-approvals-and-sandbox", ...codexMcpArgs(github)]);
    // A server removed in Settings is gone from the next launch.
    expect(spawned[2]?.args).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    // The worktree picks the project, which decides which project-limited servers the agent gets.
    expect(asked).toEqual([{ worktreeId }, { worktreeId }, { worktreeId }]);
  });

  it("gives Droid its servers in a project MCP file in the worktree that git does not see", async () => {
    const root = await mkdtemp(join(tmpdir(), "zli-reactor-"));
    temps.push(root);
    const run = promisify(execFile);
    await run("git", ["init", "--quiet", root]);
    const statePath = `${root}-state.json`;
    temps.push(statePath);
    const agentFiles = new WorktreeAgentFiles({ statePath });
    const spawned: PtySpawnInput[] = [];
    const github = { name: "github", command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: "t" } };
    const { engine, reactor, worktreeId } = await setup(
      {
        spawn: async (input) => {
          spawned.push(input);
          return new FakePty();
        },
      },
      {
        resolveAgentCli: async (provider) => `/usr/bin/${provider}`,
        mcpServers: async () => [github],
        env: {},
        writeWorktreeFile: (worktreePath, relPath, contents) => agentFiles.writeFile(worktreePath, relPath, contents),
      },
      root,
    );
    await engine.dispatchPromise(
      command("terminal.create", {
        terminalId: TerminalId.parse("00000000-0000-4000-8000-000000000341"),
        worktreeId,
        cwd: root,
        shell: "bash",
        title: "Droid",
        cols: 120,
        rows: 32,
        agent: { provider: "droid" },
      }),
    );
    await reactor.waitForIdle();

    expect(spawned[0]?.args).toEqual(["--auto", "high"]);
    const file = join(root, ".factory", "mcp.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      mcpServers: { github: { type: "stdio", command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: "t" } } },
    });
    expect((await run("git", ["status", "--porcelain"], { cwd: root })).stdout).toBe("");

    await agentFiles.removeAll();
    await expect(readFile(file, "utf8")).rejects.toThrow();
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
  it("stops a deleted session's terminal and records nothing more for it", async () => {
    const kills: number[] = [];
    const pty = new FakePty();
    pty.kill = () => kills.push(1);
    const { engine, reactor, worktreeId } = await setup({ spawn: async () => pty });
    const id = TerminalId.parse("00000000-0000-4000-8000-000000000310");
    const sessionId = "00000000-0000-4000-8000-000000000311";
    await engine.dispatchPromise(
      command("terminal.create", {
        terminalId: id,
        worktreeId,
        cwd: "C:/workspace/project-tree",
        shell: "powershell.exe",
        title: "PowerShell",
        cols: 120,
        rows: 32,
        sessionId,
      }),
    );
    await reactor.waitForIdle();
    await engine.dispatchPromise(command("session.delete", { sessionId }));
    await reactor.waitForIdle();
    expect(kills).toEqual([1]);

    const before = (await engine.projection()).lastSequence;
    pty.exit(0);
    await reactor.waitForIdle();
    const after = await engine.projection();
    expect(after.terminals).toEqual([]);
    expect(after.lastSequence).toBe(before);
  });
});

describe("TerminalReactor accounts", () => {
  const spawnInto = (spawned: PtySpawnInput[]): PtyFactory => ({
    spawn: async (input) => {
      spawned.push(input);
      return new FakePty();
    },
  });
  const create = (engine: Engine, worktreeId: string, n: number, agent: Record<string, unknown>) =>
    engine.dispatchPromise(
      command("terminal.create", {
        terminalId: TerminalId.parse(`00000000-0000-4000-8000-0000000003a${n}`),
        worktreeId,
        cwd: "C:/workspace/project-tree",
        shell: "powershell.exe",
        title: "Agent",
        cols: 120,
        rows: 32,
        agent,
      }),
    );

  it("starts an agent with its account's environment, and the usual login without one", async () => {
    const spawned: PtySpawnInput[] = [];
    const asked: Array<{ provider: string; accountId: string | undefined }> = [];
    const { engine, reactor, worktreeId } = await setup(spawnInto(spawned), {
      resolveAgentCli: async (provider) => `C:\\bin\\${provider}.exe`,
      env: {},
      resolveAccount: async (provider, accountId) => {
        asked.push({ provider, accountId });
        return accountId === "work" ? { accountId, env: { CLAUDE_CONFIG_DIR: "C:\\ZLI\\accounts\\work" } } : undefined;
      },
    });
    await create(engine, worktreeId, 1, { provider: "claude-code", accountId: "work" });
    await create(engine, worktreeId, 2, { provider: "claude-code" });
    await reactor.waitForIdle();

    expect(asked).toEqual([
      { provider: "claude-code", accountId: "work" },
      { provider: "claude-code", accountId: undefined },
    ]);
    expect(spawned[0]?.envOverrides).toMatchObject({ CLAUDE_CONFIG_DIR: "C:\\ZLI\\accounts\\work" });
    expect(spawned[1]?.envOverrides?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect((await engine.projection()).terminals[0]?.agent).toEqual({ provider: "claude-code", accountId: "work" });
  });

  it("runs the CLI's own login for a sign-in, without MCP flags", async () => {
    const spawned: PtySpawnInput[] = [];
    const { engine, reactor, worktreeId } = await setup(spawnInto(spawned), {
      resolveAgentCli: async (provider) => `C:\\bin\\${provider}.exe`,
      env: {},
      mcpServers: () => [{ name: "github", command: "npx", args: [], env: {} }],
      mcpConfigDir: "C:\\ZLI\\data\\mcp",
      writeMcpConfig: async () => {
        throw new Error("no MCP config for a sign-in");
      },
      resolveAccount: async (_provider, accountId) =>
        accountId ? { accountId, env: { CODEX_HOME: "C:\\ZLI\\accounts\\home" } } : undefined,
    });
    await create(engine, worktreeId, 3, { provider: "codex", accountId: "home", login: true });
    await create(engine, worktreeId, 4, { provider: "codex", login: true });
    await reactor.waitForIdle();

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      shell: "C:\\bin\\codex.exe",
      args: ["login"],
      envOverrides: { CODEX_HOME: "C:\\ZLI\\accounts\\home" },
    });
    const terminals = (await engine.projection()).terminals;
    expect(terminals.map((terminal) => terminal.status)).toEqual(["running", "failed"]);
    expect(terminals[1]?.errorMessage).toContain("Choose an account to sign in to.");
  });

  it("fails the agent instead of running it as someone else when its account is gone", async () => {
    const spawned: PtySpawnInput[] = [];
    const { engine, reactor, worktreeId } = await setup(spawnInto(spawned), {
      resolveAgentCli: async (provider) => `C:\\bin\\${provider}.exe`,
      env: {},
      resolveAccount: async () => {
        throw new Error("The account for this agent was removed. Start it with another account.");
      },
    });
    await create(engine, worktreeId, 5, { provider: "gemini", accountId: "gone" });
    await reactor.waitForIdle();
    expect(spawned).toEqual([]);
    expect((await engine.projection()).terminals[0]).toMatchObject({ status: "failed" });
  });

  it("answers the agent's folder trust question only in a project the person trusted", async () => {
    const spawned: PtySpawnInput[] = [];
    const { engine, reactor, worktreeId } = await setup(spawnInto(spawned), {
      resolveAgentCli: async (provider) => `C:\\bin\\${provider}.exe`,
      env: {},
    });
    await create(engine, worktreeId, 6, { provider: "gemini", permissionMode: "supervised" });
    await create(engine, worktreeId, 7, { provider: "kimi", permissionMode: "supervised" });
    await reactor.waitForIdle();
    const projectId = (await engine.projection()).projects[0]?.projectId;
    await engine.dispatchPromise(command("project.agents", { projectId, trusted: true }));
    await create(engine, worktreeId, 8, { provider: "gemini", permissionMode: "supervised" });
    await create(engine, worktreeId, 9, { provider: "kimi", permissionMode: "supervised" });
    await reactor.waitForIdle();

    expect(spawned.map((input) => input.args)).toEqual([[], [], ["--skip-trust"], []]);
    expect(spawned.map((input) => input.envOverrides?.KIMI_CODE_TRUST_WORKSPACE)).toEqual([
      undefined,
      undefined,
      undefined,
      "1",
    ]);
  });
});
