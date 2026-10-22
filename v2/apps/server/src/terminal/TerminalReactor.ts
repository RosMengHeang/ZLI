import { randomUUID } from "node:crypto";

import {
  CommandId,
  type ListedProviderKind,
  type RuntimeEventEnvelope,
  type TerminalAgentLaunch,
  TerminalId,
} from "@zli-v2/contracts";

import {
  type BrowserToolConfig,
  browserToolEnv,
  type McpServerSpec,
  zliMcpServerSpecs,
  opencodeConfigContent,
  writeAgentMcpConfig,
} from "../browser-tool/browserTool.js";
import type { Engine } from "../orchestration/Engine.js";
import {
  AGENT_PTY_ENV,
  AgentLaunchError,
  agentCliMissingMessage,
  buildAgentArgs,
  mcpConfigFileKind,
  mcpLaunchArgs,
} from "./agentLaunch.js";
import type { TerminalService } from "./TerminalService.js";

type CreateIntent = Extract<RuntimeEventEnvelope["event"], { type: "terminal.create.requested" }>;

/** Returns the absolute path of an installed agent CLI, or undefined when it is not installed. */
export type AgentCliResolver = (provider: ListedProviderKind) => Promise<string | undefined>;

export type TerminalReactorOptions = {
  resolveAgentCli?: AgentCliResolver;
  /** When set, every terminal can run `zli-browser` and agent CLIs get it as an MCP server. */
  browserTool?: BrowserToolConfig;
  /** MCP servers added in Settings, read at each launch so a change applies to the next agent. */
  mcpServers?: () => readonly McpServerSpec[];
  /** Where per-launch MCP config files go when there is no browser tool. */
  mcpConfigDir?: string;
  writeMcpConfig?: typeof writeAgentMcpConfig;
  /** The environment agent settings such as OPENCODE_CONFIG_CONTENT are merged with. */
  env?: NodeJS.ProcessEnv;
};

type AgentCommand = { file: string; args: string[]; env: Record<string, string> };

export class TerminalReactor {
  private readonly intents = new Map<string, CreateIntent>();
  /** Terminals whose session was deleted. Their exit and startup results have no record to update. */
  private readonly deleted = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeExit: () => void;

  constructor(
    private readonly engine: Engine,
    private readonly service: TerminalService,
    private readonly options: TerminalReactorOptions = {},
  ) {
    this.unsubscribe = engine.subscribe((envelope) => this.onEvent(envelope));
    this.unsubscribeExit = service.subscribeExit((terminalId, event) => {
      if (this.deleted.has(terminalId)) return;
      this.track(this.dispatchStatus(terminalId, "exited", undefined, event.code));
    });
  }

  stop(): void {
    this.unsubscribe();
    this.unsubscribeExit();
  }

