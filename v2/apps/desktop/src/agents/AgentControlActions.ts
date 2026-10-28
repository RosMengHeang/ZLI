import { randomUUID } from "node:crypto";

import {
  AgentControlAction,
  AgentControlConnectInput,
  AgentControlListInput,
  AgentControlReadInput,
  AgentControlSendInput,
  AgentControlStartInput,
  type AgentControlTarget,
  type AgentToolAccess,
  type AgentToolScope,
  agentNameKey,
  agentNameTaken,
  catalogEntryServer,
  isHttpServer,
  isListedTerminalStatus,
  isListedThreadStatus,
  MCP_CATALOG,
  McpListResult,
  type ProjectProjection,
  READ_AGENT_CONTROL_ACTIONS,
  type RpcResponse,
  type RuntimeProjection,
  TerminalReadResult,
  type WorktreeProjection,
} from "@zli-v2/contracts";

import {
  type BrowserControlDispatch,
  BrowserControlError,
  resolveBrowserControlWorktree,
} from "../browser/BrowserControlActions.js";

const MAX_MESSAGE_CHARS = 4_000;
const DEFAULT_READ_LIMIT = 20;

export type AgentControlHost = {
  projection(): RuntimeProjection | undefined;
  /** Calls the listener after every projection change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Sends one runtime RPC request. */
  command(request: { protocolVersion: 1; commandId: string; command: Record<string, unknown> }): Promise<RpcResponse>;
  readonly platform?: NodeJS.Platform;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly newId?: () => string;
  /** How long a start waits for the worktree and then the agent to be ready. */
  readonly startTimeoutMs?: number;
  /** How long an agent CLI gets to draw its prompt before the first message is typed into it. */
  readonly terminalPromptDelayMs?: number;
  /** Tells the person an agent wants a service connected. connectorId is a catalog id or a server name. */
  askToConnect?(request: { title: string; body: string; connectorId: string }): void;
};

export type AgentSummary = {
  id: string;
  /** The name the person gave the agent, which the other tools take in place of the id. */
  name?: string;
  kind: "chat" | "terminal";
  provider: string;
  providerName: string;
  status: string;
  branch: string;
  worktreeId: string;
  /** The name of the project the agent works in. */
  project: string;
  projectId: string;
  /** The agent works in the same worktree as the caller. */
  sameWorktree: boolean;
  model?: string;
};

type Agent = AgentSummary & { createdAt: string };

type AgentSettings = { access: AgentToolAccess; scope: AgentToolScope };

export function isAgentControlAction(action: string): boolean {
  return AgentControlAction.safeParse(action).success;
}

/**
 * Lets an agent see, read, start, and message the other agents in its project, and, when Settings
 * allow it, list, read, and message agents in other projects. Settings are read on every call, so a
 * change applies to agents that are already running.
 */
