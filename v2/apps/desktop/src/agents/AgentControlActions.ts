import { randomUUID } from "node:crypto";

import {
  AgentControlAction,
  AgentControlConnectInput,
  AgentControlListInput,
  AgentControlReadInput,
  AgentControlSendInput,
  AgentControlStartInput,
  type AgentControlTarget,
  AgentControlToolFindInput,
  AgentControlToolUseInput,
  type AgentToolAccess,
  type AgentToolScope,
  agentNameKey,
  agentNameTaken,
  agentTerminalInput,
  catalogEntryServer,
  GitBranchesResult,
  isHttpServer,
  isListedTerminalStatus,
  isListedThreadStatus,
  MCP_CATALOG,
  McpListResult,
  McpToolsCallResult,
  McpToolsFindResult,
  type PermissionMode,
  type ProjectProjection,
  READ_AGENT_CONTROL_ACTIONS,
  type RpcResponse,
  type RuntimeProjection,
  SERVICE_TOOL_ACTIONS,
  TerminalReadResult,
  type WorktreeProjection,
} from "@zli-v2/contracts";

import {
  type BrowserControlDispatch,
  BrowserControlError,
  resolveBrowserControlWorktree,
} from "../browser/BrowserControlActions.js";
import { createBuddyActions } from "./buddyActions.js";