  async waitForIdle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.all([...this.tasks]);
    await this.engine.projection();
  }

  async restore(): Promise<void> {
    const projection = await this.engine.projection();
    const events = await this.engine.eventsAfter(0);
    for (const envelope of events) {
      if (envelope.event.type !== "terminal.create.requested") continue;
      const intent = envelope.event;
      const terminal = projection.terminals.find((candidate) => candidate.terminalId === intent.terminal.terminalId);
      if (
        !terminal ||
        (terminal.status !== "running" && terminal.status !== "starting") ||
        this.intents.has(terminal.terminalId)
      )
        continue;
      this.intents.set(terminal.terminalId, intent);
      this.startCreate(intent);
    }
    await this.waitForIdle();
  }

  private onEvent(envelope: RuntimeEventEnvelope): void {
    switch (envelope.event.type) {
      case "terminal.create.requested":
        this.intents.set(envelope.event.terminal.terminalId, envelope.event);
        this.startCreate(envelope.event);
        return;
      case "terminal.write.requested":
        this.track(this.runWrite(envelope.event.terminalId, envelope.event.data));
        return;
      case "terminal.resize.requested":
        this.track(this.runResize(envelope.event.terminalId, envelope.event.cols, envelope.event.rows));
        return;
      case "terminal.stop.requested":
        this.track(this.runStop(envelope.event.terminalId));
        return;
      case "session.deleted":
        for (const terminalId of envelope.event.terminalIds) this.forget(terminalId);
        return;
      default:
        return;
    }
  }

  private startCreate(intent: CreateIntent): void {
    const task = this.runCreate(intent);
    this.track(task);
  }

  private async runCreate(intent: CreateIntent): Promise<void> {
    try {
      const worktreePath = intent.worktreePath ?? (await this.worktreePath(intent.terminal.worktreeId));
      if (!worktreePath) throw new Error(`Worktree does not exist: ${intent.terminal.worktreeId}`);
      const worktreeId = intent.terminal.worktreeId;
      const agent = intent.terminal.agent ? await this.agentCommand(intent.terminal.agent, worktreeId) : undefined;
      const browserTool = this.options.browserTool;
      const envOverrides = {
        ...(agent ? AGENT_PTY_ENV : {}),
        ...(browserTool ? browserToolEnv(browserTool, worktreeId) : {}),
        ...agent?.env,
      };
      await this.service.create({
        terminalId: intent.terminal.terminalId,
        worktreeId,
        worktreePath,
        cwd: intent.cwd,
        shell: agent?.file ?? intent.shell,
        ...(agent ? { args: agent.args } : intent.args ? { args: intent.args } : {}),
        ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
        ...(browserTool ? { pathPrepend: browserTool.shimDir } : {}),
        cols: intent.cols,
        rows: intent.rows,
        title: intent.terminal.title,
      });
      if (this.deleted.has(intent.terminal.terminalId)) {
        this.stopQuietly(intent.terminal.terminalId);
        return;
      }
      await this.dispatchStatus(intent.terminal.terminalId, "running");
    } catch (error) {
      if (this.deleted.has(intent.terminal.terminalId)) return;
      await this.dispatchStatus(
        intent.terminal.terminalId,
        "failed",
        describeTerminalError(error, "Terminal startup failed."),
      );
    }
  }

  private async runWrite(terminalId: string, data: string): Promise<void> {
    try {
      this.service.write(TerminalId.parse(terminalId), data);
    } catch (error) {
      await this.dispatchStatus(
        terminalId,
        "failed",
        error instanceof Error ? error.message : "Terminal write failed.",
      );
    }
  }

  private async runResize(terminalId: string, cols: number, rows: number): Promise<void> {
    try {
      this.service.resize(TerminalId.parse(terminalId), cols, rows);
    } catch (error) {
      await this.dispatchStatus(
        terminalId,
        "failed",
        error instanceof Error ? error.message : "Terminal resize failed.",
      );
    }
  }

  private async runStop(terminalId: string): Promise<void> {
    try {
      this.service.stop(TerminalId.parse(terminalId));
    } catch (error) {
      await this.dispatchStatus(terminalId, "failed", error instanceof Error ? error.message : "Terminal stop failed.");
    }
  }

  private forget(terminalId: string): void {
    this.deleted.add(terminalId);
    this.intents.delete(terminalId);
    this.stopQuietly(terminalId);
  }

  private stopQuietly(terminalId: string): void {
    try {
      this.service.stop(TerminalId.parse(terminalId));
    } catch {
      // Not started yet, or already gone.
    }
  }

  private async agentCommand(agent: TerminalAgentLaunch, worktreeId: string): Promise<AgentCommand> {
    const args = buildAgentArgs(agent);
    let file: string | undefined;
    try {
      file = await this.options.resolveAgentCli?.(agent.provider);
    } catch {
      file = undefined;
    }
    if (!file) throw new AgentLaunchError(agentCliMissingMessage(agent.provider));
    const specs = this.mcpSpecs(worktreeId);
    if (specs.length === 0) return { file, args, env: {} };
    const mcp = await this.mcpLaunch(specs, agent, worktreeId);
    return { file, args: [...args, ...mcp.args], env: mcp.env };
  }

  private mcpSpecs(worktreeId: string): McpServerSpec[] {
    const browserTool = this.options.browserTool;
    let added: readonly McpServerSpec[] = [];
    try {
      added = this.options.mcpServers?.() ?? [];
    } catch {
      added = [];
    }
    return [...(browserTool ? zliMcpServerSpecs(browserTool, worktreeId) : []), ...added];
  }

  /** MCP servers are extras; a failure to prepare them never blocks the agent from starting. */
  private async mcpLaunch(
    specs: readonly McpServerSpec[],
    agent: TerminalAgentLaunch,
    worktreeId: string,
  ): Promise<{ args: string[]; env: Record<string, string> }> {
    const kind = mcpConfigFileKind(agent.provider);
    const dir = this.options.browserTool?.mcpConfigDir ?? this.options.mcpConfigDir;
    let configFile: string | undefined;
    if (kind && dir) {
      try {
        configFile = await (this.options.writeMcpConfig ?? writeAgentMcpConfig)(dir, kind, worktreeId, specs);
      } catch {
        configFile = undefined;
      }
    }
    const env: Record<string, string> = {};
    if (agent.provider === "opencode") {
      const content = opencodeConfigContent(specs, (this.options.env ?? process.env).OPENCODE_CONFIG_CONTENT);
      if (content) env.OPENCODE_CONFIG_CONTENT = content;
    }
    return { args: mcpLaunchArgs(agent.provider, { specs, ...(configFile ? { configFile } : {}) }), env };
  }

  private async worktreePath(worktreeId: string): Promise<string | undefined> {
    const projection = await this.engine.projection();
    return projection.worktrees.find((candidate) => candidate.worktreeId === worktreeId)?.path;
  }

  private dispatchStatus(
    terminalId: string,
    status: "running" | "exited" | "failed",
    errorMessage?: string,
    _exitCode?: number,
  ): Promise<void> {
    return this.engine
      .dispatchPromise({
        protocolVersion: 1,
        commandId: CommandId.parse(randomUUID()),
        command: {
          type: "terminal.status",
          terminalId: TerminalId.parse(terminalId),
          status,
          ...(errorMessage ? { errorMessage } : {}),
          ...(status === "exited" ? { lastSequence: this.service.get(TerminalId.parse(terminalId)).lastSequence } : {}),
        },
      })
      .then(() => undefined);
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }
}

function describeTerminalError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const cause =
    error.cause instanceof Error ? error.cause.message : typeof error.cause === "string" ? error.cause : undefined;
  return cause && !error.message.endsWith(`(${cause})`) ? `${error.message} (${cause})` : error.message;
}
