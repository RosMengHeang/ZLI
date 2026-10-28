import type { RpcResponse, RuntimeProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { BrowserControlError } from "../browser/BrowserControlActions.js";
import { createAgentControlActions } from "./AgentControlActions.js";

const PROJECT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_PROJECT = "00000000-0000-4000-8000-0000000000a2";
const MAIN = "00000000-0000-4000-8000-0000000000b1";
const FEATURE = "00000000-0000-4000-8000-0000000000b2";
const ELSEWHERE = "00000000-0000-4000-8000-0000000000b3";
const ME = "00000000-0000-4000-8000-0000000000c1";
const PEER = "00000000-0000-4000-8000-0000000000c2";
const STOPPED = "00000000-0000-4000-8000-0000000000c3";
const FOREIGN = "00000000-0000-4000-8000-0000000000c4";
const TERMINAL = "00000000-0000-4000-8000-0000000000d1";

function baseProjection(): RuntimeProjection {
  return {
    projects: [
      { projectId: PROJECT, path: "/work/app", name: "app" },
      { projectId: OTHER_PROJECT, path: "/work/other", name: "other" },
    ],
    worktrees: [
      { worktreeId: MAIN, projectId: PROJECT, path: "/work/app", branch: "main", status: "ready", kind: "checkout" },
      { worktreeId: FEATURE, projectId: PROJECT, path: "/work/app-worktrees/ui", branch: "ui", status: "ready" },
      { worktreeId: ELSEWHERE, projectId: OTHER_PROJECT, path: "/work/other", branch: "main", status: "ready" },
    ],
    threads: [
      thread(ME, MAIN, "idle", "2026-01-01T00:00:00.000Z"),
      thread(PEER, FEATURE, "idle", "2026-01-01T00:00:01.000Z"),
      thread(STOPPED, FEATURE, "stopped", "2026-01-01T00:00:02.000Z"),
      thread(FOREIGN, ELSEWHERE, "idle", "2026-01-01T00:00:03.000Z"),
    ],
    terminals: [
      {
        terminalId: TERMINAL,
        worktreeId: FEATURE,
        title: "Claude Code",
        status: "running",
        lastSequence: 4,
        kind: "agent",
        agent: { provider: "claude-code" },
        createdAt: "2026-01-01T00:00:04.000Z",
      },
    ],
    providers: [
      { provider: "codex", displayName: "Codex", status: "found", path: "/bin/codex" },
      { provider: "claude-code", displayName: "Claude Code", status: "found", path: "/bin/claude" },
      { provider: "gemini", displayName: "Gemini", status: "missing", reason: "Install the Gemini CLI." },
    ],
    messages: [
      { messageId: "m1", threadId: PEER, role: "user", text: "Build the login form" },
      { messageId: "m2", threadId: PEER, role: "assistant", text: "Done. Tests pass." },
    ],
  } as unknown as RuntimeProjection;
}

function thread(threadId: string, worktreeId: string, status: string, createdAt: string) {
  return { threadId, worktreeId, provider: "codex", status, capabilities: {}, createdAt };
}

type Sent = { type: string; [key: string]: unknown };

function harness(
  options: {
    access?: string;
    scope?: string;
    onCommand?: (command: Sent, state: RuntimeProjection) => void;
    servers?: unknown[];
    signIns?: unknown[];
  } = {},
) {
  let state = baseProjection();
  const listeners = new Set<() => void>();
  const sent: Sent[] = [];
  const asked: Array<{ title: string; body: string; connectorId: string }> = [];
  let ids = 0;
  const update = (next: RuntimeProjection) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const dispatch = createAgentControlActions({
    projection: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    command: async (request): Promise<RpcResponse> => {
      const command = request.command as Sent;
      if (command.type === "mcp.list")
        return {
          commandId: request.commandId,
          accepted: true,
          result: {
            servers: options.servers ?? [],
            agentAccess: options.access ?? "full",
            agentScope: options.scope ?? "project",
            userSettings: { enabled: false, outcomes: [] },
            signIns: options.signIns ?? [],
          },
        } as RpcResponse;
      sent.push(command);
      if (command.type === "terminal.read")
        return {
          commandId: request.commandId,
          accepted: true,
          result: { terminalId: command.terminalId, text: "> fixing tests", truncated: false },
        } as RpcResponse;
      // Projection updates arrive after the command is accepted, as they do from the runtime.
      queueMicrotask(() => options.onCommand?.(command, state));
      return { commandId: request.commandId, accepted: true } as RpcResponse;
    },
    platform: "linux",
    sleep: async () => undefined,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    startTimeoutMs: 1_000,
    askToConnect: (request) => asked.push(request),
  });
  return { dispatch, sent, asked, update, state: () => state };
}

const linear = {
  name: "linear",
  enabled: true,
  transport: "http",
  url: "https://mcp.linear.app/mcp",
  headers: {},
  oauth: true,
};

describe("agent control", () => {
  it("lists the running agents in the caller's project", async () => {
    const { dispatch } = harness();
    const result = (await dispatch("agentlist", { cwd: "/work/app/src" })) as {
      project: string;
      yourBranch: string;
      agents: Array<{ id: string; kind: string; sameWorktree: boolean; providerName: string }>;
    };
    expect(result.project).toBe("app");
    expect(result.yourBranch).toBe("main");
    expect(result.agents.map((agent) => [agent.id, agent.kind, agent.sameWorktree, agent.providerName])).toEqual([
      [ME, "chat", true, "Codex"],
      [PEER, "chat", false, "Codex"],
      [TERMINAL, "terminal", false, "Claude Code"],
    ]);
  });

  it("reads chat messages and terminal output", async () => {
    const { dispatch, sent } = harness();
    const chat = (await dispatch("agentread", { cwd: "/work/app", agent: PEER, limit: 1 })) as {
      messages: unknown[];
      truncated: boolean;
    };
    expect(chat.messages).toEqual([{ role: "assistant", text: "Done. Tests pass." }]);
    expect(chat.truncated).toBe(true);
    const terminal = (await dispatch("agentread", { cwd: "/work/app", agent: TERMINAL })) as { output: string };
    expect(terminal.output).toBe("> fixing tests");
    expect(sent).toEqual([{ type: "terminal.read", terminalId: TERMINAL }]);
  });

  it("sends a labeled message to an idle chat agent and types it into a terminal agent", async () => {
    const { dispatch, sent } = harness();
    await dispatch("agentsend", { cwd: "/work/app", agent: PEER, text: "Please rebase on main." });
    expect(sent[0]).toEqual({
      type: "thread.queue",
      queueId: expect.any(String),
      threadId: PEER,
      text: `Message from another agent in ZLI, working on branch main (agent id ${ME}):\n\nPlease rebase on main.`,
    });
    await dispatch("agentsend", { cwd: "/work/app", agent: TERMINAL, text: "line one\nline two" });
    expect(sent.slice(1).map((command) => command.data)).toEqual([
      `\u001b[200~Message from another agent in ZLI, working on branch main (agent id ${ME}):\n\nline one\nline two\u001b[201~`,
      "\r",
    ]);
  });

  it("refuses to message itself and queues a message for an agent in the middle of a turn", async () => {
    const { dispatch, update, state, sent } = harness();
    await expect(dispatch("agentsend", { cwd: "/work/app", agent: ME, text: "hi" })).rejects.toThrow(
      "That agent is you.",
    );
    update({
      ...state(),
      threads: state().threads.map((entry) => (entry.threadId === PEER ? { ...entry, status: "working" } : entry)),
    });
    await expect(dispatch("agentsend", { cwd: "/work/app", agent: PEER, text: "hi" })).resolves.toMatchObject({
      delivered: false,
      queued: true,
    });
    expect(sent.at(-1)).toMatchObject({ type: "thread.queue", threadId: PEER });
    await expect(dispatch("agentsend", { cwd: "/work/app", agent: "nope", text: "hi" })).rejects.toThrow(
      "no running agent nope",
    );
  });

  it("starts a chat agent in a new worktree from the caller's branch and gives it the task", async () => {
    const { dispatch, sent, update } = harness({
      onCommand: (command, current) => {
        if (command.type === "worktree.create")
          update({
            ...current,
            worktrees: [
              ...current.worktrees,
              {
                worktreeId: command.worktreeId as string,
                projectId: PROJECT,
                path: command.path as string,
                branch: command.branch as string,
                status: "ready",
              },
            ],
          } as RuntimeProjection);
        if (command.type === "thread.start")
          update({
            ...current,
            threads: [
              ...current.threads,
              {
                ...thread(command.threadId as string, command.worktreeId as string, "idle", "2026-01-02T00:00:00.000Z"),
              },
            ],
          } as RuntimeProjection);
      },
    });
    const result = (await dispatch("agentstart", {
      cwd: "/work/app-worktrees/ui",
      provider: "codex",
      prompt: "Write the API docs",
      branch: "docs/api",
    })) as { started: boolean; worktree: { branch: string; path: string } };
    expect(result.started).toBe(true);
    expect(result.worktree).toEqual({ branch: "docs/api", path: "/work/app-worktrees/docs-api" });
    expect(sent.map((command) => command.type)).toEqual(["worktree.create", "thread.start", "thread.send"]);
    expect(sent[0]).toMatchObject({ baseRef: "ui", workspaceRoot: "/work/app-worktrees", branch: "docs/api" });
    expect(sent[1]).toMatchObject({
      provider: "codex",
      cwd: "/work/app-worktrees/docs-api",
      permissionMode: "full-access",
    });
    expect(sent[2]).toMatchObject({ type: "thread.send", text: "Write the API docs" });
  });

  it("explains why an agent cannot start", async () => {
    const { dispatch, sent } = harness();
    await expect(dispatch("agentstart", { cwd: "/work/app", provider: "gemini", prompt: "x" })).rejects.toThrow(
      "Gemini is not installed here. Install the Gemini CLI.",
    );
    expect(sent).toEqual([]);
  });

  it("follows the access chosen in Settings", async () => {
    const off = harness({ access: "off" });
    expect(await off.dispatch("agentaccess", {})).toEqual({ access: "off", scope: "project" });
    await expect(off.dispatch("agentlist", { cwd: "/work/app" })).rejects.toMatchObject({ status: 403 });

    const read = harness({ access: "read" });
    await expect(read.dispatch("agentlist", { cwd: "/work/app" })).resolves.toBeDefined();
    const blocked = read.dispatch("agentsend", { cwd: "/work/app", agent: PEER, text: "hi" });
    await expect(blocked).rejects.toBeInstanceOf(BrowserControlError);
    await expect(blocked).rejects.toThrow("not start or message them");
    await expect(read.dispatch("agentconnect", { cwd: "/work/app", service: "github" })).resolves.toMatchObject({
      status: "asked",
    });
    await expect(off.dispatch("agentconnect", { cwd: "/work/app", service: "github" })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("asks the person to connect a catalog service and says what to do next", async () => {
    const { dispatch, asked } = harness();
    await expect(
      dispatch("agentconnect", { cwd: "/work/app", service: "GitHub", reason: "I need to open a pull request." }),
    ).resolves.toEqual({
      status: "asked",
      connector: "github",
      message: "Asked the person to connect GitHub in ZLI. Once they connect, start a new session to use it.",
    });
    expect(asked).toEqual([
      { title: "app", body: "Codex asks to connect GitHub. I need to open a pull request.", connectorId: "github" },
    ]);
  });

  it("asks for a sign-in when the server is added but signed out, and does nothing when it is ready", async () => {
    const signedOut = harness({ servers: [linear], signIns: [{ name: "linear", url: linear.url, signedIn: false }] });
    await expect(signedOut.dispatch("agentconnect", { cwd: "/work/app", service: "linear" })).resolves.toMatchObject({
      status: "asked",
      message: "Asked the person to sign in to Linear in ZLI. Once they sign in, try again.",
    });
    expect(signedOut.asked).toEqual([
      { title: "app", body: "Codex asks you to sign in to Linear.", connectorId: "linear" },
    ]);

    const ready = harness({ servers: [linear], signIns: [{ name: "linear", url: linear.url, signedIn: true }] });
    await expect(ready.dispatch("agentconnect", { cwd: "/work/app", service: "Linear" })).resolves.toMatchObject({
      status: "connected",
    });
    expect(ready.asked).toEqual([]);
  });

  it("finds servers the person added by name and rejects unknown services", async () => {
    const custom = { name: "my-db", enabled: false, command: "db-mcp", args: [], env: {} };
    const { dispatch, asked } = harness({ servers: [custom] });
    await expect(dispatch("agentconnect", { cwd: "/elsewhere", service: "My-DB" })).resolves.toMatchObject({
      status: "asked",
      connector: "my-db",
    });
    expect(asked).toEqual([{ title: "ZLI", body: "An agent asks to connect my-db.", connectorId: "my-db" }]);
    await expect(dispatch("agentconnect", { cwd: "/work/app", service: "nope" })).rejects.toThrow(
      "ZLI has no connector called nope.",
    );
  });
});

describe("agent names", () => {
  const named = (names: Record<string, string>) => {
    const h = harness();
    h.update({
      ...h.state(),
      threads: h
        .state()
        .threads.map((entry) => (names[entry.threadId] ? { ...entry, name: names[entry.threadId] } : entry)),
      terminals: h
        .state()
        .terminals.map((entry) => (names[entry.terminalId] ? { ...entry, name: names[entry.terminalId] } : entry)),
    } as RuntimeProjection);
    return h;
  };

  it("lists names and finds an agent by name without regard to case", async () => {
    const { dispatch, sent } = named({ [PEER]: "Bob", [TERMINAL]: "John" });
    const listed = (await dispatch("agentlist", { cwd: "/work/app" })) as {
      agents: Array<{ id: string; name?: string; project: string }>;
    };
    expect(listed.agents.map((agent) => [agent.id, agent.name, agent.project])).toEqual([
      [ME, undefined, "app"],
      [PEER, "Bob", "app"],
      [TERMINAL, "John", "app"],
    ]);
    await expect(dispatch("agentread", { cwd: "/work/app", agent: "bob" })).resolves.toMatchObject({
      agent: { id: PEER, name: "Bob" },
    });
    await dispatch("agentsend", { cwd: "/work/app", agent: "JOHN", text: "hi" });
    expect(sent.at(-2)).toMatchObject({ type: "terminal.write", terminalId: TERMINAL });
  });

  it("signs a message with the sender's name", async () => {
    const { dispatch, sent } = named({ [ME]: "Ana", [PEER]: "Bob" });
    await dispatch("agentsend", { cwd: "/work/app", agent: "Bob", text: "Please rebase." });
    expect(sent[0]).toMatchObject({
      type: "thread.queue",
      threadId: PEER,
      text: "Message from Ana, another agent in ZLI, working on branch main (reply to Ana):\n\nPlease rebase.",
    });
  });

  it("prefers an exact id over a name, and asks for the id when a name is shared", async () => {
    const { dispatch } = named({ [PEER]: TERMINAL, [TERMINAL]: "Bob", [ME]: "bob" });
    await expect(dispatch("agentread", { cwd: "/work/app", agent: TERMINAL })).resolves.toMatchObject({
      agent: { id: TERMINAL },
    });
    await expect(dispatch("agentread", { cwd: "/work/app", agent: "Bob" })).rejects.toThrow(
      `More than one agent is called Bob. Use the id instead: ${ME}, ${TERMINAL}.`,
    );
  });

  it("names a new agent, and refuses a taken name before making a worktree", async () => {
    const { dispatch, sent } = named({ [PEER]: "Bob" });
    await expect(
      dispatch("agentstart", { cwd: "/work/app", provider: "codex", prompt: "x", name: "BOB" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(sent).toEqual([]);

    const started = harness({
      onCommand: (command, current) => {
        if (command.type === "thread.start")
          started.update({
            ...current,
            threads: [
              ...current.threads,
              {
                ...thread(command.threadId as string, command.worktreeId as string, "idle", "2026-01-02T00:00:00.000Z"),
                name: command.name as string,
              },
            ],
          } as RuntimeProjection);
      },
    });
    const result = (await started.dispatch("agentstart", {
      cwd: "/work/app",
      provider: "codex",
      prompt: "Review the auth endpoint",
      worktree: "same",
      name: "John",
    })) as { agent: { name?: string } };
    expect(started.sent[0]).toMatchObject({ type: "thread.start", name: "John" });
    expect(result.agent.name).toBe("John");
  });
});

describe("agents in other projects", () => {
  it("keeps agents to their own project unless Settings allow every project", async () => {
    const { dispatch, sent } = harness();
    await expect(dispatch("agentlist", { cwd: "/work/app", allProjects: true })).rejects.toMatchObject({
      status: 403,
    });
    await expect(dispatch("agentread", { cwd: "/work/app", agent: `other/${FOREIGN}` })).rejects.toThrow(
      "ZLI Settings keep agents to their own project.",
    );
    await expect(
      dispatch("agentsend", { cwd: "/work/app", agent: FOREIGN, project: "other", text: "hi" }),
    ).rejects.toMatchObject({
      status: 403,
    });
    // Without a project, an agent in another project is simply not found.
    await expect(dispatch("agentread", { cwd: "/work/app", agent: FOREIGN })).rejects.toThrow(
      `Project app has no running agent ${FOREIGN}.`,
    );
    expect(sent).toEqual([]);
  });

  it("lists every project's agents with the caller's project first", async () => {
    const { dispatch } = harness({ scope: "all" });
    const listed = (await dispatch("agentlist", { cwd: "/work/other", allProjects: true })) as {
      project: string;
      agents: Array<{ id: string; project: string; projectId: string }>;
    };
    expect(listed.project).toBe("other");
    expect(listed.agents.map((agent) => [agent.id, agent.project])).toEqual([
      [FOREIGN, "other"],
      [ME, "app"],
      [PEER, "app"],
      [TERMINAL, "app"],
    ]);
    expect(listed.agents[1]?.projectId).toBe(PROJECT);
  });

  it("reads and messages an agent in another project by project/agent or the project field", async () => {
    const { dispatch, sent, update, state } = harness({ scope: "all" });
    update({
      ...state(),
      threads: state().threads.map((entry) => (entry.threadId === FOREIGN ? { ...entry, name: "Api" } : entry)),
    } as RuntimeProjection);
    await expect(dispatch("agentread", { cwd: "/work/app", agent: "OTHER/api" })).resolves.toMatchObject({
      agent: { id: FOREIGN, project: "other" },
    });
    await dispatch("agentsend", {
      cwd: "/work/app",
      agent: "api",
      project: OTHER_PROJECT,
      text: "What does /login return?",
    });
    expect(sent[0]).toEqual({
      type: "thread.queue",
      queueId: expect.any(String),
      threadId: FOREIGN,
      text: `Message from an agent in the ZLI project app, working on branch main (reply to app/${ME}):\n\nWhat does /login return?`,
    });
  });

  it("explains a bad project reference", async () => {
    const { dispatch } = harness({ scope: "all" });
    await expect(dispatch("agentread", { cwd: "/work/app", agent: "nope/bob" })).rejects.toMatchObject({
      status: 404,
      message: "ZLI has no project called nope. Call list_agents with allProjects for the project names.",
    });
    await expect(dispatch("agentread", { cwd: "/work/app", agent: "a/b/c" })).rejects.toThrow(
      "Write an agent in another project as project/agent, such as api/bob.",
    );
    await expect(dispatch("agentread", { cwd: "/work/app", agent: "other/x", project: "app" })).rejects.toThrow(
      "other/x points at project other, but project is app. Give the project in one place.",
    );
  });
});

describe("sub-agents", () => {
  const starting = () => {
    const h = harness({
      onCommand: (command, current) => {
        if (command.type === "worktree.create")
          h.update({
            ...current,
            worktrees: [
              ...current.worktrees,
              {
                worktreeId: command.worktreeId as string,
                projectId: PROJECT,
                path: command.path as string,
                branch: command.branch as string,
                status: "ready",
              },
            ],
          } as RuntimeProjection);
        if (command.type === "thread.start")
          h.update({
            ...current,
            threads: [
              ...current.threads,
              {
                ...thread(command.threadId as string, command.worktreeId as string, "idle", "2026-01-02T00:00:00.000Z"),
                ...(command.name ? { name: command.name as string } : {}),
                ...(command.startedBy ? { startedBy: command.startedBy as string } : {}),
              },
            ],
          } as RuntimeProjection);
      },
    });
    return h;
  };

  it("links the new agent to the caller and tells it who to report back to", async () => {
    const h = starting();
    h.update({
      ...h.state(),
      threads: h.state().threads.map((entry) => (entry.threadId === ME ? { ...entry, name: "Bob" } : entry)),
    });
    const result = (await h.dispatch("agentstart", {
      cwd: "/work/app",
      provider: "codex",
      prompt: "Write the API docs",
      name: "John",
    })) as { agent: { id: string; startedBy?: { id: string; name?: string } } };
    expect(h.sent.find((command) => command.type === "thread.start")).toMatchObject({ startedBy: ME });
    expect(h.sent.find((command) => command.type === "thread.send")?.text).toBe(
      "Task from Bob, the agent in ZLI that started you, working on branch main. You are John in ZLI. Reply to Bob when you finish or get stuck:\n\nWrite the API docs",
    );
    expect(result.agent.startedBy).toEqual({ id: ME, name: "Bob" });

    const listed = (await h.dispatch("agentlist", { cwd: "/work/app" })) as {
      agents: Array<{ name?: string; startedBy?: { id: string } }>;
    };
    expect(listed.agents.find((agent) => agent.name === "John")?.startedBy?.id).toBe(ME);

    const johnPath = h.state().worktrees.at(-1)?.path ?? "";
    await h.dispatch("agentsend", { cwd: johnPath, agent: "bob", text: "Docs are done." });
    expect(h.sent.at(-1)?.text).toBe(
      "Message from John, your sub-agent, working on branch codex-000000 (reply to John):\n\nDocs are done.",
    );
    await h.dispatch("agentsend", { cwd: "/work/app", agent: "john", text: "Add examples too." });
    expect(h.sent.at(-1)?.text).toBe(
      "Message from Bob, the agent that started you, working on branch main (reply to Bob):\n\nAdd examples too.",
    );
  });

  it("records no parent when agents share the caller's worktree, and says to pass as", async () => {
    const h = starting();
    const result = (await h.dispatch("agentstart", {
      cwd: "/work/app-worktrees/ui",
      provider: "codex",
      prompt: "Write the API docs",
    })) as { note?: string };
    expect(h.sent.find((command) => command.type === "thread.start")).not.toHaveProperty("startedBy");
    expect(h.sent.find((command) => command.type === "thread.send")?.text).toBe("Write the API docs");
    expect(result.note).toMatch(/^Other agents share your worktree.*Pass as with your own name or id/u);
  });

  it("lets an agent in a shared worktree say who it is with as", async () => {
    const h = starting();
    await h.dispatch("agentstart", {
      cwd: "/work/app-worktrees/ui",
      provider: "codex",
      prompt: "Write the API docs",
      as: PEER,
    });
    expect(h.sent.find((command) => command.type === "thread.start")).toMatchObject({ startedBy: PEER });

    const signed = (await h.dispatch("agentsend", {
      cwd: "/work/app-worktrees/ui",
      agent: ME,
      text: "Login form is done.",
      as: PEER,
    })) as { note?: string };
    expect(h.sent.at(-1)?.text).toBe(
      `Message from another agent in ZLI, working on branch ui (agent id ${PEER}):\n\nLogin form is done.`,
    );
    expect(signed.note).toBeUndefined();
    const unsigned = (await h.dispatch("agentsend", {
      cwd: "/work/app-worktrees/ui",
      agent: ME,
      text: "Login form is done.",
    })) as { note?: string };
    expect(unsigned.note).toMatch(/sent this without your name/u);

    await expect(
      h.dispatch("agentsend", { cwd: "/work/app-worktrees/ui", agent: PEER, text: "Hi", as: ME }),
    ).rejects.toThrow(`No agent in your worktree is called ${ME}.`);
    await expect(
      h.dispatch("agentsend", { cwd: "/work/app-worktrees/ui", agent: PEER, text: "Hi", as: PEER }),
    ).rejects.toThrow("That agent is you.");
  });

  it("starts a sub-agent in the folder itself when the project has no Git", async () => {
    const h = starting();
    h.update({
      ...h.state(),
      projects: h
        .state()
        .projects.map((project) => (project.projectId === PROJECT ? { ...project, git: false } : project)),
    });
    const result = (await h.dispatch("agentstart", {
      cwd: "/work/app",
      provider: "codex",
      prompt: "Tidy the notes",
    })) as {
      worktree: { path: string };
    };
    expect(h.sent.map((command) => command.type)).toEqual(["thread.start", "thread.send"]);
    expect(h.sent[0]).toMatchObject({ worktreeId: MAIN, startedBy: ME, shareWorktree: true });
    expect(result.worktree.path).toBe("/work/app");
    expect(h.sent[1]?.text).toMatch(/^Task from the agent in ZLI that started you, working in the folder app\. /u);
    expect(h.sent[1]?.text).toMatch(
      /Other agents work in this folder too, so sign your messages with your name: the as field, or zli --as [0-9a-f-]+\./u,
    );
    await expect(
      h.dispatch("agentstart", { cwd: "/work/app", provider: "codex", prompt: "x", branch: "docs" }),
    ).rejects.toThrow("app is a folder without Git, so it has no worktrees or branches.");
  });
});

describe("huddles", () => {
  const HUDDLE = "00000000-0000-4000-8000-0000000000e1";
  const post = (number: number, from: string | undefined, text: string, extra: Record<string, unknown> = {}) => ({
    postId: `00000000-0000-4000-8000-0000000001${String(number).padStart(2, "0")}`,
    huddleId: HUDDLE,
    number,
    from: from === undefined ? { kind: "person" } : { kind: "agent", agentId: from },
    to: "everyone",
    kind: "ask",
    text,
    createdAt: "2026-01-03T00:00:00.000Z",
    deliveries: [],
    ...extra,
  });
  const inHuddle = (members: string[], posts: unknown[] = [], options: { scope?: string; access?: string } = {}) => {
    const h = harness({
      ...options,
      onCommand: (command, current) => {
        if (command.type === "thread.start")
          h.update({
            ...current,
            threads: [
              ...current.threads,
              {
                ...thread(command.threadId as string, command.worktreeId as string, "idle", "2026-01-02T00:00:00.000Z"),
                name: command.name,
                startedBy: command.startedBy,
              },
            ],
          } as RuntimeProjection);
      },
    });
    const state = h.state();
    h.update({
      ...state,
      threads: state.threads.map((entry) =>
        entry.threadId === ME
          ? { ...entry, name: "Lead" }
          : entry.threadId === PEER
            ? { ...entry, name: "Helper" }
            : entry,
      ),
      huddles: [
        {
          huddleId: HUDDLE,
          name: "Login",
          members: members.map((agentId) => ({
            agentId,
            kind: agentId === TERMINAL ? "terminal" : "chat",
            joinedAt: "2026-01-03T00:00:00.000Z",
          })),
          createdAt: "2026-01-03T00:00:00.000Z",
          updatedAt: "2026-01-03T00:00:00.000Z",
          agentStreak: 0,
          nextNumber: posts.length + 1,
        },
      ],
      huddlePosts: posts,
    } as unknown as RuntimeProjection);
    return h;
  };

  it("reads only what the agent has not read yet, with names relative to the reader", async () => {
    const h = inHuddle(
      [ME, PEER],
      [post(1, undefined, "Plan the login form"), post(2, PEER, "I take the API", { to: [ME] })],
    );
    const first = (await h.dispatch("huddleread", { cwd: "/work/app" })) as {
      huddle: string;
      id: string;
      members: Array<{ name: string; you?: boolean }>;
      messages: Array<{ number: number; from: string; to: unknown; text: string }>;
    };
    expect(first.huddle).toBe("Login");
    expect(first.id).toBe("00000000");
    expect(first.members.map((member) => [member.name, member.you ?? false])).toEqual([
      ["Lead", true],
      ["Helper", false],
    ]);
    expect(first.messages.map((message) => [message.number, message.from, message.to])).toEqual([
      [1, "the person", "everyone"],
      [2, "Helper", ["you"]],
    ]);
    const again = (await h.dispatch("huddleread", { cwd: "/work/app" })) as { messages: unknown[] };
    expect(again.messages).toEqual([]);
  });

  it("posts as the caller, to members by name, as a note unless told otherwise", async () => {
    const h = inHuddle([ME, PEER, TERMINAL], [post(1, undefined, "Plan")]);
    await h.dispatch("huddlepost", { cwd: "/work/app", text: "Helper, take the API", to: ["helper"], replyTo: 1 });
    expect(h.sent.at(-1)).toMatchObject({
      type: "huddle.post",
      huddleId: HUDDLE,
      from: ME,
      to: [PEER],
      kind: "note",
      text: "Helper, take the API",
      replyTo: "00000000-0000-4000-8000-000000000101",
    });
    await h.dispatch("huddlepost", { cwd: "/work/app", text: "Done?", to: ["person"], kind: "ask" });
    expect(h.sent.at(-1)).toMatchObject({ to: "person", kind: "ask" });
    await expect(h.dispatch("huddlepost", { cwd: "/work/app", text: "hi", to: ["stranger"] })).rejects.toThrow(
      "stranger is not in the huddle Login. Its other members: Helper, Claude Code.",
    );
  });

  it("ends access as soon as the agent leaves, and keeps read access from posting", async () => {
    const h = inHuddle([PEER, TERMINAL]);
    await expect(h.dispatch("huddleread", { cwd: "/work/app" })).rejects.toThrow(
      "You are not in a huddle. The person adds agents to huddles in ZLI.",
    );
    await expect(h.dispatch("huddleread", { cwd: "/work/app", huddle: "Login" })).rejects.toThrow(
      "You are not in the huddle Login, so you cannot read or post there.",
    );
    const reader = inHuddle([ME, PEER], [], { access: "read" });
    await expect(reader.dispatch("huddlepost", { cwd: "/work/app", text: "hi" })).rejects.toThrow(
      "ZLI Settings let agents list and read other agents, but not start or message them.",
    );
  });

  it("waits until someone else writes, and stops waiting when taken out", async () => {
    const h = inHuddle([ME, PEER], [post(1, undefined, "Plan")]);
    await h.dispatch("huddleread", { cwd: "/work/app" });
    const waiting = h.dispatch("huddlewait", { cwd: "/work/app", timeoutSeconds: 5 }) as Promise<{
      messages: Array<{ text: string }>;
    }>;
    const state = h.state();
    h.update({ ...state, huddlePosts: [...(state.huddlePosts ?? []), post(2, ME, "mine")] } as RuntimeProjection);
    h.update({
      ...h.state(),
      huddlePosts: [...(h.state().huddlePosts ?? []), post(3, PEER, "API is ready")],
    } as RuntimeProjection);
    expect((await waiting).messages.map((message) => message.text)).toEqual(["mine", "API is ready"]);

    const left = h.dispatch("huddlewait", { cwd: "/work/app", timeoutSeconds: 5 });
    // The wait starts after the settings check, so the removal has to come later.
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.update({
      ...h.state(),
      huddles: h.state().huddles?.map((huddle) => ({ ...huddle, members: huddle.members.slice(1) })),
    } as RuntimeProjection);
    await expect(left).rejects.toThrow("You were taken out of the huddle, so you can no longer read it.");
  });

  it("lists pinned decisions", async () => {
    const h = inHuddle([ME, PEER], [post(1, undefined, "Plan"), post(2, PEER, "Use OAuth", { decision: true })]);
    const result = (await h.dispatch("huddledecisions", { cwd: "/work/app" })) as {
      decisions: Array<{ number: number; text: string }>;
    };
    expect(result.decisions.map((decision) => [decision.number, decision.text])).toEqual([[2, "Use OAuth"]]);
  });

  it("starts a named sub-agent, adds it to the huddle, and gives it the task there", async () => {
    const h = inHuddle([ME, PEER]);
    const result = (await h.dispatch("huddlepost", {
      cwd: "/work/app",
      text: "Write the login tests",
      start: { name: "Tester", provider: "codex", worktree: "same" },
    })) as { started?: { name?: string; startedBy?: { id: string } } };
    const started = h.sent.find((command) => command.type === "thread.start");
    expect(started).toMatchObject({ name: "Tester", startedBy: ME, worktreeId: MAIN });
    expect(h.sent.some((command) => command.type === "thread.send")).toBe(false);
    expect(h.sent.find((command) => command.type === "huddle.join")).toEqual({
      type: "huddle.join",
      huddleId: HUDDLE,
      agentId: started?.threadId,
    });
    expect(h.sent.at(-1)).toMatchObject({ type: "huddle.post", to: [started?.threadId], kind: "assign" });
    expect(result.started).toMatchObject({ name: "Tester", startedBy: { id: ME } });
    await expect(
      h.dispatch("huddlepost", {
        cwd: "/work/app",
        text: "x",
        as: "Lead",
        kind: "note",
        start: { name: "Other", provider: "codex" },
      }),
    ).rejects.toThrow("start goes with kind assign");
  });
});
