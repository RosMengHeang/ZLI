import { z } from "zod";

import { BrowserControlTarget } from "./browser.js";
import { ListedProviderKind } from "./provider.js";

/**
 * What agents may do with the `zli` tool: nothing, see and read other agents, or also start agents and
 * send them messages.
 */
export const AgentToolAccess = z.enum(["off", "read", "full"]);
export type AgentToolAccess = z.infer<typeof AgentToolAccess>;
export const DEFAULT_AGENT_TOOL_ACCESS: AgentToolAccess = "full";

/** Served by the same control service as the browser tool, under their own action names. */
export const AGENT_CONTROL_ACTIONS = ["agentaccess", "agentlist", "agentread", "agentsend", "agentstart"] as const;
export const AgentControlAction = z.enum(AGENT_CONTROL_ACTIONS);
export type AgentControlAction = z.infer<typeof AgentControlAction>;

/** Read-only actions, allowed when access is "read". */
export const READ_AGENT_CONTROL_ACTIONS: readonly AgentControlAction[] = ["agentaccess", "agentlist", "agentread"];

const AgentRef = z.string().trim().min(1, "Name the agent with an id from list_agents.").max(100);

export const AgentControlListInput = BrowserControlTarget.pick({
  worktreeId: true,
  defaultWorktreeId: true,
  cwd: true,
});
export type AgentControlListInput = z.infer<typeof AgentControlListInput>;

export const AgentControlReadInput = AgentControlListInput.extend({
  agent: AgentRef,
  limit: z.number().int().min(1).max(200).optional(),
});
export type AgentControlReadInput = z.infer<typeof AgentControlReadInput>;

export const AgentControlSendInput = AgentControlListInput.extend({
  agent: AgentRef,
  text: z.string().trim().min(1, "Write the message to send.").max(8_000),
});
export type AgentControlSendInput = z.infer<typeof AgentControlSendInput>;

export const AgentControlStartInput = AgentControlListInput.extend({
  provider: ListedProviderKind,
  prompt: z.string().trim().min(1, "Write the task for the new agent.").max(8_000),
  /** chat runs the agent in a ZLI chat; terminal runs its CLI in a terminal tile. */
  mode: z.enum(["chat", "terminal"]).optional(),
  /** new makes a worktree on its own branch; same shares the caller's worktree. */
  worktree: z.enum(["new", "same"]).optional(),
  branch: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(200).optional(),
});
export type AgentControlStartInput = z.infer<typeof AgentControlStartInput>;
