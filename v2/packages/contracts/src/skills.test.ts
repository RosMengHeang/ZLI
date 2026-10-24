import { describe, expect, it } from "vitest";

import { RpcRequest } from "./rpc.js";
import { AGENT_SKILL_DIRS, agentsReading, SkillCommand, SkillDraft, skillNameProblem } from "./skills.js";

const request = (command: unknown) =>
  RpcRequest.safeParse({ protocolVersion: 1, commandId: "00000000-0000-4000-8000-000000000001", command });

describe("skills contracts", () => {
  it("follows the Agent Skills naming rule", () => {
    expect(skillNameProblem("code-review")).toBeUndefined();
    expect(skillNameProblem("pdf2")).toBeUndefined();
    expect(skillNameProblem("")).toBe("Add a name.");
    expect(skillNameProblem("Code")).toBe("Names use lowercase letters, digits, and hyphens.");
    expect(skillNameProblem("a_b")).toBe("Names use lowercase letters, digits, and hyphens.");
    expect(skillNameProblem("-a")).toBe("Names do not start or end with a hyphen.");
    expect(skillNameProblem("a--b")).toBe("Names do not have two hyphens in a row.");
    expect(skillNameProblem("a".repeat(65))).toBe("Names are at most 64 characters.");
  });

  it("limits descriptions and accepts skills commands in runtime requests", () => {
    expect(SkillDraft.safeParse({ name: "a", description: " ", instructions: "" }).success).toBe(false);
    expect(SkillDraft.safeParse({ name: "a", description: "x".repeat(1025), instructions: "" }).success).toBe(false);
    expect(SkillDraft.parse({ name: "a", description: " Does a. ", instructions: "" }).description).toBe("Does a.");
    expect(request({ type: "skills.list" }).success).toBe(true);
    expect(
      request({
        type: "skills.save",
        scope: { kind: "user" },
        skill: { name: "review", description: "Reviews.", instructions: "Read it." },
      }).success,
    ).toBe(true);
    expect(request({ type: "skills.delete", scope: { kind: "user" }, name: "../etc" }).success).toBe(false);
    expect(
      SkillCommand.safeParse({ type: "skills.install", source: "o/r", scope: { kind: "user" }, names: [] }).success,
    ).toBe(false);
  });

  it("maps the shared folder to every agent but Claude Code", () => {
    expect(agentsReading("user", ".agents/skills")).not.toContain("claude-code");
    expect(agentsReading("project", ".agents/skills")).toHaveLength(Object.keys(AGENT_SKILL_DIRS).length - 1);
    expect(agentsReading("user", ".claude/skills")).toEqual(["claude-code", "cursor-agent", "opencode", "goose"]);
  });
});
