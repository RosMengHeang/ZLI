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
  "huddleread",
  "huddlepost",
  "huddlewait",
  "huddledecisions",
] as const;
export const AgentControlAction = z.enum(AGENT_CONTROL_ACTIONS);
export type AgentControlAction = z.infer<typeof AgentControlAction>;

/** Actions allowed when access is "read". Asking the person to connect a service changes nothing by itself. */
export const READ_AGENT_CONTROL_ACTIONS: readonly AgentControlAction[] = [
  "agentaccess",
  "agentlist",
  "agentread",
  "agentconnect",
  "huddleread",
  "huddlewait",
  "huddledecisions",
];

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

/** A huddle's name or id, or a unique id prefix. Optional when the caller is in one huddle only. */
const HuddleRef = z.string().trim().min(1).max(200);

/** The most messages one huddle read returns. */
export const MAX_HUDDLE_READ = 50;

export const AgentControlHuddleReadInput = AgentControlTarget.extend({
  huddle: HuddleRef.optional(),
  /** The latest messages, read before or not, instead of only the ones the caller has not read. */
  all: z.boolean().optional(),
  /** Messages numbered below this one, read before or not, for going back through history. */
  before: z.number().int().positive().optional(),
  /** How many messages to return, up to MAX_HUDDLE_READ. */
  limit: z.number().int().min(1).max(MAX_HUDDLE_READ).optional(),
  as: CallerRef.optional(),
});
export type AgentControlHuddleReadInput = z.infer<typeof AgentControlHuddleReadInput>;

export const AgentControlHuddlePostInput = AgentControlTarget.extend({
  huddle: HuddleRef.optional(),
  text: z.string().trim().min(1, "Write the message to post.").max(8_000),
  /** everyone (the default, or the lead in lead mode), person for only the person, or member names or ids. */
  to: z.union([z.literal("everyone"), z.literal("person"), z.array(AgentRef).min(1).max(12)]).optional(),
  kind: z.enum(["ask", "assign", "done", "blocked", "note"]).optional(),
  /** The number of the message this answers. */
  replyTo: z.number().int().positive().optional(),
  /** Starts a new agent as the caller's sub-agent, adds it to the huddle, and sends it this message. */
  start: z
    .object({
      name: AgentName,
      provider: ListedProviderKind,
      mode: z.enum(["chat", "terminal"]).optional(),
      worktree: z.enum(["new", "same"]).optional(),
      branch: z.string().trim().min(1).max(200).optional(),
      model: z.string().trim().min(1).max(200).optional(),
    })
    .optional(),
  as: CallerRef.optional(),
});
export type AgentControlHuddlePostInput = z.infer<typeof AgentControlHuddlePostInput>;

export const AgentControlHuddleWaitInput = AgentControlTarget.extend({
  huddle: HuddleRef.optional(),
  timeoutSeconds: z.number().int().min(1).max(600).optional(),
  as: CallerRef.optional(),
});
export type AgentControlHuddleWaitInput = z.infer<typeof AgentControlHuddleWaitInput>;

export const AgentControlHuddleDecisionsInput = AgentControlTarget.extend({
  huddle: HuddleRef.optional(),
  as: CallerRef.optional(),
});
export type AgentControlHuddleDecisionsInput = z.infer<typeof AgentControlHuddleDecisionsInput>;

export const AgentControlConnectInput = AgentControlTarget.extend({
  /** A connector id such as github, its name, or the name of a server the person added. */
  service: z.string().trim().min(1, "Name the service, such as github or linear.").max(100),
  reason: z.string().trim().max(500).optional(),
});
export type AgentControlConnectInput = z.infer<typeof AgentControlConnectInput>;
