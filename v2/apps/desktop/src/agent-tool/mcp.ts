import { ListedProviderKind, READ_AGENT_CONTROL_ACTIONS, SERVICE_TOOL_ACTIONS } from "@zli-v2/contracts";

import type { ZliBrowserCall } from "../browser-tool/client.js";
import { createToolServer, type McpServer, type McpTool, type ToolResult } from "../browser-tool/mcp.js";

export const ZLI_AGENT_TOOL_VERSION = "1.7.0";

const ROOM =
  "ZLI is the app you are running in. The person sees every agent in it as a tile and can watch and steer each one.";

const AGENT_REF = {
  type: "string",
  description:
    "The agent's name or id from list_agents. A unique id prefix of at least 4 characters also works. An agent in another project can be named alone when no agent in your project has that name, or written project/agent, such as api/bob.",
};

const AS_CALLER = {
  type: "string",
  description:
    "Your own name or id from list_agents. ZLI knows you by your worktree, so pass this when other agents share it, such as in a folder without Git. Without it, your message goes unsigned and a new agent is not linked to you.",
};

const BUDDY_JOB =
  "For buddy jobs: ZLI gave you this job as a buddy, in your own worktree and chat. The person sees the job on the buddy's card.";

const BUDDY_TOOLS: readonly McpTool[] = [
  {
    name: "task_done",
    title: "Finish the job",
    action: "buddydone",
    description: `${BUDDY_JOB} Call this when the job is done, with a 2–3 sentence summary of what you changed and how you checked it. For UI changes, pass the screenshot paths from browser_screenshot. If you worked out steps worth reusing on the next job like this in this project, pass them as a playbook. Then end your turn.`,
    properties: {
      summary: { type: "string", description: "What you did and how you checked it, 2–3 sentences." },
      screenshots: {
        type: "array",
        items: { type: "string" },
        description: "Paths of screenshots that show the change.",
      },
      playbook: {
        type: "object",
        description:
          "Optional. Steps that worked for this kind of job in this project, for next time: how to run, test or check it, and any pitfall with its fix. Reuse a playbook's title from your brief to correct it.",
        properties: {
          title: { type: "string", description: "The kind of job, such as 'Add an API route'. Up to 120 characters." },
          steps: {
            type: "array",
            items: { type: "string" },
            description: "Up to 12 short steps, each one concrete: a file, a command, a check.",
          },
        },
        required: ["title", "steps"],
      },
    },
    required: ["summary"],
  },
  {
    name: "ask_person",
    title: "Ask the person",
    action: "buddyask",
    description: `${BUDDY_JOB} Ask the person for a decision you should not guess, such as a product choice. It shows in their Needs you list. End your turn after asking; the answer comes as your next message.`,
    properties: {
      question: { type: "string", description: "One clear question." },
      options: { type: "array", items: { type: "string" }, description: "Up to 6 short answers to pick from." },
    },
    required: ["question"],
  },
  {
    name: "remember",
    title: "Keep a lesson",
    action: "buddyremember",
    description: `${BUDDY_JOB} Keep one short fact worth knowing on later jobs in this project, such as how to run its tests. The person reviews it first; once they keep it, it is in your next briefs for this project.`,
    properties: { note: { type: "string", description: "One sentence, up to 400 characters." } },
    required: ["note"],
  },
  {
    name: "review_verdict",
    title: "Report a review",
    action: "buddyverdict",
    description: `${BUDDY_JOB} For review jobs only: report ok, or notes with the list of what to fix. Notes go back to the buddy that did the work.`,
    properties: {
      verdict: { type: "string", enum: ["ok", "notes"] },
      notes: { type: "array", items: { type: "string" }, description: "What to fix, one item each." },
    },
    required: ["verdict"],
  },
  {
    name: "hand_off",
    title: "Hand part of the job to another buddy",
    action: "buddyhandoff",
    description: `${BUDDY_JOB} Give part of your job to another buddy, such as tests or docs, without stopping your own work. Leave out buddy and ZLI picks the one that suits it. It starts on a branch from yours; its result comes back to you as a message. Jobs can be handed on 3 times.`,
    properties: {
      goal: { type: "string", description: "What the other buddy should do, in a sentence or two." },
      buddy: { type: "string", description: "The buddy's name, from list_buddies." },
      project: { type: "string", description: "A project name, when it is not this one." },
    },
    required: ["goal"],
  },
  {
    name: "list_buddies",
    title: "List buddies",
    action: "buddylist",
    description: "List the person's buddies: name, title, what each did last, and their open jobs.",
    properties: {},
    readOnly: true,
  },
  {
    name: "assign_task",
    title: "Give a buddy a job",
    action: "buddyassign",
    description:
      "For the Primary buddy: give a buddy a job. It runs in its own worktree and chat, and its result comes back to you.",
    properties: {
      buddy: { type: "string", description: "The buddy's name, from list_buddies." },
      goal: { type: "string", description: "The job, clear enough to work from alone." },
      project: {
        type: "string",
        description:
          'A project name, when it is not this one. "web" for work in a buddy\'s own browser: research, forms, accounts, reports.',
      },
      baseRef: { type: "string", description: "The branch to start from. Default: the project's current branch." },
    },
    required: ["buddy", "goal"],
  },
  {
    name: "task_status",
    title: "Check jobs",
    action: "buddystatus",
    description: "See every open buddy job and what finished in the last day, or one job by id.",
    properties: { taskId: { type: "string", description: "A job id or its first characters." } },
    readOnly: true,
  },
  {
    name: "task_revise",
    title: "Change a job",
    action: "buddyrevise",
    description: "For the Primary buddy: send a change request to a running or finished job.",
    properties: {
      taskId: { type: "string", description: "The job id or its first characters." },
      note: { type: "string", description: "What to change." },
    },
    required: ["taskId", "note"],
  },
  {
    name: "goal_done",
    title: "Finish a goal",
    action: "buddygoaldone",
    description:
      "For a lead's planning turn on a goal: say the whole goal is done, with a short summary for the person of what the team did and where to find it. Only once every job on it has ended and the result is checked. Then call task_done and end your turn.",
    properties: { summary: { type: "string", description: "What the team did, 2–4 sentences." } },
    required: ["summary"],
  },
  {
    name: "set_routine",
    title: "Set up a routine",
    action: "buddyroutine",
    description:
      'For the Primary buddy: give a buddy recurring work. Use schedule as five-field cron in local time ("0 9 * * 1-5" is weekdays at 9:00), or when: ci_failed (with branch), review_requested, or issue_labeled (with label). Routines never push, open PRs, or merge.',
    properties: {
      buddy: { type: "string" },
      goal: { type: "string", description: "What to do each time." },
      project: { type: "string" },
      schedule: { type: "string" },
      when: { type: "string", enum: ["ci_failed", "review_requested", "issue_labeled"] },
      branch: { type: "string" },
      label: { type: "string" },
    },
    required: ["buddy", "goal"],
  },
];

