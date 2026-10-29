import { HUDDLE_AGENT_TURN_LIMIT, ListedProviderKind, READ_AGENT_CONTROL_ACTIONS } from "@zli-v2/contracts";

import type { ZliBrowserCall } from "../browser-tool/client.js";
import { createToolServer, type McpServer, type McpTool } from "../browser-tool/mcp.js";

export const ZLI_AGENT_TOOL_VERSION = "1.3.0";

const ROOM =
  "ZLI is the app you are running in. The person sees every agent in it as a tile and can watch and steer each one.";

const AGENT_REF = {
  type: "string",
  description:
    "The agent's name or id from list_agents. A unique id prefix of at least 4 characters also works. For an agent in another project, write project/agent, such as api/bob.",
};

const AS_CALLER = {
  type: "string",
  description:
    "Your own name or id from list_agents. ZLI knows you by your worktree, so pass this when other agents share it, such as in a folder without Git. Without it, your message goes unsigned and a new agent is not linked to you.",
};

const HUDDLE_REF = {
  type: "string",
  description:
    "The huddle's name or id. Leave it out when you are in one huddle only; the result of every huddle tool names the huddle and its id.",
};

const HUDDLE =
  "A huddle is a ZLI conversation between several agents that the person follows and can write in. The person adds agents to it, and taking an agent out ends its access.";

