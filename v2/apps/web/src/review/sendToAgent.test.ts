// @vitest-environment jsdom

import type { RuntimeProjection, TerminalProjection, ThreadProjection, WorktreeProjection } from "@zli-v2/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  defaultSendTarget,
  lastSendTarget,
  messageForTarget,
  rememberSendTarget,
  type SendTarget,
  sendTargetGroups,
  sendTargets,
  sentNotice,
} from "./sendToAgent.js";

const chat: SendTarget = {
  key: "s1:chat",
  sessionId: "s1",
  mode: "chat",
  threadId: "t1",
  agent: "Codex",
  title: "Fix the login form",
  detail: "Codex chat · Ready",
  updatedAt: "2026-01-02T00:00:00.000Z",
  worktreeId: "w1",
  branch: "main",
};
const terminal: SendTarget = {
  key: "s2:terminal",
  sessionId: "s2",
  mode: "terminal",
  terminalId: "x2",
  agent: "Claude Code",
  title: "Claude Code",
  detail: "Claude Code terminal · Working",
  updatedAt: "2026-01-01T00:00:00.000Z",
  worktreeId: "w1",
  branch: "main",
};
const elsewhere: SendTarget = { ...chat, key: "s3:chat", sessionId: "s3", worktreeId: "w2", branch: "cursor-foia" };

afterEach(() => window.localStorage.clear());

const worktree = (worktreeId: string, branch: string, projectId = "p1", extra: Partial<WorktreeProjection> = {}) =>
  ({ worktreeId, projectId, branch, path: `/repo/${branch}`, status: "ready", ...extra }) as WorktreeProjection;
const thread = (threadId: string, worktreeId: string, updatedAt: string, status = "idle") =>
  ({ threadId, worktreeId, provider: "codex", status, capabilities: {}, updatedAt }) as ThreadProjection;
const agentTerminal = (terminalId: string, worktreeId: string, updatedAt: string, status = "running") =>
  ({
    terminalId,
    worktreeId,
    kind: "agent",
    agent: { provider: "claude" },
    status,
    updatedAt,
  }) as unknown as TerminalProjection;

function projection(
  worktrees: WorktreeProjection[],
  threads: ThreadProjection[],
  terminals: TerminalProjection[] = [],
): RuntimeProjection {
  return { worktrees, threads, terminals } as unknown as RuntimeProjection;
}

describe("sendTargets", () => {
  const worktrees = [
    worktree("w1", "main"),
    worktree("w2", "cursor-foia"),
    worktree("w3", "docs"),
    worktree("w4", "other", "p2"),
    worktree("w5", "going", "p1", { status: "cancelling" }),
  ];
  const state = projection(
    worktrees,
    [
      thread("t1", "w1", "2026-01-01T00:00:00.000Z"),
      thread("t2", "w2", "2026-01-03T00:00:00.000Z"),
      thread("t3", "w3", "2026-01-02T00:00:00.000Z"),
      thread("t4", "w4", "2026-01-05T00:00:00.000Z"),
      thread("t5", "w5", "2026-01-05T00:00:00.000Z"),
      thread("t6", "w-removed", "2026-01-05T00:00:00.000Z"),
      thread("t7", "w2", "2026-01-04T00:00:00.000Z", "stopped"),
    ],
    [agentTerminal("x1", "w3", "2026-01-04T00:00:00.000Z"), agentTerminal("x2", "w1", "2026-01-04T00:00:00.000Z")],
  );

  it("lists only the worktree's own agents unless asked for the others", () => {
    expect(sendTargets(state, "w1").map((target) => target.key)).toEqual(["x2:terminal", "t1:chat"]);
  });

  it("lists the agents here first, then the project's other worktrees in sidebar order", () => {
    const targets = sendTargets(state, "w1", { otherWorktrees: true });
    expect(targets.map((target) => `${target.branch}/${target.key}`)).toEqual([
      "main/x2:terminal",
      "main/t1:chat",
      "cursor-foia/t2:chat",
      "docs/x1:terminal",
      "docs/t3:chat",
    ]);
    expect(sendTargetGroups(targets).map((group) => [group.branch, group.targets.length])).toEqual([
      ["main", 2],
      ["cursor-foia", 1],
      ["docs", 2],
    ]);
  });

  it("tells two agents with the same name apart by their worktree and key", () => {
    const targets = sendTargets(state, "w2", { otherWorktrees: true }).filter((target) => target.mode === "chat");
    expect(targets.map((target) => [target.agent, target.branch, target.key])).toEqual([
      ["Codex", "cursor-foia", "t2:chat"],
      ["Codex", "main", "t1:chat"],
      ["Codex", "docs", "t3:chat"],
    ]);
  });

  it("starts the groups with another worktree when none of the agents work here", () => {
    const quiet = projection(worktrees, [thread("t2", "w2", "2026-01-03T00:00:00.000Z")]);
    expect(sendTargets(quiet, "w1")).toEqual([]);
    expect(sendTargetGroups(sendTargets(quiet, "w1", { otherWorktrees: true })).map((group) => group.branch)).toEqual([
      "cursor-foia",
    ]);
  });
});

