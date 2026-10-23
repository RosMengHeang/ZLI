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

function harness(options: { access?: string; onCommand?: (command: Sent, state: RuntimeProjection) => void } = {}) {
  let state = baseProjection();
  const listeners = new Set<() => void>();
  const sent: Sent[] = [];
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
            servers: [],
            agentAccess: options.access ?? "full",
            userSettings: { enabled: false, outcomes: [] },
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
  });
  return { dispatch, sent, update, state: () => state };
}

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
      type: "thread.send",
      threadId: PEER,
      text: `Message from another agent in ZLI, working on branch main (agent id ${ME}):\n\nPlease rebase on main.`,
    });
    await dispatch("agentsend", { cwd: "/work/app", agent: TERMINAL, text: "line one\nline two" });
    expect(sent.slice(1).map((command) => command.data)).toEqual([
      `\u001b[200~Message from another agent in ZLI, working on branch main (agent id ${ME}):\n\nline one\nline two\u001b[201~`,
      "\r",
    ]);
  });

  it("refuses to message itself or an agent in the middle of a turn", async () => {
    const { dispatch, update, state } = harness();
    await expect(dispatch("agentsend", { cwd: "/work/app", agent: ME, text: "hi" })).rejects.toThrow(
      "That agent is you.",
    );
    update({
      ...state(),
      threads: state().threads.map((entry) => (entry.threadId === PEER ? { ...entry, status: "working" } : entry)),
    });
    await expect(dispatch("agentsend", { cwd: "/work/app", agent: PEER, text: "hi" })).rejects.toThrow(
      "in the middle of a turn",
    );
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
    expect(await off.dispatch("agentaccess", {})).toEqual({ access: "off" });
    await expect(off.dispatch("agentlist", { cwd: "/work/app" })).rejects.toMatchObject({ status: 403 });

    const read = harness({ access: "read" });
    await expect(read.dispatch("agentlist", { cwd: "/work/app" })).resolves.toBeDefined();
    const blocked = read.dispatch("agentsend", { cwd: "/work/app", agent: PEER, text: "hi" });
    await expect(blocked).rejects.toBeInstanceOf(BrowserControlError);
    await expect(blocked).rejects.toThrow("not start or message them");
  });
});
