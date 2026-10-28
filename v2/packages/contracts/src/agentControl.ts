import { z } from "zod";

import { AgentName } from "./agentName.js";
import { BrowserControlTarget } from "./browser.js";
import { ListedProviderKind } from "./provider.js";

/**
 * What agents may do with the `zli` tool: nothing, see and read other agents, or also start agents and
 * send them messages.
 */
export const AgentToolAccess = z.enum(["off", "read", "full"]);
export type AgentToolAccess = z.infer<typeof AgentToolAccess>;
export const DEFAULT_AGENT_TOOL_ACCESS: AgentToolAccess = "full";

/**
 * Which agents the `zli` tool can see: only those in the caller's project, or those in every project.
 * Starting an agent always stays in the caller's project.
 */
export const AgentToolScope = z.enum(["project", "all"]);
export type AgentToolScope = z.infer<typeof AgentToolScope>;
export const DEFAULT_AGENT_TOOL_SCOPE: AgentToolScope = "project";

/** Served by the same control service as the browser tool, under their own action names. */
export const AGENT_CONTROL_ACTIONS = [
  "agentaccess",
  "agentlist",
  "agentread",
  "agentsend",
  "agentstart",
  "agentconnect",
] as const;
export const AgentControlAction = z.enum(AGENT_CONTROL_ACTIONS);
export type AgentControlAction = z.infer<typeof AgentControlAction>;

/** Actions allowed when access is "read". Asking the person to connect a service changes nothing by itself. */
export const READ_AGENT_CONTROL_ACTIONS: readonly AgentControlAction[] = [
  "agentaccess",
  "agentlist",
  "agentread",
  "agentconnect",
];

/** An agent's name or id, or a unique id prefix. `project/agent` reaches an agent in another project. */
const AgentRef = z.string().trim().min(1, "Name the agent with a name or id from list_agents.").max(300);

/** A project's name or id. */
const ProjectRef = z.string().trim().min(1).max(200);

/** Picks the caller's worktree, and through it the caller's project. */
export const AgentControlTarget = BrowserControlTarget.pick({
  worktreeId: true,
  defaultWorktreeId: true,
  cwd: true,
});
export type AgentControlTarget = z.infer<typeof AgentControlTarget>;

export const AgentControlListInput = AgentControlTarget.extend({
  /** Also lists agents in the person's other projects, when Settings allow it. */
  allProjects: z.boolean().optional(),
});
export type AgentControlListInput = z.infer<typeof AgentControlListInput>;

export const AgentControlReadInput = AgentControlTarget.extend({
  agent: AgentRef,
  /** Looks for the agent in this project instead of the caller's. */
  project: ProjectRef.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type AgentControlReadInput = z.infer<typeof AgentControlReadInput>;

export const AgentControlSendInput = AgentControlTarget.extend({
  agent: AgentRef,
  /** Looks for the agent in this project instead of the caller's. */
  project: ProjectRef.optional(),
  text: z.string().trim().min(1, "Write the message to send.").max(8_000),
});
export type AgentControlSendInput = z.infer<typeof AgentControlSendInput>;

export const AgentControlStartInput = AgentControlTarget.extend({
  provider: ListedProviderKind,
  prompt: z.string().trim().min(1, "Write the task for the new agent.").max(8_000),
  /** chat runs the agent in a ZLI chat; terminal runs its CLI in a terminal tile. */
  mode: z.enum(["chat", "terminal"]).optional(),
  /** new makes a worktree on its own branch; same shares the caller's worktree. */
  worktree: z.enum(["new", "same"]).optional(),
  branch: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  name: AgentName.optional(),
});
export type AgentControlStartInput = z.infer<typeof AgentControlStartInput>;

export const AgentControlConnectInput = AgentControlTarget.extend({
  /** A connector id such as github, its name, or the name of a server the person added. */
  service: z.string().trim().min(1, "Name the service, such as github or linear.").max(100),
  reason: z.string().trim().max(500).optional(),
});
export type AgentControlConnectInput = z.infer<typeof AgentControlConnectInput>;
