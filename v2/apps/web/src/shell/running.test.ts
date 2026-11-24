import type { AgentServer, DevServerProjection, TerminalProjection, ThreadActivityProjection } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { LONG_COMMAND_MS, mayHaveAgentServer, runningEntries } from "./running.js";

const now = Date.parse("2026-11-21T10:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

const devServer = {
  worktreeId: "w1",
  terminalId: "t1",
  url: "http://localhost:5173/",
  port: 5173,
  detectedAt: ago(1000),
} as DevServerProjection;
const terminal = { terminalId: "t1", worktreeId: "w1", title: "npm run dev", status: "running" } as TerminalProjection;

function step(id: string, patch: Partial<ThreadActivityProjection>): ThreadActivityProjection {
  return {
    activityId: id,
    threadId: "th1",
    kind: "command",
    title: "Run",
    status: "running",
    ...patch,
  } as ThreadActivityProjection;
}

const base = {
  devServers: [] as DevServerProjection[],
  terminals: [] as TerminalProjection[],
  agentServers: [] as AgentServer[],
  activities: [] as ThreadActivityProjection[],
  threadStatus: "working" as const,
  now,
};

describe("runningEntries", () => {
  it("is empty when nothing runs", () => {
    expect(runningEntries(base)).toEqual([]);
  });

  it("lists a terminal's server with its terminal, so ZLI can stop it", () => {
    expect(runningEntries({ ...base, devServers: [devServer], terminals: [terminal] })).toEqual([
      {
        id: "terminal:t1:5173",
        icon: "globe",
        name: "localhost:5173",
        detail: "npm run dev",
        url: "http://localhost:5173/",
        status: "running",
        terminalId: "t1",
      },
    ]);
  });

  it("adds the agent's own servers once per port, without a way to stop them", () => {
    const agentServers = [
      { threadId: "th1", activityId: "a1", url: "http://localhost:5173/", port: 5173, title: "Dev" },
      {
        threadId: "th1",
        activityId: "a2",
        url: "http://localhost:1420/",
        port: 1420,
        command: "npm run tauri dev",
        title: "Tauri",
      },
    ] as AgentServer[];
    const entries = runningEntries({ ...base, devServers: [devServer], terminals: [terminal], agentServers });
    expect(entries.map((entry) => [entry.name, entry.icon, entry.terminalId])).toEqual([
      ["localhost:5173", "globe", "t1"],
      ["localhost:1420", "monitor", undefined],
    ]);
  });

  it("shows the agent's commands that have run a while, and only while the agent works", () => {
    const activities = [
      step("long", { command: "npm run electron:dev", title: "Start the app", startedAt: ago(LONG_COMMAND_MS + 1) }),
      step("quick", { command: "ls", startedAt: ago(1_000) }),
      step("done", { command: "npm test", status: "completed", startedAt: ago(60_000) }),
      step("read", { kind: "file-read", title: "Read a.ts", startedAt: ago(60_000) }),
    ];
    expect(runningEntries({ ...base, activities })).toEqual([
      { id: "step:long", icon: "monitor", name: "npm run electron:dev", detail: "Start the app", status: "running" },
    ]);
    // A step left marked running when the turn stopped was cut off, not left running.
    expect(runningEntries({ ...base, activities, threadStatus: "idle" })).toEqual([]);
  });
});

describe("mayHaveAgentServer", () => {
  it("is true only when a command step printed a local address", () => {
    expect(mayHaveAgentServer([step("a", { detail: "Local: http://localhost:5173/" })])).toBe(true);
    expect(mayHaveAgentServer([step("a", { detail: "done" })])).toBe(false);
    expect(mayHaveAgentServer([step("a", { kind: "file-read", detail: "localhost:3000" })])).toBe(false);
  });
});