describe("defaultSendTarget", () => {
  it("uses the agent picked last while it can still take messages, else the only one", () => {
    expect(defaultSendTarget([], undefined, "w1")).toBeUndefined();
    expect(defaultSendTarget([chat], undefined, "w1")).toBe(chat);
    expect(defaultSendTarget([chat, terminal], undefined, "w1")).toBeUndefined();
    expect(defaultSendTarget([chat, terminal], terminal.key, "w1")).toBe(terminal);
    expect(defaultSendTarget([chat], terminal.key, "w1")).toBe(chat);
    expect(defaultSendTarget([chat, { ...terminal, key: "s3:terminal" }], terminal.key, "w1")).toBeUndefined();
  });

  it("goes to another worktree only when the person picked that agent before", () => {
    expect(defaultSendTarget([elsewhere], undefined, "w1")).toBeUndefined();
    expect(defaultSendTarget([chat, elsewhere], undefined, "w1")).toBe(chat);
    expect(defaultSendTarget([chat, elsewhere], elsewhere.key, "w1")).toBe(elsewhere);
    expect(defaultSendTarget([elsewhere], elsewhere.key, "w1")).toBe(elsewhere);
    // The agent picked last exited, and the only one left works elsewhere.
    expect(defaultSendTarget([elsewhere], terminal.key, "w1")).toBeUndefined();
  });
});

describe("messageForTarget", () => {
  const otherWorktrees = { context: (target: SendTarget) => `From main to ${target.branch}.`, note: () => "" };

  it("adds where the message came from only for an agent in another worktree", () => {
    expect(messageForTarget("Fix it.", chat, "w1", otherWorktrees)).toBe("Fix it.");
    expect(messageForTarget("Fix it.", elsewhere, "w1", otherWorktrees)).toBe("From main to cursor-foia.\n\nFix it.");
    expect(messageForTarget("Fix it.", elsewhere, "w1", undefined)).toBe("Fix it.");
    expect(messageForTarget("Fix it.", undefined, "w1", otherWorktrees)).toBe("Fix it.");
  });
});

describe("rememberSendTarget", () => {
  it("keeps the last agent for each worktree and drops the oldest worktrees", () => {
    rememberSendTarget("w1", chat.key);
    rememberSendTarget("w2", terminal.key);
    rememberSendTarget("w1", terminal.key);
    expect(lastSendTarget("w1")).toBe(terminal.key);
    expect(lastSendTarget("w2")).toBe(terminal.key);
    for (let index = 0; index < 50; index += 1) rememberSendTarget(`other-${index}`, chat.key);
    expect(lastSendTarget("w2")).toBeUndefined();
    expect(lastSendTarget("other-49")).toBe(chat.key);
  });

  it("ignores stored values it cannot read", () => {
    window.localStorage.setItem("zli.sendTarget.v1", "{");
    expect(lastSendTarget("w1")).toBeUndefined();
    window.localStorage.setItem("zli.sendTarget.v1", JSON.stringify({ w1: 3, w2: "s1:chat" }));
    expect(lastSendTarget("w1")).toBeUndefined();
    expect(lastSendTarget("w2")).toBe("s1:chat");
  });
});

describe("sentNotice", () => {
  it("says where the message went and what is left to do in a terminal", () => {
    expect(sentNotice(chat)).toBe("Sent to Codex.");
    expect(sentNotice(terminal)).toBe("Pasted in Claude Code. Press Enter there to send it.");
    expect(sentNotice(terminal, [{ name: "a.png", mimeType: "image/png", dataBase64: "" }])).toBe(
      "Pasted in Claude Code without the images. Press Enter there to send it.",
    );
  });

  it("names the worktree of an agent that works elsewhere", () => {
    expect(sentNotice(chat, [], "w1")).toBe("Sent to Codex.");
    expect(sentNotice(elsewhere, [], "w1")).toBe("Sent to Codex on cursor-foia.");
    const pasted = { ...terminal, worktreeId: "w2", branch: "cursor-foia" };
    expect(sentNotice(pasted, [{ name: "a.png", mimeType: "image/png", dataBase64: "" }], "w1")).toBe(
      "Pasted in Claude Code on cursor-foia without the images. Press Enter there to send it.",
    );
  });
});
