import { describe, expect, it } from "vitest";

import { AgentName, agentNameKey, agentNameTaken } from "./agentName.js";

describe("agent names", () => {
  it("accepts short readable names and rejects ones that would break a project/agent reference", () => {
    expect(AgentName.parse("  Bob ")).toBe("Bob");
    expect(AgentName.parse("Code reviewer 2")).toBe("Code reviewer 2");
    expect(AgentName.parse("Søren")).toBe("Søren");
    expect(AgentName.safeParse("api/bob").success).toBe(false);
    expect(AgentName.safeParse("-bob").success).toBe(false);
    expect(AgentName.safeParse("").success).toBe(false);
    expect(AgentName.safeParse("x".repeat(41)).success).toBe(false);
  });

  it("compares names without case or extra spaces", () => {
    expect(agentNameKey(" Code  Reviewer ")).toBe(agentNameKey("code reviewer"));
  });

  it("counts only listed agents in the same project", () => {
    const state = {
      worktrees: [
        { worktreeId: "w1", projectId: "p1" },
        { worktreeId: "w2", projectId: "p2" },
      ],
      threads: [
        { threadId: "t1", worktreeId: "w1", status: "idle", name: "Bob" },
        { threadId: "t2", worktreeId: "w1", status: "stopped", name: "Ann" },
      ],
      terminals: [
        { terminalId: "x1", worktreeId: "w1", status: "running", agent: {}, name: "Joe" },
        { terminalId: "x2", worktreeId: "w1", status: "exited", agent: {}, name: "Max" },
      ],
    };
    expect(agentNameTaken(state, { projectId: "p1", name: "bob" })).toBe(true);
    expect(agentNameTaken(state, { projectId: "p1", name: "Bob", exceptId: "t1" })).toBe(false);
    expect(agentNameTaken(state, { projectId: "p2", name: "Bob" })).toBe(false);
    expect(agentNameTaken(state, { projectId: "p1", name: "Joe" })).toBe(true);
    expect(agentNameTaken(state, { projectId: "p1", name: "Ann" })).toBe(false);
    expect(agentNameTaken(state, { projectId: "p1", name: "Max" })).toBe(false);
  });
});