const MAX_MESSAGE_CHARS = 4_000;
const STRICTEST_FIRST: readonly PermissionMode[] = ["read-only", "supervised", "full-access"];
const LIVE_THREAD = ["starting", "idle", "working", "waiting"];
const DEFAULT_READ_LIMIT = 20;
const SETTINGS_PLACE = "ZLI Settings, under Agents";

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
  /**
   * Asks the person whether agents may reach every project, for an agent that tried to reach another
   * one while Settings keep agents to their own. Allowing it changes the setting for every agent.
   */
  askToReach?(request: {
    agent: string;
    project: string;
    target?: { agent: string; project: string };
  }): Promise<"allowed" | "declined" | "unanswered">;
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
  /** This is the agent making the call. */
  you?: true;
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

  const keptToProject = () =>
    new BrowserControlError(
      "ZLI Settings keep agents to their own project. The person can let agents reach every project in Settings, under Agents.",
      403,
    );

  /**
   * Lets the call go on to another project. While Settings keep agents to their own, ZLI asks the
   * person, and their Allow lets every agent reach every project from then on.
   */
  const reachOtherProjects = async (
    settings: AgentSettings,
    state: RuntimeProjection,
    from: { worktree: WorktreeProjection; project: ProjectProjection },
    wanted?: { agent: string; project: string },
    as?: string,
  ) => {
    if (settings.scope === "all") return;
    if (!host.askToReach) throw keptToProject();
    // A wrong `as` fails here, before the person is asked anything.
    const self = callerAgent(state, from.project, from.worktree.worktreeId, as).agent;
    const outcome = await host.askToReach({
      agent: self ? (self.name ?? self.providerName) : "An agent",
      project: from.project.name,
      ...(wanted ? { target: wanted } : {}),
    });
    if (outcome === "allowed") return;
    // The person may have changed the setting in Settings instead of answering.
    if ((await currentSettings()).scope === "all") return;
    const what = wanted ? `${wanted.agent} works in another ZLI project` : "That needs another ZLI project";
    throw new BrowserControlError(
      outcome === "declined"
        ? `${what}, and the person chose to keep agents to their own project. Tell them what you needed. They can change this in ${SETTINGS_PLACE}.`
        : `${what}. ZLI asked the person to let agents reach other projects, and they have not answered yet. Tell them what you need, and try again once they allow it.`,
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

  /** Agents outside the caller's project with this exact id or name. */
  const elsewhere = (state: RuntimeProjection, from: ProjectProjection, worktreeId: string, ref: string) => {
    const others = new Set(
      state.projects.flatMap((entry) => (entry.projectId === from.projectId ? [] : entry.projectId)),
    );
    const agents = agentsIn(state, others, worktreeId);
    const exact = agents.find((agent) => agent.id === ref);
    if (exact) return [exact];
    const key = agentNameKey(ref);
    return agents.filter((agent) => agent.name !== undefined && agentNameKey(agent.name) === key);
  };

  const isNotFound = (cause: unknown) => cause instanceof BrowserControlError && cause.status === 404;

  /** Asking the person can take a while, so the agent is looked up again in what ZLI knows now. */
  const stillRunning = (agent: Agent, callerWorktreeId: string) => {
    const now = projection();
    const fresh = agentsIn(now, new Set([agent.projectId]), callerWorktreeId).find(
      (candidate) => candidate.id === agent.id,
    );
    if (!fresh)
      throw new BrowserControlError(
        `${agent.name ?? "That agent"} stopped while ZLI waited for the person's answer. Call list_agents to see who is running.`,
        409,
      );
    return { state: now, agent: fresh };
  };

  /**
   * Finds the agent a read or send is about. `project/agent` and the project field point at another
   * project. A plain name that no agent in the caller's project has is looked up in the others, so
   * agents can be reached by name alone. Reaching another project needs the person's say, and
   * `refuse` rules out an agent before the person is asked about it.
   */
  const target = async (
    state: RuntimeProjection,
    input: AgentControlReadInput | AgentControlSendInput,
    settings: AgentSettings,
    options: { as?: string | undefined; refuse?: (agent: Agent) => void } = {},
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
    if (projectRef !== undefined) {
      const project = findProject(state, projectRef);
      const crossProject = project.projectId !== from.project.projectId;
      const agents = projectAgents(state, project.projectId, from.worktree.worktreeId);
      let agent: Agent;
      try {
        agent = findAgent(agents, agentRef, project.name);
      } catch (cause) {
        // Who works in another project stays hidden until the person lets agents reach it.
        if (crossProject && settings.scope !== "all" && isNotFound(cause)) throw keptToProject();
        throw cause;
      }
      options.refuse?.(agent);
      if (!crossProject) return { ...from, state, agent, crossProject };
      await reachOtherProjects(
        settings,
        state,
        from,
        { agent: agent.name ?? agentRef, project: project.name },
        options.as,
      );
      return { ...from, ...stillRunning(agent, from.worktree.worktreeId), crossProject };
    }
    const local = projectAgents(state, from.project.projectId, from.worktree.worktreeId);
    try {
      const agent = findAgent(local, agentRef, from.project.name);
      options.refuse?.(agent);
      return { ...from, state, agent, crossProject: false };
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
    }
    const found = elsewhere(state, from.project, from.worktree.worktreeId, agentRef);
    const [only] = found;
    if (!only)
      throw new BrowserControlError(
        `No ZLI project has a running agent called ${agentRef}. Call list_agents for the names and ids.`,
        404,
      );
    if (found.length > 1) {
      await reachOtherProjects(settings, state, from, undefined, options.as);
      throw new BrowserControlError(
        `More than one agent in other projects is called ${agentRef}: ${found.map((agent) => `${agent.project}/${agent.name ?? agent.id}`).join(", ")}. Write the one you mean as project/agent.`,
      );
    }
    options.refuse?.(only);
    await reachOtherProjects(
      settings,
      state,
      from,
      { agent: only.name ?? agentRef, project: only.project },
      options.as,
    );
    return { ...from, ...stillRunning(only, from.worktree.worktreeId), crossProject: true };
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
    await run({ type: "terminal.write", terminalId, data: agentTerminalInput(text) });
    // Agent CLIs treat text and Enter that arrive in one read as a paste, which would not submit.
    await sleep(150);
    await run({ type: "terminal.write", terminalId, data: "\r" });
  };

  const list = async (raw: unknown, settings: AgentSettings) => {
    const input = AgentControlListInput.parse(raw);
    const state = projection();
    const { worktree, project } = caller(input, state);
    const self = callerAgent(state, project, worktree.worktreeId).agent;
    const shown = (agent: Agent): AgentSummary =>
      agent.id === self?.id ? { ...summary(agent), you: true } : summary(agent);
    const heading = {
      project: project.name,
      yourBranch: worktree.branch,
      ...(self ? { you: { ...(self.name ? { name: self.name } : {}), id: self.id } } : {}),
    };
    if (!input.allProjects)
      return {
        ...heading,
        agents: projectAgents(state, project.projectId, worktree.worktreeId).map(shown),
        ...(state.projects.length > 1
          ? {
              otherProjects:
                settings.scope === "all"
                  ? "Agents in other projects are not listed here. Pass allProjects to list them, or message one by name."
                  : "Agents in other projects are not listed here. Message one by name, and ZLI asks the person to let agents reach other projects first.",
            }
          : {}),
      };
    await reachOtherProjects(settings, state, { worktree, project });
    const order = (agent: Agent) => (agent.projectId === project.projectId ? "" : agent.project.toLocaleLowerCase());
    const agents = agentsIn(state, new Set(state.projects.map((entry) => entry.projectId)), worktree.worktreeId);
    return {
      ...heading,
      // Stable sort: the caller's project first, then the others by name, each oldest agent first.
      agents: agents.sort((left, right) => order(left).localeCompare(order(right))).map(shown),
    };
  };

  const read = async (raw: unknown, settings: AgentSettings) => {
    const input = AgentControlReadInput.parse(raw);
    const { agent, state } = await target(projection(), input, settings);
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

  const failedAgent = () => new BrowserControlError("That agent failed and cannot take messages.", 409);

  const send = async (raw: unknown, settings: AgentSettings) => {
    const input = AgentControlSendInput.parse(raw);
    const { worktree, project, agent, crossProject, state } = await target(projection(), input, settings, {
      as: input.as,
      refuse: (found) => {
        if (found.status === "failed") throw failedAgent();
      },
    });
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
      messageHeading({
        sender,
        receiver: agent.name,
        project: project.name,
        where: workPlace(project, worktree),
        crossProject,
        relation,
      }),
      "",
      input.text,
    ].join("\n");
    if (agent.kind === "terminal") {
      if (agent.status !== "running")
        throw new BrowserControlError("That terminal agent is still starting. Try again shortly.", 409);
      await typeIntoTerminal(agent.id, text);
      return { delivered: true, agent: summary(agent), ...(note ? { note } : {}) };
    }
    if (agent.status === "failed") throw failedAgent();
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

  /**
   * Whether a branch an agent named for a new worktree is new or already exists. A branch that is checked
   * out in a folder already (the caller's own, the person's, or another worktree) cannot get a second one,
   * so that is refused here with the folder named, before any worktree is made.
   */
  const branchPlace = async (from: WorktreeProjection, branch: string): Promise<"new" | "existing"> => {
    let branches: GitBranchesResult;
    try {
      branches = GitBranchesResult.parse(await run({ type: "review.git.branches", worktreeId: from.worktreeId }));
    } catch {
      // Without the list, git itself still refuses a taken branch, and the error reaches the agent.
      return "new";
    }
    if (branches.current === branch)
      throw new BrowserControlError(
        `You are already on ${branch}, in ${from.path}. start_agent is for work in parallel. To give another agent this branch, pass worktree "same" so it shares your folder, or name a new branch.`,
        409,
      );
    const elsewhere = branches.details?.[branch]?.worktreePath;
    if (elsewhere)
      throw new BrowserControlError(
        `${branch} is already checked out in ${elsewhere}, and Git allows a branch in only one folder at a time. Name a new branch instead, or ask the person to open a chat in that folder.`,
        409,
      );
    return branches.local.includes(branch) || branches.remote.includes(branch) ? "existing" : "new";
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

    // Checked before a worktree is made, like the name, so a wrong model leaves nothing behind.
    const model = workerModel(state, input, parent);

    let target: WorktreeProjection;
    if (input.worktree === "same" || plainFolder) target = callerWorktree;
    else {
      const branch = safeBranchName(input.branch ?? `${input.provider}-${newId().slice(0, 6)}`);
      if (!branch) throw new BrowserControlError("Choose a branch name with letters or digits.");
      const existing = input.branch === undefined ? "new" : await branchPlace(callerWorktree, branch);
      const worktreeId = newId();
      const workspaceRoot = `${project.path.replace(/[\\/]+$/u, "")}-worktrees`;
      await run({
        type: "worktree.create",
        worktreeId,
        projectId: project.projectId,
        path: `${workspaceRoot}/${branch.replace(/[\\/]/gu, "-")}`,
        workspaceRoot,
        branch,
        // A branch that already exists is checked out as it is; `-b` would refuse it.
        ...(existing === "existing" ? { checkoutExistingBranch: true } : { baseRef: callerWorktree.branch }),
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
        ...(model ? { model } : {}),
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
          ...(model ? { model } : {}),
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
    const onDemand = listed.toolLoading === "on-demand";
    if (server?.enabled && !needsSignIn)
      return {
        status: "connected",
        connector,
        message: onDemand
          ? `${title} is already connected in ZLI. Use find_tools to find its tools, then use_tool to call one.`
          : `${title} is already connected in ZLI. If its tools are missing here, it was added after this session started, so start a new session to use it.`,
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
          message: onDemand
            ? `Asked the person to connect ${title} in ZLI. Once they connect, find its tools with find_tools.`
            : `Asked the person to connect ${title} in ZLI. Once they connect, start a new session to use it.`,
        };
  };

  /** The caller's worktree, when ZLI knows it; outside one, servers limited to some projects are left out. */
  const callerWorktreeId = (input: AgentControlTarget): string | undefined => {
    const state = host.projection();
    if (!state) return undefined;
    try {
      return caller(input, state).worktree.worktreeId;
    } catch {
      return undefined;
    }
  };

  const findTools = async (raw: unknown) => {
    const input = AgentControlToolFindInput.parse(raw);
    const worktreeId = callerWorktreeId(input);
    return McpToolsFindResult.parse(
      await run({
        type: "mcp.tools.find",
        query: input.query,
        ...(input.limit ? { limit: input.limit } : {}),
        ...(worktreeId ? { worktreeId } : {}),
      }),
    );
  };

  const useTool = async (raw: unknown) => {
    const input = AgentControlToolUseInput.parse(raw);
    const worktreeId = callerWorktreeId(input);
    return McpToolsCallResult.parse(
      await run({
        type: "mcp.tools.call",
        server: input.service,
        tool: input.tool,
        ...(input.arguments ? { arguments: input.arguments } : {}),
        ...(worktreeId ? { worktreeId } : {}),
      }),
    );
  };

  const buddyActions = createBuddyActions({
    projection,
    caller: (input, state) => {
      const found = caller(input as AgentControlTarget, state);
      return { worktreeId: found.worktree.worktreeId, project: found.project };
    },
    run: (command) => run(command),
    newId,
  });
  const handlers: Record<AgentControlAction, (input: unknown, settings: AgentSettings) => Promise<unknown>> = {
    ...buddyActions,
    agentaccess: async (_input, settings) => settings,
    agentlist: list,
    agentread: read,
    agentsend: send,
    agentstart: start,
    agentconnect: connect,
    toolfind: findTools,
    tooluse: useTool,
  };

  return async (action, input) => {
    const parsed = AgentControlAction.safeParse(action);
    if (!parsed.success) throw new BrowserControlError(`Unknown agent action: ${action}`, 404);
    const settings = await currentSettings();
    // Service tools are not about other agents, and asking the person changes nothing, so the agent access
    // setting leaves them alone.
    if (parsed.data !== "agentaccess" && parsed.data !== "buddyask" && !SERVICE_TOOL_ACTIONS.includes(parsed.data)) {
      if (settings.access === "off")
        throw new BrowserControlError(`Agent tools are turned off in ${SETTINGS_PLACE}.`, 403);
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
  /** The receiver's name, so it knows it is the one meant. */
  receiver: string | undefined;
  project: string;
  where: string;
  crossProject: boolean;
  /** What the sender is to the receiver. */
  relation?: "parent" | "sub-agent" | undefined;
}): string {
  const { sender, receiver, project, where, crossProject, relation } = options;
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
  return `Message ${receiver ? `to ${receiver} ` : ""}from ${who}, ${where}${reply}:`;
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

/**
 * The model a started agent runs. A model the caller names is checked against what that agent offers, by id
 * or by its shown name, so a typo fails with the choices instead of starting an agent that cannot run. With
 * none named, a worker of the same agent as its lead runs the lead's model, so a team set to one model
 * stays on it.
 */
export function workerModel(
  state: Pick<RuntimeProjection, "providers">,
  input: { provider: string; model?: string | undefined },
  lead: { provider: string; model?: string | undefined } | undefined,
): string | undefined {
  const asked = input.model?.trim();
  const options = state.providers?.find((entry) => entry.provider === input.provider);
  const models = options?.status === "found" ? (options.models ?? []) : [];
  if (asked) {
    if (models.length === 0) return asked;
    const wanted = asked.toLowerCase();
    const match = models.find((option) => option.id.toLowerCase() === wanted || option.label.toLowerCase() === wanted);
    if (match) return match.id;
    const choices = models.map((option) => (option.label === option.id ? option.id : `${option.id} (${option.label})`));
    throw new BrowserControlError(
      `${asked} is not a model ${options?.displayName ?? input.provider} offers here. Pick one of: ${choices.join(", ")}.`,
      400,
    );
  }
  if (lead && lead.provider === input.provider && lead.model) return lead.model;
  return undefined;
}
