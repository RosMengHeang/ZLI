import { randomUUID } from "node:crypto";

import {
  AgentControlAction,
  AgentControlConnectInput,
  AgentControlHuddleDecisionsInput,
  AgentControlHuddlePostInput,
  AgentControlHuddleReadInput,
  AgentControlHuddleWaitInput,
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
  HUDDLE_AGENT_STREAK_LIMIT,
  type HuddlePost,
  type HuddleProjection,
  huddleAgentInfo,
  huddlePostsOf,
  huddlesOf,
  isHttpServer,
  isListedTerminalStatus,
  isListedThreadStatus,
  MCP_CATALOG,
  McpListResult,
  type PermissionMode,
  type ProjectProjection,
  READ_AGENT_CONTROL_ACTIONS,
  type RpcResponse,
  type RuntimeProjection,
  shortHuddleId,
  TerminalReadResult,
  type WorktreeProjection,
} from "@zli-v2/contracts";

import {
  type BrowserControlDispatch,
  BrowserControlError,
  resolveBrowserControlWorktree,
} from "../browser/BrowserControlActions.js";

const MAX_MESSAGE_CHARS = 4_000;
const STRICTEST_FIRST: readonly PermissionMode[] = ["read-only", "supervised", "full-access"];
const LIVE_THREAD = ["starting", "idle", "working", "waiting"];
const DEFAULT_READ_LIMIT = 20;
const MAX_HUDDLE_READ = 50;
const DEFAULT_HUDDLE_WAIT_SECONDS = 120;

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
  /** The agent that started this one with start_agent, which makes this one its sub-agent. */
  startedBy?: { id: string; name?: string };
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

  /**
   * The caller is known only by its worktree, so a started agent gets the strictest mode of the agents
   * working there. Agents from before permission modes existed ran with full access.
   */
  const callerPermission = (state: RuntimeProjection, worktreeId: string): PermissionMode => {
    const modes = [
      ...state.threads
        .filter((thread) => thread.worktreeId === worktreeId && LIVE_THREAD.includes(thread.status))
        .map((thread) => thread.permissionMode ?? "full-access"),
      ...state.terminals
        .filter(
          (terminal) =>
            terminal.worktreeId === worktreeId &&
            terminal.kind === "agent" &&
            (terminal.status === "running" || terminal.status === "starting"),
        )
        .map((terminal) => terminal.agent?.permissionMode ?? "full-access"),
    ];
    return STRICTEST_FIRST.find((mode) => modes.includes(mode)) ?? "supervised";
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
    const names = new Map<string, string | undefined>([
      ...state.threads.map((thread) => [thread.threadId, thread.name] as const),
      ...state.terminals.map((terminal) => [terminal.terminalId, terminal.name] as const),
    ]);
    const parent = (startedBy: string | undefined) => {
      if (startedBy === undefined) return {};
      const name = names.get(startedBy);
      return { startedBy: { id: startedBy, ...(name ? { name } : {}) } };
    };
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
        ...parent(thread.startedBy),
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
        ...parent(terminal.startedBy),
        createdAt: terminal.createdAt ?? "",
      });
    }
    return agents.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  };

  const projectAgents = (state: RuntimeProjection, projectId: string, callerWorktreeId: string): Agent[] =>
    agentsIn(state, new Set([projectId]), callerWorktreeId);

  const summary = ({ createdAt: _createdAt, ...agent }: Agent): AgentSummary => agent;

  /**
   * The agent making the call. Tools know only the caller's worktree, so without `as` this is the one
   * listed agent there, and undefined when agents share it. `as` picks among the agents in that
   * worktree only, so an agent cannot sign as one working elsewhere.
   */
  const callerAgent = (
    state: RuntimeProjection,
    project: ProjectProjection,
    worktreeId: string,
    as?: string,
  ): { agent: Agent | undefined; shared: boolean } => {
    const here = projectAgents(state, project.projectId, worktreeId).filter((agent) => agent.sameWorktree);
    if (as === undefined) return { agent: here.length === 1 ? here[0] : undefined, shared: here.length > 1 };
    return {
      agent: findAgent(
        here,
        as,
        project.name,
        `No agent in your worktree is called ${as}. Pass your own name or id: one of the agents list_agents marks sameWorktree.`,
      ),
      shared: here.length > 1,
    };
  };

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
  const findAgent = (agents: readonly Agent[], ref: string, projectName: string, missing?: string): Agent => {
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
      missing ?? `Project ${projectName} has no running agent ${ref}. Call list_agents for the names and ids.`,
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
    const { agent: sender, shared } = callerAgent(state, project, worktree.worktreeId, input.as);
    if (sender && agent.id === sender.id)
      throw new BrowserControlError("That agent is you. Pick another agent from list_agents.");
    const note =
      !sender && shared
        ? "Other agents share your worktree, so ZLI could not tell which one you are and sent this without your name. Pass as with your own name or id to sign it."
        : undefined;
    const relation =
      sender && agent.startedBy?.id === sender.id
        ? "parent"
        : sender && sender.startedBy?.id === agent.id
          ? "sub-agent"
          : undefined;
    const text = [
      messageHeading({ sender, project: project.name, where: workPlace(project, worktree), crossProject, relation }),
      "",
      input.text,
    ].join("\n");
    if (agent.kind === "terminal") {
      if (agent.status !== "running")
        throw new BrowserControlError("That terminal agent is still starting. Try again shortly.", 409);
      await typeIntoTerminal(agent.id, text);
      return { delivered: true, agent: summary(agent), ...(note ? { note } : {}) };
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
    return {
      ...(busy ? { delivered: false, queued: true } : { delivered: true }),
      agent: summary(agent),
      ...(note ? { note } : {}),
    };
  };

  /** Starts an agent and waits until it can take its first message. */
  const launch = async (input: Omit<AgentControlStartInput, "prompt">) => {
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

    // A plain folder has no Git, so no worktrees: its agents all work in the folder itself.
    const plainFolder = project.git === false;
    if (plainFolder && (input.worktree === "new" || input.branch !== undefined))
      throw new BrowserControlError(
        `${project.name} is a folder without Git, so it has no worktrees or branches. Leave out worktree and branch, and the agent starts in the folder itself.`,
      );
    const { agent: parent, shared } = callerAgent(state, project, callerWorktree.worktreeId, input.as);
    const note =
      !parent && shared
        ? "Other agents share your worktree, so ZLI could not tell which one you are and did not record the new agent as your sub-agent. Pass as with your own name or id to link it."
        : undefined;

    let target: WorktreeProjection;
    if (input.worktree === "same" || plainFolder) target = callerWorktree;
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
    const agentId = newId();
    const permissionMode = callerPermission(state, callerWorktree.worktreeId);
    if (mode === "chat") {
      const occupied = state.threads.some(
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
        permissionMode,
        ...(input.model ? { model: input.model } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(parent ? { startedBy: parent.id } : {}),
        ...(occupied ? { shareWorktree: true } : {}),
      });
      await waitFor((next) => {
        const thread = next.threads.find((candidate) => candidate.threadId === agentId);
        if (thread?.status === "failed" || thread?.status === "stopped")
          throw new BrowserControlError(`The agent did not start. ${thread.errorMessage ?? ""}`.trim(), 409);
        return thread?.status === "idle" ? true : undefined;
      }, "Starting the agent");
    } else {
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
        ...(parent ? { startedBy: parent.id } : {}),
        agent: {
          provider: input.provider,
          permissionMode,
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
    }
    return { agentId, mode, target, project, callerWorktree, parent, note };
  };

  const start = async (raw: unknown) => {
    const input = AgentControlStartInput.parse(raw);
    const { agentId, mode, target, project, callerWorktree, parent, note } = await launch(input);
    const task = parent
      ? [
          taskHeading({
            parent,
            where: workPlace(project, callerWorktree),
            self: input.name ?? agentId,
            sharesWorktree: target.worktreeId === callerWorktree.worktreeId,
          }),
          "",
          input.prompt,
        ].join("\n")
      : input.prompt;
    if (mode === "chat") await run({ type: "thread.send", threadId: agentId, text: task });
    else await typeIntoTerminal(agentId, task);
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
      ...(note ? { note } : {}),
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
        const self = callerAgent(state, project, worktree.worktreeId).agent;
        if (self) agentName = self.name ?? self.providerName;
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

  /**
   * What each agent last read in each huddle, by huddle and agent id. Kept in memory, since a restart
   * only means an agent reads a few messages again.
   */
  const huddleCursors = new Map<string, number>();

  /** The calling agent. Huddle tools act for one member, so the caller has to be known. */
  const huddleCaller = (state: RuntimeProjection, input: AgentControlTarget & { as?: string | undefined }) => {
    const { worktree, project } = caller(input, state);
    const { agent, shared } = callerAgent(state, project, worktree.worktreeId, input.as);
    if (!agent)
      throw new BrowserControlError(
        shared
          ? "Other agents share your worktree, so ZLI cannot tell which one you are. Pass as with your own name or id."
          : "ZLI found no agent of yours in this worktree, so it cannot tell which huddles you are in.",
      );
    return { worktree, project, agent };
  };

  /** One of the caller's huddles. Being taken out of a huddle ends access to it at once. */
  const pickHuddle = (state: RuntimeProjection, agent: Agent, ref: string | undefined): HuddleProjection => {
    const mine = huddlesOf(state, agent.id);
    const listed = (huddles: readonly HuddleProjection[]) =>
      huddles.map((huddle) => `${huddle.name} (${shortHuddleId(huddle.huddleId)})`).join(", ");
    if (ref === undefined) {
      if (mine.length === 1 && mine[0]) return mine[0];
      if (mine.length === 0)
        throw new BrowserControlError("You are not in a huddle. The person adds agents to huddles in ZLI.", 404);
      throw new BrowserControlError(`You are in more than one huddle. Pass huddle with one of: ${listed(mine)}.`);
    }
    const key = ref.toLocaleLowerCase();
    const matching = (huddles: readonly HuddleProjection[]) =>
      huddles.filter(
        (huddle) =>
          huddle.huddleId === ref ||
          huddle.name.toLocaleLowerCase() === key ||
          (ref.length >= 4 && huddle.huddleId.startsWith(ref)),
      );
    const found = matching(mine);
    if (found.length === 1 && found[0]) return found[0];
    if (found.length > 1)
      throw new BrowserControlError(`More than one of your huddles matches ${ref}: ${listed(found)}. Use the id.`);
    if (matching(state.huddles ?? []).length > 0)
      throw new BrowserControlError(`You are not in the huddle ${ref}, so you cannot read or post there.`, 403);
    throw new BrowserControlError(
      mine.length > 0 ? `You have no huddle called ${ref}. Yours: ${listed(mine)}.` : `ZLI has no huddle ${ref}.`,
      404,
    );
  };

  /** A member as the reader should write it: project/name when it works in another project. */
  const memberLabel = (state: RuntimeProjection, agentId: string, reader: Agent) => {
    const info = huddleAgentInfo(state, agentId);
    if (!info) return "an agent that has left";
    return info.projectId !== undefined && info.projectId !== reader.projectId && info.projectName
      ? `${info.projectName}/${info.label}`
      : info.label;
  };

  const describePost = (state: RuntimeProjection, post: HuddlePost, posts: readonly HuddlePost[], reader: Agent) => {
    const answers = post.replyTo ? posts.find((candidate) => candidate.postId === post.replyTo)?.number : undefined;
    return {
      number: post.number,
      from:
        post.from.kind === "person"
          ? "the person"
          : post.from.agentId === reader.id
            ? "you"
            : memberLabel(state, post.from.agentId, reader),
      to:
        post.to === "everyone"
          ? "everyone"
          : post.to === "person"
            ? "the person"
            : post.to.map((agentId) => (agentId === reader.id ? "you" : memberLabel(state, agentId, reader))),
      kind: post.kind,
      text: post.text,
      ...(answers !== undefined ? { answers } : {}),
      ...(post.decision ? { decision: true } : {}),
      ...(post.cut ? { cut: "Cut at 2,000 characters. read_agent shows the whole answer." } : {}),
    };
  };

  const describeHuddle = (state: RuntimeProjection, huddle: HuddleProjection, reader: Agent) => ({
    huddle: huddle.name,
    id: shortHuddleId(huddle.huddleId),
    members: huddle.members.map((member) => ({
      name: memberLabel(state, member.agentId, reader),
      id: member.agentId,
      kind: member.kind,
      status: huddleAgentInfo(state, member.agentId)?.status ?? "gone",
      ...(member.agentId === reader.id ? { you: true } : {}),
    })),
    ...(huddle.paused
      ? {
          paused:
            "Agents wrote 12 messages in a row, so their messages are held until the person writes or resumes. Wait for the person instead of posting more.",
        }
      : {}),
  });

  /** Messages after `after`, newest last, and moves the reader's place to the end. */
  const readFrom = (state: RuntimeProjection, huddle: HuddleProjection, reader: Agent, after: number) => {
    const posts = huddlePostsOf(state, huddle.huddleId);
    const chosen = posts.filter((post) => post.number > after);
    const shown = chosen.slice(-MAX_HUDDLE_READ);
    const last = posts.at(-1);
    if (last) huddleCursors.set(`${huddle.huddleId}:${reader.id}`, last.number);
    return {
      ...describeHuddle(state, huddle, reader),
      messages: shown.map((post) => describePost(state, post, posts, reader)),
      ...(chosen.length > shown.length ? { earlierNotShown: chosen.length - shown.length } : {}),
    };
  };

  const huddleRead = async (raw: unknown) => {
    const input = AgentControlHuddleReadInput.parse(raw);
    const state = projection();
    const { agent } = huddleCaller(state, input);
    const huddle = pickHuddle(state, agent, input.huddle);
    return readFrom(state, huddle, agent, input.all ? 0 : (huddleCursors.get(`${huddle.huddleId}:${agent.id}`) ?? 0));
  };

  const huddleWait = async (raw: unknown) => {
    const input = AgentControlHuddleWaitInput.parse(raw);
    const state = projection();
    const { agent } = huddleCaller(state, input);
    const huddle = pickHuddle(state, agent, input.huddle);
    const after = huddleCursors.get(`${huddle.huddleId}:${agent.id}`) ?? 0;
    const timeoutMs = (input.timeoutSeconds ?? DEFAULT_HUDDLE_WAIT_SECONDS) * 1_000;
    const arrived = await new Promise<RuntimeProjection | undefined>((resolve, reject) => {
      let unsubscribe: () => void = () => undefined;
      let done = false;
      const finish = (value: RuntimeProjection | undefined, error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        if (error) reject(error);
        else resolve(value);
      };
      const check = () => {
        const next = host.projection();
        if (!next) return;
        if (!huddlesOf(next, agent.id).some((candidate) => candidate.huddleId === huddle.huddleId)) {
          finish(
            undefined,
            new BrowserControlError("You were taken out of the huddle, so you can no longer read it.", 403),
          );
          return;
        }
        const fresh = huddlePostsOf(next, huddle.huddleId).some(
          (post) => post.number > after && !(post.from.kind === "agent" && post.from.agentId === agent.id),
        );
        if (fresh) finish(next);
      };
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      check();
      if (!done) unsubscribe = host.subscribe(check);
    });
    if (!arrived)
      return {
        ...describeHuddle(projection(), huddle, agent),
        messages: [],
        timedOut: `Nobody else wrote in ${Math.round(timeoutMs / 1_000)} seconds.`,
      };
    const current = huddlesOf(arrived, agent.id).find((candidate) => candidate.huddleId === huddle.huddleId) ?? huddle;
    return readFrom(arrived, current, agent, after);
  };

  const huddleDecisions = async (raw: unknown) => {
    const input = AgentControlHuddleDecisionsInput.parse(raw);
    const state = projection();
    const { agent } = huddleCaller(state, input);
    const huddle = pickHuddle(state, agent, input.huddle);
    const posts = huddlePostsOf(state, huddle.huddleId);
    return {
      huddle: huddle.name,
      id: shortHuddleId(huddle.huddleId),
      decisions: posts.filter((post) => post.decision).map((post) => describePost(state, post, posts, agent)),
    };
  };

  const huddlePost = async (raw: unknown) => {
    const input = AgentControlHuddlePostInput.parse(raw);
    const state = projection();
    const { worktree, project, agent } = huddleCaller(state, input);
    const huddle = pickHuddle(state, agent, input.huddle);
    const memberIds = new Set(huddle.members.map((member) => member.agentId));
    const memberProjects = new Set(
      huddle.members.flatMap((member) => huddleAgentInfo(state, member.agentId)?.projectId ?? []),
    );
    const members = agentsIn(state, memberProjects, worktree.worktreeId).filter((candidate) =>
      memberIds.has(candidate.id),
    );
    const names = members
      .filter((member) => member.id !== agent.id)
      .map((member) => memberLabel(state, member.id, agent));
    // MCP clients send a list, so a list holding only "everyone" or "person" means that word.
    const asked =
      Array.isArray(input.to) && input.to.length === 1 && (input.to[0] === "everyone" || input.to[0] === "person")
        ? input.to[0]
        : input.to;
    let to: "everyone" | "person" | string[] =
      asked === undefined || asked === "everyone" || asked === "person"
        ? (asked ?? "everyone")
        : asked.map((ref) => {
            const local = ref.includes("/") ? (ref.split("/").at(-1) ?? ref).trim() : ref;
            const found = findAgent(
              members,
              local,
              project.name,
              `${ref} is not in the huddle ${huddle.name}. Its other members: ${names.join(", ") || "none yet"}.`,
            );
            if (found.id === agent.id) throw new BrowserControlError("That is you. Name another member of the huddle.");
            return found.id;
          });
    const kind = input.kind ?? (input.start ? "assign" : "note");
    let started: AgentSummary | undefined;
    if (input.start) {
      if (kind !== "assign")
        throw new BrowserControlError("start goes with kind assign: the message is the new agent's first task.");
      const {
        huddle: _huddle,
        text: _text,
        to: _to,
        kind: _kind,
        replyTo: _replyTo,
        start,
        as: _as,
        ...target
      } = input;
      const launched = await launch({ ...target, ...start, as: agent.id });
      await run({ type: "huddle.join", huddleId: huddle.huddleId, agentId: launched.agentId });
      to = Array.isArray(to) ? [...to, launched.agentId] : asked === undefined ? [launched.agentId] : to;
      const found = agentsIn(projection(), new Set([project.projectId]), worktree.worktreeId).find(
        (candidate) => candidate.id === launched.agentId,
      );
      if (found) started = summary(found);
    }
    const posts = huddlePostsOf(state, huddle.huddleId);
    const replyTo =
      input.replyTo === undefined ? undefined : posts.find((post) => post.number === input.replyTo)?.postId;
    if (input.replyTo !== undefined && replyTo === undefined)
      throw new BrowserControlError(`The huddle has no message ${input.replyTo}. huddle_read lists them.`, 404);
    const postId = newId();
    await run({
      type: "huddle.post",
      huddleId: huddle.huddleId,
      postId,
      from: agent.id,
      to,
      kind,
      text: input.text,
      ...(replyTo ? { replyTo } : {}),
    });
    const posted = huddlePostsOf(projection(), huddle.huddleId).find((post) => post.postId === postId);
    return {
      posted: true,
      huddle: huddle.name,
      number: posted?.number ?? huddle.nextNumber,
      to:
        to === "everyone"
          ? "everyone"
          : to === "person"
            ? "the person"
            : to.map((id) => memberLabel(projection(), id, agent)),
      ...(started ? { started } : {}),
      ...(huddle.paused || huddle.agentStreak + 1 > HUDDLE_AGENT_STREAK_LIMIT
        ? {
            held: `Agents wrote ${HUDDLE_AGENT_STREAK_LIMIT} messages in a row, so this waits until the person writes or resumes the huddle.`,
          }
        : {}),
    };
  };
  const handlers: Record<AgentControlAction, (input: unknown, settings: AgentSettings) => Promise<unknown>> = {
    agentaccess: async (_input, settings) => settings,
    agentlist: list,
    agentread: read,
    agentsend: send,
    agentstart: start,
    agentconnect: connect,
    huddleread: huddleRead,
    huddlepost: huddlePost,
    huddlewait: huddleWait,
    huddledecisions: huddleDecisions,
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
 * The first line of a message from another agent. It says who sent it, how it relates to the
 * receiver when one started the other, and how to answer: by name when the sender has one, and as
 * project/agent from another project.
 */
function messageHeading(options: {
  sender: Agent | undefined;
  project: string;
  where: string;
  crossProject: boolean;
  /** What the sender is to the receiver. */
  relation?: "parent" | "sub-agent" | undefined;
}): string {
  const { sender, project, where, crossProject, relation } = options;
  const role = crossProject
    ? `an agent in the ZLI project ${project}`
    : relation === "parent"
      ? "the agent that started you"
      : relation === "sub-agent"
        ? "your sub-agent"
        : "another agent in ZLI";
  const who = `${sender?.name ? `${sender.name}, ` : ""}${role}`;
  const reply = !sender
    ? ""
    : crossProject
      ? ` (reply to ${project}/${sender.name ?? sender.id})`
      : sender.name
        ? ` (reply to ${sender.name})`
        : ` (agent id ${sender.id})`;
  return `Message from ${who}, ${where}${reply}:`;
}

/** Where the sender works, for a heading. A folder without Git has no real branch to name. */
function workPlace(project: ProjectProjection, worktree: WorktreeProjection): string {
  return project.git === false ? `working in the folder ${project.name}` : `working on branch ${worktree.branch}`;
}

/** The first line of a sub-agent's task, so it knows its own name and which agent to report back to. */
function taskHeading(options: {
  parent: Agent;
  where: string;
  /** The new agent's name, or its id when it has none. */
  self: string;
  /** The new agent works in the parent's worktree, so tools cannot tell the two apart by worktree. */
  sharesWorktree: boolean;
}): string {
  const { parent, where, self, sharesWorktree } = options;
  const who = `${parent.name ? `${parent.name}, ` : ""}the agent in ZLI that started you`;
  const reply = parent.name ?? `agent id ${parent.id}`;
  const sign = sharesWorktree
    ? ` Other agents work in this folder too, so sign your messages with your name: the as field, or zli --as ${self}.`
    : "";
  return `Task from ${who}, ${where}. You are ${self} in ZLI.${sign} Reply to ${reply} when you finish or get stuck:`;
}

export function safeBranchName(branch: string): string {
  return branch
    .trim()
    .replace(/[^a-zA-Z0-9._/-]/gu, "-")
    .replace(/^[-/]+|[-/]+$/gu, "");
}
