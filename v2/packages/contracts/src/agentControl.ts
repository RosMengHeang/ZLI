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

/**
 * An agent tried to reach another project while Settings keep agents to their own. ZLI asks the person
 * whether agents may reach every project. target is the agent it was after, when it named one.
 */
export const AgentReachRequest = z.object({
  requestId: z.string().uuid(),
  agent: z.string().min(1).max(200),
  project: z.string().min(1).max(200),
  target: z.object({ agent: z.string().min(1).max(200), project: z.string().min(1).max(200) }).optional(),
});
export type AgentReachRequest = z.infer<typeof AgentReachRequest>;

export const AgentReachAnswer = z.object({ requestId: z.string().uuid(), allow: z.boolean() });
export type AgentReachAnswer = z.infer<typeof AgentReachAnswer>;

/** Served by the same control service as the browser tool, under their own action names. */
export const AGENT_CONTROL_ACTIONS = [
  "agentaccess",
  "agentlist",
  "agentread",
  "agentsend",
  "agentstart",
  "agentconnect",
  "toolfind",
  "tooluse",
  "buddydone",
  "buddyask",
  "buddyremember",
  "buddyverdict",
  "buddyhandoff",
  "buddylist",
  "buddyassign",
  "buddystatus",
  "buddyrevise",
  "buddyroutine",
  "buddygoaldone",
] as const;
export const AgentControlAction = z.enum(AGENT_CONTROL_ACTIONS);
export type AgentControlAction = z.infer<typeof AgentControlAction>;

/** Actions allowed when access is "read". Asking the person to connect a service changes nothing by itself. */
export const READ_AGENT_CONTROL_ACTIONS: readonly AgentControlAction[] = [
  "agentaccess",
  "agentlist",
  "agentread",
  "agentconnect",
  "buddylist",
  "buddystatus",
  // A buddy reporting on its own job changes nothing outside it.
  "buddydone",
  "buddyask",
  "buddyremember",
  "buddyverdict",
  // A lead closing its own goal, like a buddy reporting on its own job.
  "buddygoaldone",
];

/**
 * Finding and using the tools of connected services. These are not about other agents, so the agent access
 * setting does not limit them; each service's own sign-in and tool settings do.
 */
export const SERVICE_TOOL_ACTIONS: readonly AgentControlAction[] = ["toolfind", "tooluse"];

/** An agent's name or id, or a unique id prefix. `project/agent` reaches an agent in another project. */
const AgentRef = z.string().trim().min(1, "Name the agent with a name or id from list_agents.").max(300);

/**
 * The caller's own name or id. Tools only see the caller's worktree, so this tells apart agents that
 * share one, such as every agent in a folder without Git.
 */
const CallerRef = z.string().trim().min(1).max(300);

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
  as: CallerRef.optional(),
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
  as: CallerRef.optional(),
});
export type AgentControlStartInput = z.infer<typeof AgentControlStartInput>;

export const AgentControlConnectInput = AgentControlTarget.extend({
  /** A connector id such as github, its name, or the name of a server the person added. */
  service: z.string().trim().min(1, "Name the service, such as github or linear.").max(100),
  reason: z.string().trim().max(500).optional(),
});
export type AgentControlConnectInput = z.infer<typeof AgentControlConnectInput>;

/** Finds tools in the services connected in ZLI. An empty query lists the services. */
export const AgentControlToolFindInput = AgentControlTarget.extend({
  query: z.string().trim().max(300).default(""),
  limit: z.number().int().min(1).max(25).optional(),
});
export type AgentControlToolFindInput = z.infer<typeof AgentControlToolFindInput>;

/** Calls one tool that find_tools returned. */
export const AgentControlToolUseInput = AgentControlTarget.extend({
  service: z.string().trim().min(1, "Name the service, as find_tools listed it.").max(100),
  tool: z.string().trim().min(1, "Name the tool, as find_tools listed it.").max(200),
  arguments: z.record(z.string(), z.unknown()).optional(),
});
export type AgentControlToolUseInput = z.infer<typeof AgentControlToolUseInput>;
