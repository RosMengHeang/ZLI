import { ListedProviderKind, READ_AGENT_CONTROL_ACTIONS } from "@zli-v2/contracts";

import type { ZliBrowserCall } from "../browser-tool/client.js";
import { createToolServer, type McpServer, type McpTool } from "../browser-tool/mcp.js";

export const ZLI_AGENT_TOOL_VERSION = "1.0.0";

const ROOM =
  "ZLI is the app you are running in. The person sees every agent in it as a tile and can watch and steer each one.";

const AGENT_REF = {
  type: "string",
  description: "Agent id from list_agents. A unique prefix of at least 4 characters also works.",
};

export const AGENT_MCP_TOOLS: readonly McpTool[] = [
  {
    name: "list_agents",
    title: "List ZLI agents",
    action: "agentlist",
    description: `${ROOM} List the agents working in your project: the id the other tools take, provider, branch, and status. sameWorktree marks agents that share your worktree, which includes you.`,
    properties: {},
    readOnly: true,
  },
  {
    name: "read_agent",
    title: "Read agent",
    action: "agentread",
    description:
      "Read what another agent in your project has been doing: the recent messages of a chat agent, or the recent output of a terminal agent with color codes removed.",
    properties: {
      agent: AGENT_REF,
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        description: "Chat messages to return, oldest first. Default 20.",
      },
    },
    required: ["agent"],
    readOnly: true,
  },
  {
    name: "message_agent",
    title: "Message agent",
    action: "agentsend",
    description:
      "Send a message to another agent in your project. It arrives as that agent's next prompt, labeled with your branch, so say exactly what you need. Chat agents must be idle; terminal agents get it typed into their CLI.",
    properties: {
      agent: AGENT_REF,
      text: { type: "string", description: "The message, up to 8000 characters." },
    },
    required: ["agent", "text"],
  },
  {
    name: "start_agent",
    title: "Start agent",
    action: "agentstart",
    description: `${ROOM} Start another coding agent on a task so it runs in parallel with you. By default it gets its own worktree on a new branch that starts from your branch's last commit, so your uncommitted changes are not in it. Follow its progress with read_agent.`,
    properties: {
      provider: { type: "string", enum: [...ListedProviderKind.options], description: "Which agent to start." },
      prompt: { type: "string", description: "The task, written as the first message the agent gets." },
      mode: {
        type: "string",
        enum: ["chat", "terminal"],
        description: "chat (default) runs it in a ZLI chat, which read_agent reads cleanly. terminal runs its CLI.",
      },
      worktree: {
        type: "string",
        enum: ["new", "same"],
        description: "new (default) makes a worktree on its own branch. same shares your worktree and files.",
      },
      branch: { type: "string", description: "Branch name for a new worktree. Default: <provider>-<random>." },
      model: { type: "string", description: "Model id, when the provider offers a choice." },
    },
    required: ["provider", "prompt"],
  },
];

const READ_TOOL_NAMES = new Set(
  AGENT_MCP_TOOLS.filter((tool) => READ_AGENT_CONTROL_ACTIONS.some((action) => action === tool.action)).map(
    (tool) => tool.name,
  ),
);

export function createAgentMcpServer(call: ZliBrowserCall): McpServer {
  return createToolServer(call, {
    tools: AGENT_MCP_TOOLS,
    serverInfo: { name: "zli", title: "ZLI agents", version: ZLI_AGENT_TOOL_VERSION },
    instructions: `${ROOM} Use list_agents to see who else is working in this project, read_agent to check on them, message_agent to coordinate, and start_agent to hand off a separate task.`,
    targetProperties: {
      cwd: {
        type: "string",
        description:
          "Absolute path of the directory you are working in. Picks your ZLI worktree and project; defaults to this tool's working directory.",
      },
    },
    failureMessage: "The ZLI agent action failed.",
    // Settings can limit what agents may do; listing only allowed tools keeps agents from trying the rest.
    visibleTools: async () => {
      const result = (await call("agentaccess")) as { access?: unknown } | null;
      if (result?.access === "off") return new Set<string>();
      if (result?.access === "read") return READ_TOOL_NAMES;
      return undefined;
    },
  });
}