export function createAgentControlActions(host: AgentControlHost): BrowserControlDispatch {
  const platform = host.platform ?? process.platform;
  const sleep =
    host.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const newId = host.newId ?? randomUUID;
  const startTimeoutMs = host.startTimeoutMs ?? 120_000;
  const terminalPromptDelayMs = host.terminalPromptDelayMs ?? 3_000;

  const run = async (command: Record<string, unknown>): Promise<unknown> => {
    let response: RpcResponse;
    try {
      response = await host.command({ protocolVersion: 1, commandId: newId(), command });
    } catch (cause) {
      throw new BrowserControlError(
        `ZLI's runtime did not answer: ${cause instanceof Error ? cause.message : String(cause)}`,
        503,
      );
    }
    if (!response.accepted) throw new BrowserControlError(response.error.message, 409);
    return response.result;
  };

  const currentSettings = async (): Promise<AgentSettings> => {
    const listed = McpListResult.parse(await run({ type: "mcp.list" }));
    return { access: listed.agentAccess, scope: listed.agentScope };
  };

  const projection = (): RuntimeProjection => {
    const current = host.projection();
    if (!current) throw new BrowserControlError("ZLI is still starting. Try again in a moment.", 503);
    return current;
  };

  const caller = (input: AgentControlTarget, state: RuntimeProjection) => {
    const worktree = resolveBrowserControlWorktree(input, state.worktrees, platform);
    const full = state.worktrees.find(
      (candidate) => candidate.worktreeId === worktree.worktreeId,
    ) as WorktreeProjection;
    const project = state.projects.find((candidate) => candidate.projectId === full.projectId);
    if (!project) throw new BrowserControlError("The worktree this agent works in has no ZLI project.", 404);
    return { worktree: full, project };
  };

  const providerName = (state: RuntimeProjection, provider: string) =>
    state.providers?.find((entry) => entry.provider === provider)?.displayName ?? provider;

  /** Listed agents in the given projects, oldest first. */
  const agentsIn = (state: RuntimeProjection, projectIds: ReadonlySet<string>, callerWorktreeId: string): Agent[] => {
    const projects = new Map(state.projects.map((project) => [project.projectId, project]));
    const worktrees = new Map(
      state.worktrees
        .filter((worktree) => projectIds.has(worktree.projectId))
        .map((worktree) => [worktree.worktreeId, worktree]),
    );
    const placed = (worktree: WorktreeProjection) => ({
      branch: worktree.branch,
      worktreeId: worktree.worktreeId,
      project: projects.get(worktree.projectId)?.name ?? "",
      projectId: worktree.projectId,
      sameWorktree: worktree.worktreeId === callerWorktreeId,
    });
    const agents: Agent[] = [];
    for (const thread of state.threads) {
      const worktree = worktrees.get(thread.worktreeId);
      if (!worktree || !isListedThreadStatus(thread.status)) continue;
      agents.push({
        id: thread.threadId,
        ...(thread.name ? { name: thread.name } : {}),
        kind: "chat",
        provider: thread.provider,
        providerName: providerName(state, thread.provider),
        status: thread.status,
        ...placed(worktree),
        ...(thread.model ? { model: thread.model } : {}),
        createdAt: thread.createdAt ?? "",
      });
    }
    for (const terminal of state.terminals) {
      const worktree = worktrees.get(terminal.worktreeId);
      if (!worktree || !terminal.agent || !isListedTerminalStatus(terminal.status)) continue;
      agents.push({
        id: terminal.terminalId,
        ...(terminal.name ? { name: terminal.name } : {}),
        kind: "terminal",
        provider: terminal.agent.provider,
        providerName: providerName(state, terminal.agent.provider),
        status: terminal.status,
        ...placed(worktree),
        ...(terminal.agent.model ? { model: terminal.agent.model } : {}),
        createdAt: terminal.createdAt ?? "",
      });
    }
    return agents.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  };

  const projectAgents = (state: RuntimeProjection, projectId: string, callerWorktreeId: string): Agent[] =>
    agentsIn(state, new Set([projectId]), callerWorktreeId);

  const summary = ({ createdAt: _createdAt, ...agent }: Agent): AgentSummary => agent;

  const requireAllProjects = (settings: AgentSettings) => {
    if (settings.scope !== "all")
      throw new BrowserControlError(
        "ZLI Settings keep agents to their own project. The person can let agents reach every project in Settings, under Integrations.",
        403,
      );
  };

  /** A project by id, or by name without regard to case. */
  const findProject = (state: RuntimeProjection, ref: string): ProjectProjection => {
    const exact = state.projects.find((project) => project.projectId === ref);
    if (exact) return exact;
    const key = ref.toLocaleLowerCase();
    const named = state.projects.filter((project) => project.name.toLocaleLowerCase() === key);
    if (named.length === 1 && named[0]) return named[0];
    if (named.length > 1)
      throw new BrowserControlError(
        `More than one project is called ${ref}. Use the project id: ${named.map((project) => `${project.projectId} (${project.path})`).join(", ")}.`,
      );
    throw new BrowserControlError(
      `ZLI has no project called ${ref}. Call list_agents with allProjects for the project names.`,
      404,
    );
  };

  /** Exact id first, then name, then a unique id prefix, so a name can never hide an id. */
  const findAgent = (agents: readonly Agent[], ref: string, projectName: string): Agent => {
    const exact = agents.find((agent) => agent.id === ref);
    if (exact) return exact;
    const key = agentNameKey(ref);
    const named = agents.filter((agent) => agent.name !== undefined && agentNameKey(agent.name) === key);
    if (named.length === 1 && named[0]) return named[0];
    if (named.length > 1)
      throw new BrowserControlError(
        `More than one agent is called ${ref}. Use the id instead: ${named.map((agent) => agent.id).join(", ")}.`,
      );
    const matches = ref.length >= 4 ? agents.filter((agent) => agent.id.startsWith(ref)) : [];
    if (matches.length === 1 && matches[0]) return matches[0];
    if (matches.length > 1)
      throw new BrowserControlError(`More than one agent id starts with ${ref}. Use the full id.`);
    throw new BrowserControlError(
      `Project ${projectName} has no running agent ${ref}. Call list_agents for the names and ids.`,
      404,
    );
  };

  /**
   * Finds the agent a read or send is about. `project/agent` and the project field both point at
   * another project, which Settings have to allow.
   */
  const target = (
    state: RuntimeProjection,
    input: AgentControlReadInput | AgentControlSendInput,
    settings: AgentSettings,
  ) => {
    const from = caller(input, state);
    let agentRef = input.agent;
    let projectRef = input.project;
    if (agentRef.includes("/")) {
      const parts = agentRef.split("/").map((part) => part.trim());
      if (parts.length !== 2 || !parts[0] || !parts[1])
        throw new BrowserControlError("Write an agent in another project as project/agent, such as api/bob.");
      if (projectRef !== undefined && projectRef.toLocaleLowerCase() !== parts[0].toLocaleLowerCase())
        throw new BrowserControlError(
          `${agentRef} points at project ${parts[0]}, but project is ${projectRef}. Give the project in one place.`,
        );
      [projectRef, agentRef] = parts as [string, string];
    }
    const project = projectRef === undefined ? from.project : findProject(state, projectRef);
    const crossProject = project.projectId !== from.project.projectId;
    if (crossProject) requireAllProjects(settings);
    const agents = projectAgents(state, project.projectId, from.worktree.worktreeId);
    return { ...from, agent: findAgent(agents, agentRef, project.name), crossProject };
  };

  /** Resolves once `pick` returns a value, rejects when it throws or time runs out. */
  const waitFor = <T>(pick: (state: RuntimeProjection) => T | undefined, what: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      let unsubscribe: () => void = () => undefined;
      let done = false;
      const finish = () => {
        done = true;
        clearTimeout(timer);
        unsubscribe();
      };
      const check = () => {
        if (done) return;
        const state = host.projection();
        if (!state) return;
        try {
          const value = pick(state);
          if (value === undefined) return;
          finish();
          resolve(value);
        } catch (cause) {
          finish();
          reject(cause);
        }
      };
      const timer = setTimeout(() => {
        finish();
        reject(new BrowserControlError(`${what} took longer than ${Math.round(startTimeoutMs / 1000)} seconds.`, 504));
      }, startTimeoutMs);
      check();
      if (!done) unsubscribe = host.subscribe(check);
    });

  const typeIntoTerminal = async (terminalId: string, text: string) => {
    const body = /[\r\n]/u.test(text) ? `\u001b[200~${text}\u001b[201~` : text;
    await run({ type: "terminal.write", terminalId, data: body });
    // Agent CLIs treat text and Enter that arrive in one read as a paste, which would not submit.
    await sleep(150);
    await run({ type: "terminal.write", terminalId, data: "\r" });
  };

  const list = async (raw: unknown, settings: AgentSettings) => {
    const input = AgentControlListInput.parse(raw);
    const state = projection();
    const { worktree, project } = caller(input, state);
    if (!input.allProjects)
      return {
        project: project.name,
        yourBranch: worktree.branch,
        agents: projectAgents(state, project.projectId, worktree.worktreeId).map(summary),
      };
    requireAllProjects(settings);
    const order = (agent: Agent) => (agent.projectId === project.projectId ? "" : agent.project.toLocaleLowerCase());
    const agents = agentsIn(state, new Set(state.projects.map((entry) => entry.projectId)), worktree.worktreeId);
    return {
      project: project.name,
      yourBranch: worktree.branch,
      // Stable sort: the caller's project first, then the others by name, each oldest agent first.
      agents: agents.sort((left, right) => order(left).localeCompare(order(right))).map(summary),
    };
  };

  const read = async (raw: unknown, settings: AgentSettings) => {
    const input = AgentControlReadInput.parse(raw);
    const state = projection();
    const { agent } = target(state, input, settings);
    if (agent.kind === "terminal") {
      const output = TerminalReadResult.parse(await run({ type: "terminal.read", terminalId: agent.id }));
      return { agent: summary(agent), output: output.text, truncated: output.truncated };
    }
    const messages = (state.messages ?? []).filter((message) => message.threadId === agent.id);
    const limit = input.limit ?? DEFAULT_READ_LIMIT;
    return {
      agent: summary(agent),
      messages: messages.slice(-limit).map((message) => ({
        role: message.role,
        text: message.text.length > MAX_MESSAGE_CHARS ? `${message.text.slice(0, MAX_MESSAGE_CHARS)}...` : message.text,
      })),
      truncated: messages.length > limit,
    };
  };

  const send = async (raw: unknown, settings: AgentSettings) => {
    const input = AgentControlSendInput.parse(raw);
    const state = projection();
    const { worktree, project, agent, crossProject } = target(state, input, settings);
    const neighbors = projectAgents(state, project.projectId, worktree.worktreeId).filter(
      (candidate) => candidate.sameWorktree,
    );
    if (agent.sameWorktree && neighbors.length === 1)
      throw new BrowserControlError("That agent is you. Pick another agent from list_agents.");
    const sender = neighbors.length === 1 ? neighbors[0] : undefined;
    const text = [
      messageHeading({ sender, project: project.name, branch: worktree.branch, crossProject }),
      "",
      input.text,
    ].join("\n");
    if (agent.kind === "terminal") {
      if (agent.status !== "running")
        throw new BrowserControlError("That terminal agent is still starting. Try again shortly.", 409);
      await typeIntoTerminal(agent.id, text);
      return { delivered: true, agent: summary(agent) };
    }
    if (agent.status === "failed") throw new BrowserControlError("That agent failed and cannot take messages.", 409);
    if (agent.status === "starting")
      await waitFor((next) => {
        const thread = next.threads.find((candidate) => candidate.threadId === agent.id);
        if (thread?.status === "failed" || thread?.status === "stopped")
          throw new BrowserControlError("That agent stopped before it could take the message.", 409);
        return thread?.status === "idle" ? true : undefined;
      }, "Waiting for that agent to start");
    const busy = agent.status === "working" || agent.status === "waiting";
    await run({ type: "thread.queue", queueId: newId(), threadId: agent.id, text });
    return busy
      ? { delivered: false, queued: true, agent: summary(agent) }
      : { delivered: true, agent: summary(agent) };
  };

  const start = async (raw: unknown) => {
    const input = AgentControlStartInput.parse(raw);
    const state = projection();
    const { worktree: callerWorktree, project } = caller(input, state);
    const discovery = state.providers?.find((entry) => entry.provider === input.provider);
    if (discovery?.status === "missing")
      throw new BrowserControlError(`${discovery.displayName} is not installed here. ${discovery.reason}`, 409);
    // Checked before a worktree is made, so a taken name does not leave an empty worktree behind.
    if (input.name !== undefined && agentNameTaken(state, { projectId: project.projectId, name: input.name }))
      throw new BrowserControlError(
        `Another agent in this project is already called ${input.name}. Pick a different name.`,
        409,
      );

    let target: WorktreeProjection;
    if (input.worktree === "same") target = callerWorktree;
    else {
      const branch = safeBranchName(input.branch ?? `${input.provider}-${newId().slice(0, 6)}`);
      if (!branch) throw new BrowserControlError("Choose a branch name with letters or digits.");
      const worktreeId = newId();
      const workspaceRoot = `${project.path.replace(/[\\/]+$/u, "")}-worktrees`;
      await run({
        type: "worktree.create",
        worktreeId,
        projectId: project.projectId,
        path: `${workspaceRoot}/${branch.replace(/[\\/]/gu, "-")}`,
        workspaceRoot,
        branch,
        baseRef: callerWorktree.branch,
      });
      target = await waitFor((next) => {
        const created = next.worktrees.find((candidate) => candidate.worktreeId === worktreeId);
        if (created?.status === "failed" || created?.status === "cancelled")
          throw new BrowserControlError(`The worktree could not be created. ${created.errorMessage ?? ""}`.trim(), 409);
        return created?.status === "ready" ? created : undefined;
      }, "Creating the worktree");
    }

    const sessionId = newId();
    const mode = input.mode ?? "chat";
    let agentId: string;
    if (mode === "chat") {
      agentId = newId();
      const shared = state.threads.some(
        (thread) =>
          thread.worktreeId === target.worktreeId && ["starting", "idle", "working", "waiting"].includes(thread.status),
      );
      await run({
        type: "thread.start",
        threadId: agentId,
        worktreeId: target.worktreeId,
        provider: input.provider,
        cwd: target.path,
        sessionId,
        permissionMode: "full-access",
        ...(input.model ? { model: input.model } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(shared ? { shareWorktree: true } : {}),
      });
      await waitFor((next) => {
        const thread = next.threads.find((candidate) => candidate.threadId === agentId);
        if (thread?.status === "failed" || thread?.status === "stopped")
          throw new BrowserControlError(`The agent did not start. ${thread.errorMessage ?? ""}`.trim(), 409);
        return thread?.status === "idle" ? true : undefined;
      }, "Starting the agent");
      await run({ type: "thread.send", threadId: agentId, text: input.prompt });
    } else {
      agentId = newId();
      await run({
        type: "terminal.create",
        terminalId: agentId,
        worktreeId: target.worktreeId,
        cwd: target.path,
        shell: platform === "win32" ? "powershell.exe" : "/bin/bash",
        title: providerName(state, input.provider),
        cols: 120,
        rows: 32,
        sessionId,
        ...(input.name !== undefined ? { name: input.name } : {}),
        agent: {
          provider: input.provider,
          permissionMode: "full-access",
          ...(input.model ? { model: input.model } : {}),
        },
      });
      await waitFor((next) => {
        const terminal = next.terminals.find((candidate) => candidate.terminalId === agentId);
        if (terminal?.status === "failed" || terminal?.status === "exited")
          throw new BrowserControlError(`The agent did not start. ${terminal.errorMessage ?? ""}`.trim(), 409);
        return terminal?.status === "running" ? true : undefined;
      }, "Starting the agent");
      await sleep(terminalPromptDelayMs);
      await typeIntoTerminal(agentId, input.prompt);
    }
    const started = projectAgents(projection(), project.projectId, callerWorktree.worktreeId).find(
      (agent) => agent.id === agentId,
    );
    return {
      started: true,
      agent: started
        ? summary(started)
        : {
            id: agentId,
            ...(input.name !== undefined ? { name: input.name } : {}),
            kind: mode,
            provider: input.provider,
            branch: target.branch,
            worktreeId: target.worktreeId,
            project: project.name,
            projectId: project.projectId,
          },
      worktree: { branch: target.branch, path: target.path },
    };
  };

  const connect = async (raw: unknown) => {
    const input = AgentControlConnectInput.parse(raw);
    const key = input.service.toLowerCase();
    const listed = McpListResult.parse(await run({ type: "mcp.list" }));
    const entry = MCP_CATALOG.find((candidate) => candidate.id === key || candidate.title.toLowerCase() === key);
    const server = entry
      ? catalogEntryServer(entry, listed.servers)
      : listed.servers.find((candidate) => candidate.name.toLowerCase() === key);
    if (!entry && !server)
      throw new BrowserControlError(
        `ZLI has no connector called ${input.service}. Use one of: ${MCP_CATALOG.map((candidate) => candidate.id).join(", ")}.`,
        404,
      );
    const title = entry?.title ?? server?.name ?? input.service;
    const connector = entry?.id ?? server?.name ?? input.service;
    const signedIn = server ? listed.signIns.find((state) => state.name === server.name)?.signedIn === true : false;
    const needsSignIn = server?.enabled === true && isHttpServer(server) && server.oauth && !signedIn;
    if (server?.enabled && !needsSignIn)
      return {
        status: "connected",
        connector,
        message: `${title} is already connected in ZLI. If its tools are missing here, it was added after this session started, so start a new session to use it.`,
      };

    let agentName = "An agent";
    let projectName: string | undefined;
    const state = host.projection();
    if (state) {
      try {
        const { worktree, project } = caller(input, state);
        projectName = project.name;
        const neighbors = projectAgents(state, project.projectId, worktree.worktreeId).filter(
          (agent) => agent.sameWorktree,
        );
        if (neighbors.length === 1 && neighbors[0]) agentName = neighbors[0].name ?? neighbors[0].providerName;
      } catch {
        // An agent outside a ZLI worktree can still ask; the notification just names less.
      }
    }
    const ask = needsSignIn ? `asks you to sign in to ${title}` : `asks to connect ${title}`;
    host.askToConnect?.({
      title: projectName ?? "ZLI",
      body: `${agentName} ${ask}.${input.reason ? ` ${input.reason}` : ""}`,
      connectorId: connector,
    });
    return needsSignIn
      ? {
          status: "asked",
          connector,
          message: `Asked the person to sign in to ${title} in ZLI. Once they sign in, try again.`,
        }
      : {
          status: "asked",
          connector,
          message: `Asked the person to connect ${title} in ZLI. Once they connect, start a new session to use it.`,
        };
  };

  const handlers: Record<AgentControlAction, (input: unknown, settings: AgentSettings) => Promise<unknown>> = {
    agentaccess: async (_input, settings) => settings,
    agentlist: list,
    agentread: read,
    agentsend: send,
    agentstart: start,
    agentconnect: connect,
  };

  return async (action, input) => {
    const parsed = AgentControlAction.safeParse(action);
    if (!parsed.success) throw new BrowserControlError(`Unknown agent action: ${action}`, 404);
    const settings = await currentSettings();
    if (parsed.data !== "agentaccess") {
      if (settings.access === "off")
        throw new BrowserControlError("Agent tools are turned off in ZLI Settings, under Integrations.", 403);
      if (settings.access === "read" && !READ_AGENT_CONTROL_ACTIONS.includes(parsed.data))
        throw new BrowserControlError(
          "ZLI Settings let agents list and read other agents, but not start or message them.",
          403,
        );
    }
    return handlers[parsed.data](input ?? {}, settings);
  };
}

/**
 * The first line of a message from another agent. It says who sent it and how to answer: by name
 * when the sender has one, and as project/agent from another project.
 */
function messageHeading(options: {
  sender: Agent | undefined;
  project: string;
  branch: string;
  crossProject: boolean;
}): string {
  const { sender, project, branch, crossProject } = options;
  const who = `${sender?.name ? `${sender.name}, ` : ""}${crossProject ? `an agent in the ZLI project ${project}` : "another agent in ZLI"}`;
  const reply = !sender
    ? ""
    : crossProject
      ? ` (reply to ${project}/${sender.name ?? sender.id})`
      : sender.name
        ? ` (reply to ${sender.name})`
        : ` (agent id ${sender.id})`;
  return `Message from ${who}, working on branch ${branch}${reply}:`;
}

export function safeBranchName(branch: string): string {
  return branch
    .trim()
    .replace(/[^a-zA-Z0-9._/-]/gu, "-")
    .replace(/^[-/]+|[-/]+$/gu, "");
}
