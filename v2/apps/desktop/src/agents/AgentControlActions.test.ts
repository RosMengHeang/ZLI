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

type ReachAsk = { agent: string; project: string; target?: { agent: string; project: string } };

function harness(
  options: {
    access?: string;
    scope?: string;
    onCommand?: (command: Sent, state: RuntimeProjection) => void;
    servers?: unknown[];
    signIns?: unknown[];
    reach?: (request: ReachAsk) => Promise<"allowed" | "declined" | "unanswered">;
    /** Replies for commands by type, for commands whose answer matters. */
    results?: Record<string, unknown>;
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
            signIns: options.signIns ?? [],
          },
        } as RpcResponse;
      // Reading branches changes nothing, so it stays out of the commands the tests check.
      if (command.type === "review.git.branches")
        return {
          commandId: request.commandId,
          accepted: true,
          result: options.results?.["review.git.branches"] ?? { local: [], remote: [] },
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
      const result = options.results?.[command.type];
      return { commandId: request.commandId, accepted: true, ...(result ? { result } : {}) } as RpcResponse;
    },
    platform: "linux",
    sleep: async () => undefined,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    startTimeoutMs: 1_000,
    askToConnect: (request) => asked.push(request),
    ...(options.reach ? { askToReach: options.reach } : {}),
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
      `\u001b[200~Message from another agent in ZLI, working on branch main (agent id ${ME}):\r\rline one\rline two\u001b[201~`,
      "\r",
    ]);
  });

  it("keeps a paste-end sequence in a message literal, so the text cannot run as typed commands", async () => {
    const { dispatch, sent } = harness();
    await dispatch("agentsend", { cwd: "/work/app", agent: TERMINAL, text: "done\u001b[201~\rrm -rf ~\u0007" });
    const [paste] = sent.map((command) => command.data as string);
    expect(paste?.split("\u001b[201~")).toHaveLength(2);
    expect(paste?.endsWith("done[201~\rrm -rf ~\u001b[201~")).toBe(true);
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
      "No ZLI project has a running agent called nope",
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

  it("checks out a branch that exists instead of making it again from the caller's branch", async () => {
    const { dispatch, sent, update } = harness({
      results: { "review.git.branches": { current: "ui", local: ["ui", "main", "release"], remote: ["hotfix"] } },
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
              thread(command.threadId as string, command.worktreeId as string, "idle", "2026-01-02T00:00:00.000Z"),
            ],
          } as RuntimeProjection);
      },
    });
    await dispatch("agentstart", { cwd: "/work/app-worktrees/ui", provider: "codex", prompt: "x", branch: "release" });
    expect(sent[0]).toMatchObject({ type: "worktree.create", branch: "release", checkoutExistingBranch: true });
    expect(sent[0]).not.toHaveProperty("baseRef");
    await dispatch("agentstart", { cwd: "/work/app-worktrees/ui", provider: "codex", prompt: "x", branch: "hotfix" });
    expect(sent.filter((command) => command.type === "worktree.create").at(-1)).toMatchObject({
      branch: "hotfix",
      checkoutExistingBranch: true,
    });
  });

  it("refuses a branch that is already checked out, naming the folder, and makes no worktree", async () => {
    const { dispatch, sent } = harness({
      results: {
        "review.git.branches": {
          current: "ui",
          local: ["ui", "main"],
          remote: [],
          details: { main: { worktreePath: "/work/app" } },
        },
      },
    });
    await expect(
      dispatch("agentstart", { cwd: "/work/app-worktrees/ui", provider: "codex", prompt: "x", branch: "main" }),
    ).rejects.toThrow("main is already checked out in /work/app");
    await expect(
      dispatch("agentstart", { cwd: "/work/app-worktrees/ui", provider: "codex", prompt: "x", branch: "ui" }),
    ).rejects.toThrow("You are already on ui");
    expect(sent.some((command) => command.type === "worktree.create")).toBe(false);
  });

  it("never starts an agent with more access than the agents in the caller's worktree", async () => {
    const start = async (me: { status: string; permissionMode?: string }) => {
      const { dispatch, sent, update, state } = harness({
        onCommand: (command, current) => {
          if (command.type !== "thread.start") return;
          update({
            ...current,
            threads: [
              ...current.threads,
              thread(command.threadId as string, command.worktreeId as string, "idle", "2026-01-02T00:00:00.000Z"),
            ],
          } as RuntimeProjection);
        },
      });
      update({
        ...state(),
        threads: state().threads.map((entry) => (entry.threadId === ME ? { ...entry, ...me } : entry)),
      } as RuntimeProjection);
      await dispatch("agentstart", { cwd: "/work/app", provider: "codex", prompt: "Review it", worktree: "same" });
      return sent.find((command) => command.type === "thread.start")?.permissionMode;
    };
    expect(await start({ status: "idle", permissionMode: "read-only" })).toBe("read-only");
    expect(await start({ status: "idle", permissionMode: "supervised" })).toBe("supervised");
    expect(await start({ status: "idle" })).toBe("full-access");
    expect(await start({ status: "stopped", permissionMode: "full-access" })).toBe("supervised");
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

  it("finds and uses connected services' tools for the caller's worktree, even with agent tools off", async () => {
    const { dispatch, sent } = harness({
      access: "off",
      results: {
        "mcp.tools.find": { services: [{ name: "vercel", status: "ready", toolCount: 1 }], tools: [] },
        "mcp.tools.call": { content: [{ type: "text", text: "ok" }] },
      },
    });
    await expect(dispatch("toolfind", { cwd: "/work/app-worktrees/ui", query: "deploy" })).resolves.toMatchObject({
      services: [{ name: "vercel" }],
    });
    await expect(
      dispatch("tooluse", { cwd: "/work/app-worktrees/ui", service: "vercel", tool: "deploy", arguments: { a: 1 } }),
    ).resolves.toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(sent).toEqual([
      { type: "mcp.tools.find", query: "deploy", worktreeId: FEATURE },
      { type: "mcp.tools.call", server: "vercel", tool: "deploy", arguments: { a: 1 }, worktreeId: FEATURE },
    ]);
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
      text: "Message to Bob from Ana, another agent in ZLI, working on branch main (reply to Ana):\n\nPlease rebase.",
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
    // Without a project, an agent in another project is found, and still needs Settings to allow it.
    await expect(dispatch("agentread", { cwd: "/work/app", agent: FOREIGN })).rejects.toMatchObject({ status: 403 });
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
      text: `Message to Api from an agent in the ZLI project app, working on branch main (reply to app/${ME}):\n\nWhat does /login return?`,
    });
  });

  const withNames = (h: ReturnType<typeof harness>, names: Record<string, string>) =>
    h.update({
      ...h.state(),
      threads: h
        .state()
        .threads.map((entry) => (names[entry.threadId] ? { ...entry, name: names[entry.threadId] } : entry)),
    } as RuntimeProjection);

  it("finds an agent in another project by its name alone", async () => {
    const h = harness({ scope: "all" });
    withNames(h, { [ME]: "Bob", [FOREIGN]: "Kim" });
    await h.dispatch("agentsend", { cwd: "/work/app", agent: "KIM", text: "hi" });
    expect(h.sent[0]).toEqual({
      type: "thread.queue",
      queueId: expect.any(String),
      threadId: FOREIGN,
      text: "Message to Kim from Bob, an agent in the ZLI project app, working on branch main (reply to app/Bob):\n\nhi",
    });
  });

  it("asks the person before reaching another project, and goes on once they allow it", async () => {
    const asks: ReachAsk[] = [];
    const settings = { scope: "project" };
    const h = harness({
      get scope() {
        return settings.scope;
      },
      reach: async (request) => {
        asks.push(request);
        settings.scope = "all";
        return "allowed";
      },
    });
    withNames(h, { [ME]: "Bob", [FOREIGN]: "Kim" });
    await expect(h.dispatch("agentsend", { cwd: "/work/app", agent: "Kim", text: "hi" })).resolves.toMatchObject({
      delivered: true,
      agent: { id: FOREIGN, project: "other" },
    });
    expect(asks).toEqual([{ agent: "Bob", project: "app", target: { agent: "Kim", project: "other" } }]);
    await h.dispatch("agentread", { cwd: "/work/app", agent: "other/kim" });
    expect(asks).toHaveLength(1);
  });

  it("says what happened when the person declines or does not answer", async () => {
    let outcome: "declined" | "unanswered" = "declined";
    const h = harness({ reach: async () => outcome });
    withNames(h, { [FOREIGN]: "Kim" });
    await expect(h.dispatch("agentsend", { cwd: "/work/app", agent: "kim", text: "hi" })).rejects.toMatchObject({
      status: 403,
      message:
        "Kim works in another ZLI project, and the person chose to keep agents to their own project. Tell them what you needed. They can change this in ZLI Settings, under Agents.",
    });
    outcome = "unanswered";
    await expect(h.dispatch("agentread", { cwd: "/work/app", agent: "kim" })).rejects.toThrow(
      "they have not answered yet",
    );
    expect(h.sent).toEqual([]);
  });

  it("goes on when the person changed Settings instead of answering", async () => {
    const settings = { scope: "project" };
    const h = harness({
      get scope() {
        return settings.scope;
      },
      reach: async () => {
        settings.scope = "all";
        return "unanswered";
      },
    });
    withNames(h, { [FOREIGN]: "Kim" });
    await expect(h.dispatch("agentread", { cwd: "/work/app", agent: "kim" })).resolves.toMatchObject({
      agent: { id: FOREIGN },
    });
  });

  it("does not ask about an agent that does not exist, and names every match of a shared name", async () => {
    const asks: ReachAsk[] = [];
    const h = harness({
      reach: async (request) => {
        asks.push(request);
        return "allowed";
      },
    });
    await expect(h.dispatch("agentread", { cwd: "/work/app", agent: "other/nobody" })).rejects.toThrow(
      "ZLI Settings keep agents to their own project.",
    );
    await expect(h.dispatch("agentread", { cwd: "/work/app", agent: "nobody" })).rejects.toMatchObject({
      status: 404,
      message: "No ZLI project has a running agent called nobody. Call list_agents for the names and ids.",
    });
    expect(asks).toEqual([]);

    const third = "00000000-0000-4000-8000-0000000000a3";
    const thirdWorktree = "00000000-0000-4000-8000-0000000000b4";
    const twin = "00000000-0000-4000-8000-0000000000c5";
    h.update({
      ...h.state(),
      projects: [...h.state().projects, { projectId: third, path: "/work/third", name: "third" }],
      worktrees: [
        ...h.state().worktrees,
        { worktreeId: thirdWorktree, projectId: third, path: "/work/third", branch: "main", status: "ready" },
      ],
      threads: [
        ...h.state().threads.map((entry) => (entry.threadId === FOREIGN ? { ...entry, name: "Kim" } : entry)),
        { ...thread(twin, thirdWorktree, "idle", "2026-01-01T00:00:05.000Z"), name: "kim" },
      ],
    } as RuntimeProjection);
    await expect(h.dispatch("agentread", { cwd: "/work/app", agent: "Kim" })).rejects.toThrow(
      "More than one agent in other projects is called Kim: other/Kim, third/kim. Write the one you mean as project/agent.",
    );
    expect(asks).toEqual([{ agent: "Codex", project: "app" }]);
  });

  it("tells the caller who it is and that other projects exist", async () => {
    const h = harness();
    withNames(h, { [ME]: "Bob" });
    const listed = (await h.dispatch("agentlist", { cwd: "/work/app" })) as {
      you?: { id: string; name?: string };
      agents: Array<{ id: string; you?: true }>;
      otherProjects?: string;
    };
    expect(listed.you).toEqual({ name: "Bob", id: ME });
    expect(listed.agents.filter((agent) => agent.you).map((agent) => agent.id)).toEqual([ME]);
    expect(listed.otherProjects).toContain("ZLI asks the person");
  });

  it("asks before listing every project", async () => {
    const asks: ReachAsk[] = [];
    const h = harness({
      reach: async (request) => {
        asks.push(request);
        return "allowed";
      },
    });
    const listed = (await h.dispatch("agentlist", { cwd: "/work/app", allProjects: true })) as {
      agents: Array<{ id: string }>;
    };
    expect(asks).toEqual([{ agent: "Codex", project: "app" }]);
    expect(listed.agents.map((agent) => agent.id)).toContain(FOREIGN);
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

  describe("every way a reach can go", () => {
    const ANA = "00000000-0000-4000-8000-0000000000c6";
    const TESS = "00000000-0000-4000-8000-0000000000d2";
    type Outcome = "allowed" | "declined" | "unanswered";

    /** A harness whose Settings keep agents to their own project until the person allows it. */
    const asking = (answer: (h: ReturnType<typeof harness>) => Outcome, access = "full") => {
      const settings = { scope: "project", access };
      const asks: ReachAsk[] = [];
      const h: ReturnType<typeof harness> = harness({
        get scope() {
          return settings.scope;
        },
        get access() {
          return settings.access;
        },
        reach: async (request) => {
          asks.push(request);
          const outcome = answer(h);
          if (outcome === "allowed") settings.scope = "all";
          return outcome;
        },
      });
      return { ...h, asks };
    };
    const patch = (h: ReturnType<typeof harness>, threadId: string, changes: Record<string, unknown>) =>
      h.update({
        ...h.state(),
        threads: h.state().threads.map((entry) => (entry.threadId === threadId ? { ...entry, ...changes } : entry)),
      } as RuntimeProjection);

    it("prefers a name in the caller's project and never asks about it", async () => {
      const h = asking(() => "allowed");
      withNames(h, { [PEER]: "Kim", [FOREIGN]: "Kim" });
      await expect(h.dispatch("agentread", { cwd: "/work/app", agent: "kim" })).resolves.toMatchObject({
        agent: { id: PEER },
      });
      await expect(h.dispatch("agentread", { cwd: "/work/app", agent: "app/KIM" })).resolves.toMatchObject({
        agent: { id: PEER },
      });
      expect(h.asks).toEqual([]);
      await expect(h.dispatch("agentread", { cwd: "/work/app", agent: "other/kim" })).resolves.toMatchObject({
        agent: { id: FOREIGN },
      });
      expect(h.asks).toHaveLength(1);
    });

    it("matches a name in another project without regard to case or extra spaces", async () => {
      const h = asking(() => "allowed");
      withNames(h, { [FOREIGN]: "Kim Lee" });
      await expect(h.dispatch("agentread", { cwd: "/work/app", agent: "  KIM   lee " })).resolves.toMatchObject({
        agent: { id: FOREIGN },
      });
      expect(h.asks).toEqual([{ agent: "Codex", project: "app", target: { agent: "Kim Lee", project: "other" } }]);
    });

    it("signs the question and the message with as when agents share a worktree", async () => {
      const h = asking(() => "allowed");
      h.update({
        ...h.state(),
        threads: [...h.state().threads, { ...thread(ANA, MAIN, "idle", "2026-01-01T00:00:06.000Z"), name: "Ana" }],
      } as RuntimeProjection);
      withNames(h, { [ME]: "Bob", [FOREIGN]: "Kim" });
      await expect(
        h.dispatch("agentsend", { cwd: "/work/app", agent: "Kim", text: "hi", as: "nobody" }),
      ).rejects.toThrow("No agent in your worktree is called nobody.");
      expect(h.asks).toEqual([]);
      await h.dispatch("agentsend", { cwd: "/work/app", agent: "Kim", text: "hi", as: "ana" });
      expect(h.asks).toEqual([{ agent: "Ana", project: "app", target: { agent: "Kim", project: "other" } }]);
      expect(h.sent[0]?.text).toBe(
        "Message to Kim from Ana, an agent in the ZLI project app, working on branch main (reply to app/Ana):\n\nhi",
      );
    });

    it("asks for an agent it cannot name and sends the message unsigned", async () => {
      const h = asking(() => "allowed");
      h.update({
        ...h.state(),
        threads: [...h.state().threads, { ...thread(ANA, MAIN, "idle", "2026-01-01T00:00:06.000Z"), name: "Ana" }],
      } as RuntimeProjection);
      withNames(h, { [FOREIGN]: "Kim" });
      await expect(h.dispatch("agentsend", { cwd: "/work/app", agent: "Kim", text: "hi" })).resolves.toMatchObject({
        note: expect.stringContaining("Pass as with your own name or id"),
      });
      expect(h.asks[0]?.agent).toBe("An agent");
      expect(h.sent[0]?.text).toBe(
        "Message to Kim from an agent in the ZLI project app, working on branch main:\n\nhi",
      );
    });

    it("stops when the agent stopped while the person answered", async () => {
      const h = asking((current) => {
        patch(current, FOREIGN, { status: "stopped" });
        return "allowed";
      });
      withNames(h, { [FOREIGN]: "Kim" });
      await expect(h.dispatch("agentsend", { cwd: "/work/app", agent: "Kim", text: "hi" })).rejects.toMatchObject({
        status: 409,
        message: "Kim stopped while ZLI waited for the person's answer. Call list_agents to see who is running.",
      });
      expect(h.sent).toEqual([]);
    });

    it("uses what the agent is doing and called once the person answered", async () => {
      const h = asking((current) => {
        patch(current, FOREIGN, { status: "working", name: "Kimberly" });
        return "allowed";
      });
      withNames(h, { [FOREIGN]: "Kim" });
      await expect(h.dispatch("agentsend", { cwd: "/work/app", agent: "Kim", text: "hi" })).resolves.toMatchObject({
        delivered: false,
        queued: true,
        agent: { name: "Kimberly", status: "working" },
      });
      expect(h.sent[0]?.text).toMatch(/^Message to Kimberly from /u);
    });

    it("reads what the agent wrote while the person answered", async () => {
      const h = asking((current) => {
        current.update({
          ...current.state(),
          messages: [{ messageId: "m3", threadId: FOREIGN, role: "assistant", text: "Login returns a token." }],
        } as RuntimeProjection);
        return "allowed";
      });
      withNames(h, { [FOREIGN]: "Kim" });
      await expect(h.dispatch("agentread", { cwd: "/work/app", agent: "Kim" })).resolves.toMatchObject({
        messages: [{ role: "assistant", text: "Login returns a token." }],
      });
    });

    it("does not ask about a failed agent for a message, and still lets the person allow reading it", async () => {
      const h = asking(() => "allowed");
      withNames(h, { [FOREIGN]: "Kim" });
      patch(h, FOREIGN, { status: "failed" });
      await expect(h.dispatch("agentsend", { cwd: "/work/app", agent: "Kim", text: "hi" })).rejects.toMatchObject({
        status: 409,
        message: "That agent failed and cannot take messages.",
      });
      await expect(h.dispatch("agentsend", { cwd: "/work/app", agent: "other/Kim", text: "hi" })).rejects.toThrow(
        "That agent failed",
      );
      expect(h.asks).toEqual([]);
      await expect(h.dispatch("agentread", { cwd: "/work/app", agent: "Kim" })).resolves.toMatchObject({
        agent: { id: FOREIGN, status: "failed" },
      });
      expect(h.asks).toHaveLength(1);
    });

    it("reads and messages a terminal agent in another project, once it finished starting", async () => {
      const h = asking((current) => {
        current.update({
          ...current.state(),
          terminals: current
            .state()
            .terminals.map((entry) => (entry.terminalId === TESS ? { ...entry, status: "running" } : entry)),
        } as RuntimeProjection);
        return "allowed";
      });
      h.update({
        ...h.state(),
        terminals: [
          ...h.state().terminals,
          {
            terminalId: TESS,
            worktreeId: ELSEWHERE,
            title: "Claude Code",
            status: "starting",
            lastSequence: 0,
            kind: "agent",
            agent: { provider: "claude-code" },
            name: "Tess",
            createdAt: "2026-01-01T00:00:07.000Z",
          },
        ],
      } as RuntimeProjection);
      await expect(h.dispatch("agentsend", { cwd: "/work/app", agent: "tess", text: "hi" })).resolves.toMatchObject({
        delivered: true,
        agent: { id: TESS, kind: "terminal", project: "other" },
      });
      expect(
        h.sent.filter((command) => command.type === "terminal.write").map((command) => command.terminalId),
      ).toEqual([TESS, TESS]);
      await expect(h.dispatch("agentread", { cwd: "/work/app", agent: "Tess" })).resolves.toMatchObject({
        output: "> fixing tests",
      });
    });

    it("never asks while agent tools are off, or for a message while agents may only read", async () => {
      const off = asking(() => "allowed", "off");
      withNames(off, { [FOREIGN]: "Kim" });
      await expect(off.dispatch("agentread", { cwd: "/work/app", agent: "Kim" })).rejects.toThrow(
        "Agent tools are turned off in ZLI Settings, under Agents.",
      );
      expect(off.asks).toEqual([]);

      const reading = asking(() => "allowed", "read");
      withNames(reading, { [FOREIGN]: "Kim" });
      await expect(reading.dispatch("agentsend", { cwd: "/work/app", agent: "Kim", text: "hi" })).rejects.toThrow(
        "not start or message them",
      );
      expect(reading.asks).toEqual([]);
      await expect(reading.dispatch("agentread", { cwd: "/work/app", agent: "Kim" })).resolves.toMatchObject({
        agent: { id: FOREIGN },
      });
      expect(reading.asks).toHaveLength(1);
    });

    it("says no for a shared name or the list of every project when the person declines", async () => {
      const h = asking(() => "declined");
      const third = "00000000-0000-4000-8000-0000000000a3";
      const thirdWorktree = "00000000-0000-4000-8000-0000000000b4";
      const twin = "00000000-0000-4000-8000-0000000000c5";
      h.update({
        ...h.state(),
        projects: [...h.state().projects, { projectId: third, path: "/work/third", name: "third" }],
        worktrees: [
          ...h.state().worktrees,
          { worktreeId: thirdWorktree, projectId: third, path: "/work/third", branch: "main", status: "ready" },
        ],
        threads: [
          ...h.state().threads,
          { ...thread(twin, thirdWorktree, "idle", "2026-01-01T00:00:05.000Z"), name: "Kim" },
        ],
      } as RuntimeProjection);
      withNames(h, { [FOREIGN]: "Kim" });
      const declined =
        "That needs another ZLI project, and the person chose to keep agents to their own project. Tell them what you needed. They can change this in ZLI Settings, under Agents.";
      await expect(h.dispatch("agentread", { cwd: "/work/app", agent: "Kim" })).rejects.toThrow(declined);
      await expect(h.dispatch("agentlist", { cwd: "/work/app", allProjects: true })).rejects.toMatchObject({
        status: 403,
        message: declined,
      });
    });

    it("lets the other agent reply by name once every project is allowed", async () => {
      const h = harness({ scope: "all" });
      withNames(h, { [ME]: "Bob", [FOREIGN]: "Kim" });
      await h.dispatch("agentsend", { cwd: "/work/other", agent: "Bob", text: "On it." });
      await h.dispatch("agentsend", { cwd: "/work/other", agent: "app/bob", text: "Done." });
      expect(h.sent.map((command) => [command.threadId, command.text])).toEqual([
        [
          ME,
          "Message to Bob from Kim, an agent in the ZLI project other, working on branch main (reply to other/Kim):\n\nOn it.",
        ],
        [
          ME,
          "Message to Bob from Kim, an agent in the ZLI project other, working on branch main (reply to other/Kim):\n\nDone.",
        ],
      ]);
    });

    it("names the project when an agent there is missing and every project is allowed", async () => {
      const h = harness({ scope: "all" });
      await expect(h.dispatch("agentread", { cwd: "/work/app", agent: "other/nobody" })).rejects.toMatchObject({
        status: 404,
        message: "Project other has no running agent nobody. Call list_agents for the names and ids.",
      });
      await expect(h.dispatch("agentread", { cwd: "/work/app", agent: "nobody" })).rejects.toMatchObject({
        status: 404,
        message: "No ZLI project has a running agent called nobody. Call list_agents for the names and ids.",
      });
    });

    it("lists every project without asking again once the person allowed it", async () => {
      const h = asking(() => "allowed");
      await h.dispatch("agentlist", { cwd: "/work/app", allProjects: true });
      await h.dispatch("agentlist", { cwd: "/work/app", allProjects: true });
      expect(h.asks).toHaveLength(1);
    });
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
      "Message to Bob from John, your sub-agent, working on branch codex-000000 (reply to John):\n\nDocs are done.",
    );
    await h.dispatch("agentsend", { cwd: "/work/app", agent: "john", text: "Add examples too." });
    expect(h.sent.at(-1)?.text).toBe(
      "Message to John from Bob, the agent that started you, working on branch main (reply to Bob):\n\nAdd examples too.",
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