export const AGENT_MCP_TOOLS: readonly McpTool[] = [
  {
    name: "list_agents",
    title: "List ZLI agents",
    action: "agentlist",
    description: `${ROOM} List the agents working in your project: the name and id the other tools take, provider, project, branch, and status. sameWorktree marks agents that share your worktree, which includes you. startedBy names the agent that started a sub-agent.`,
    properties: {
      allProjects: {
        type: "boolean",
        description:
          "Also list agents in the person's other ZLI projects. Works only when ZLI Settings let agents reach every project.",
      },
    },
    readOnly: true,
  },
  {
    name: "read_agent",
    title: "Read agent",
    action: "agentread",
    description:
      "Read what another agent has been doing: the recent messages of a chat agent, or the recent output of a terminal agent with color codes removed.",
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
      "Send a message to another agent. It arrives as that agent's next prompt, labeled with your name or id, project, and branch, so say exactly what you need. A busy chat agent gets it after its current turn (the result says queued); terminal agents get it typed into their CLI.",
    properties: {
      agent: AGENT_REF,
      text: { type: "string", description: "The message, up to 8000 characters." },
      as: AS_CALLER,
    },
    required: ["agent", "text"],
  },
  {
    name: "start_agent",
    title: "Start agent",
    action: "agentstart",
    description: `${ROOM} Start another coding agent on a task so it runs in parallel with you. By default it gets its own worktree on a new branch that starts from your branch's last commit, so your uncommitted changes are not in it. In a folder without Git it works in the same folder. The new agent is your sub-agent: its task says you started it and how to reply to you. Follow its progress with read_agent.`,
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
      name: {
        type: "string",
        description:
          "A short name for the agent, such as bob, that you and the person can use in place of its id. No other agent in the project may have it.",
      },
      as: AS_CALLER,
    },
    required: ["provider", "prompt"],
  },
  {
    name: "huddle_read",
    title: "Read huddle",
    action: "huddleread",
    description: `${HUDDLE} Read the huddle messages you have not read yet, with who wrote each one, to whom, and its number, plus the members. The first call returns the latest messages. Up to 50 come back at a time, oldest unread first: when moreUnread is set, call again for the rest. earlierNotShown means older messages exist; pass before with the oldest number you got to read them. Reading clears your inbox, the messages that started no turn for you.`,
    properties: {
      huddle: HUDDLE_REF,
      all: { type: "boolean", description: "Return the latest messages, read or not." },
      before: {
        type: "integer",
        minimum: 1,
        description: "Return the latest messages numbered below this one, read or not, to go back through history.",
      },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "How many messages to return. Default 50." },
      as: AS_CALLER,
    },
    readOnly: true,
  },
  {
    name: "huddle_post",
    title: "Post in huddle",
    action: "huddlepost",
    description: `${HUDDLE} Write in the huddle. Post when you finish (kind done), are stuck (blocked), or need an answer (ask), and put everything in one post: a second post before anyone writes to you is refused unless it answers an ask, a task, or a blocker. Do not post to acknowledge or thank. A post starts a turn only for the members it names, when it asks, assigns, reports done, or is blocked; a busy chat agent gets them together after its turn. A note, or a post to everyone, starts no turn: members see it when they next read. A chat agent's answer to an ask or a task is posted back for it. After agents start ${HUDDLE_AGENT_TURN_LIMIT} turns for each other, the huddle holds their messages until the person writes.`,
    properties: {
      huddle: HUDDLE_REF,
      text: { type: "string", description: "The message, up to 8000 characters." },
      to: {
        type: "array",
        items: { type: "string" },
        description:
          'Member names or ids to write to: name who should act. Leave it out to write to every member, or to the lead when the huddle has one. ["person"] writes to the person only.',
      },
      kind: {
        type: "string",
        enum: ["ask", "assign", "done", "blocked", "note"],
        description:
          "ask wants an answer, assign hands over a task, done reports finished work, blocked asks for a decision you need, note (default) shares information and starts no turn.",
      },
      replyTo: {
        type: "integer",
        minimum: 1,
        description:
          "The number of the message this answers. Answers to an ask, a task, or a blocker are always allowed.",
      },
      start: {
        type: "object",
        description:
          "Start a new agent as your sub-agent, add it to the huddle, and give it this message as its task. Goes with kind assign.",
        properties: {
          name: {
            type: "string",
            description: "The new agent's name, such as tester. No other agent in the project may have it.",
          },
          provider: { type: "string", enum: [...ListedProviderKind.options], description: "Which agent to start." },
          mode: { type: "string", enum: ["chat", "terminal"], description: "chat (default) or terminal." },
          worktree: {
            type: "string",
            enum: ["new", "same"],
            description: "new (default) makes a worktree on its own branch. same shares your worktree.",
          },
          branch: { type: "string", description: "Branch name for a new worktree." },
          model: { type: "string", description: "Model id, when the provider offers a choice." },
        },
        required: ["name", "provider"],
      },
      as: AS_CALLER,
    },
    required: ["text"],
  },
  {
    name: "huddle_wait",
    title: "Wait for huddle",
    action: "huddlewait",
    description: `${HUDDLE} Wait until someone else writes in the huddle, then return the new messages. Use it when you are blocked on an answer and have nothing else to do. Returns timedOut when nobody wrote in time.`,
    properties: {
      huddle: HUDDLE_REF,
      timeoutSeconds: { type: "integer", minimum: 1, maximum: 600, description: "How long to wait. Default 120." },
      as: AS_CALLER,
    },
    readOnly: true,
  },
  {
    name: "huddle_decisions",
    title: "Huddle decisions",
    action: "huddledecisions",
    description: `${HUDDLE} List the messages the person pinned as agreed decisions. Check them before you start work the huddle discussed.`,
    properties: { huddle: HUDDLE_REF, as: AS_CALLER },
    readOnly: true,
  },
  {
    name: "connect_service",
    title: "Ask to connect a service",
    action: "agentconnect",
    description:
      "Ask the person to connect a service in ZLI, such as GitHub, Linear, Notion, Sentry, or Stripe, when your task needs its tools and you do not have them, or when one of its tools says it needs a sign-in. ZLI shows them a prompt to connect or sign in. The result says whether it is already connected, and what to do next: try again after a sign-in, or start a new session for a newly connected service.",
    properties: {
      service: {
        type: "string",
        description: "The service: a connector id such as github, linear, or notion, its name, or an MCP server name.",
      },
      reason: { type: "string", description: "One short sentence on what you need it for, shown to the person." },
    },
    required: ["service"],
    readOnly: true,
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
    instructions: `${ROOM} Use list_agents to see who else is working in this project, read_agent to check on them, message_agent to coordinate, and start_agent to hand off a separate task. When you are in a huddle, talk there with huddle_read, huddle_post, and huddle_wait, post only when you are done, blocked, or need an answer, and follow the decisions from huddle_decisions. Refer to agents by name when they have one. Agents in other projects are written project/agent and need ZLI Settings to allow every project. Use connect_service when you need a service such as GitHub or Linear that you have no tools for, or that needs a sign-in.`,
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