export const AGENT_MCP_TOOLS: readonly McpTool[] = [
  {
    name: "list_agents",
    title: "List ZLI agents",
    action: "agentlist",
    description: `${ROOM} List the agents working in your project: the name and id the other tools take, provider, project, branch, and status. you gives your own name and id, and marks you in the list. sameWorktree marks agents that share your worktree. startedBy names the agent that started a sub-agent.`,
    properties: {
      allProjects: {
        type: "boolean",
        description:
          "Also list agents in the person's other ZLI projects. When ZLI Settings keep agents to their own project, ZLI asks the person first.",
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
    name: "find_tools",
    title: "Find tools in connected services",
    action: "toolfind",
    description:
      'Find tools in the services the person connected in ZLI, such as Vercel, GitHub, Linear, Notion, Sentry, or a database. Search with a few words for what you want to do, such as "deploy", "list deployments", or "create issue"; each match comes with its service, name, and the arguments it takes, ready for use_tool. An empty query lists the connected services. Services connected while you work show up here at once.',
    properties: {
      query: {
        type: "string",
        description: "A few words for what you want to do, or a service name. Leave empty to list the services.",
      },
      limit: { type: "number", description: "How many tools to return, 1 to 25. Defaults to 8." },
    },
    readOnly: true,
  },
  {
    name: "use_tool",
    title: "Use a tool from a connected service",
    action: "tooluse",
    description:
      "Call one tool that find_tools returned, with arguments that follow its input schema. The tool's own result comes back as it gave it.",
    properties: {
      service: { type: "string", description: "The service, exactly as find_tools listed it." },
      tool: { type: "string", description: "The tool's name, exactly as find_tools listed it." },
      arguments: {
        type: "object",
        description: "The tool's arguments, following the input schema find_tools returned.",
        additionalProperties: true,
      },
    },
    required: ["service", "tool"],
  },
  {
    name: "connect_service",
    title: "Ask to connect a service",
    action: "agentconnect",
    description:
      "Ask the person to connect a service in ZLI, such as GitHub, Linear, Notion, Sentry, or Stripe, when your task needs its tools and find_tools has none, or when one of its tools says it needs a sign-in. ZLI shows them a prompt to connect or sign in. The result says whether it is already connected, and what to do next.",
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
  ...BUDDY_TOOLS,
];

/** Finding and using connected services' tools; the agent access setting does not limit these. */
const SERVICE_TOOL_NAMES = new Set(
  AGENT_MCP_TOOLS.filter((tool) => SERVICE_TOOL_ACTIONS.some((action) => action === tool.action)).map(
    (tool) => tool.name,
  ),
);

const READ_TOOL_NAMES = new Set([
  ...SERVICE_TOOL_NAMES,
  ...AGENT_MCP_TOOLS.filter((tool) => READ_AGENT_CONTROL_ACTIONS.some((action) => action === tool.action)).map(
    (tool) => tool.name,
  ),
]);

/** A use_tool result is the service's own MCP result, so it passes through instead of being wrapped as JSON. */
function formatAgentResult(action: string, result: unknown): ToolResult {
  if (action === "tooluse" && isRecord(result) && Array.isArray(result.content)) {
    const content: ToolResult["content"] = result.content.flatMap((item): ToolResult["content"] => {
      if (!isRecord(item)) return [];
      if (item.type === "text" && typeof item.text === "string") return [{ type: "text", text: item.text }];
      if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string")
        return [{ type: "image", data: item.data, mimeType: item.mimeType }];
      // Resources and anything newer reach the agent as their JSON.
      return [{ type: "text", text: JSON.stringify(item) }];
    });
    // A structured result reaches the agent as its JSON unless a text part already carries the same.
    if (result.structuredContent !== undefined) {
      const json = JSON.stringify(result.structuredContent);
      if (!content.some((item) => item.type === "text" && item.text === json))
        content.push({ type: "text", text: json });
    }
    return {
      content: content.length > 0 ? content : [{ type: "text", text: "The tool returned nothing." }],
      ...(result.isError === true ? { isError: true } : {}),
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createAgentMcpServer(call: ZliBrowserCall): McpServer {
  return createToolServer(call, {
    tools: AGENT_MCP_TOOLS,
    serverInfo: { name: "zli", title: "ZLI agents", version: ZLI_AGENT_TOOL_VERSION },
    instructions: `${ROOM} Use list_agents to see who else is working in this project, read_agent to check on them, message_agent to coordinate, and start_agent to hand off a separate task. Refer to agents by name when they have one. An agent in another project can be named alone or as project/agent. When ZLI Settings keep agents to their own project, ZLI asks the person to allow it and the call waits for the answer. Services the person connected in ZLI, such as Vercel, GitHub, or Linear, are reached through find_tools and use_tool: search for what you want to do, then call the tool it returns. Use connect_service when find_tools has nothing for a service you need, or a tool says it needs a sign-in. When ZLI gave you a job as a buddy, finish with task_done, ask the person with ask_person, and hand parts to other buddies with hand_off. The Primary starts a team on a bigger goal with start_team; a team lead hands in its plan with team_plan.`,
    targetProperties: {
      cwd: {
        type: "string",
        description:
          "Absolute path of the directory you are working in. Picks your ZLI worktree and project; defaults to this tool's working directory.",
      },
    },
    failureMessage: "The ZLI agent action failed.",
    formatResult: formatAgentResult,
    // Settings can limit what agents may do; listing only allowed tools keeps agents from trying the rest.
    visibleTools: async () => {
      const result = (await call("agentaccess")) as { access?: unknown } | null;
      if (result?.access === "off") return SERVICE_TOOL_NAMES;
      if (result?.access === "read") return READ_TOOL_NAMES;
      return undefined;
    },
  });
}
