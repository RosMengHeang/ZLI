import { describe, expect, it } from "vitest";

import { AgentLaunchError, agentCliMissingMessage, buildAgentArgs } from "./agentLaunch.js";

describe("buildAgentArgs", () => {
  it("defaults every provider to full access", () => {
    expect(buildAgentArgs({ provider: "codex" })).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(buildAgentArgs({ provider: "claude-code" })).toEqual(["--dangerously-skip-permissions"]);
    expect(buildAgentArgs({ provider: "cursor-agent" })).toEqual(["--force", "--trust"]);
    expect(buildAgentArgs({ provider: "droid" })).toEqual(["--auto", "high"]);
  });

  it("drops permission bypass flags in supervised mode", () => {
    expect(buildAgentArgs({ provider: "codex", permissionMode: "supervised" })).toEqual([]);
    expect(buildAgentArgs({ provider: "claude-code", permissionMode: "supervised" })).toEqual([]);
    expect(buildAgentArgs({ provider: "cursor-agent", permissionMode: "supervised" })).toEqual(["--trust"]);
    expect(buildAgentArgs({ provider: "droid", permissionMode: "supervised" })).toEqual([]);
  });

  it("passes the model with each CLI's own flag", () => {
    expect(buildAgentArgs({ provider: "codex", model: "gpt-5.1-codex" })).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "gpt-5.1-codex",
    ]);
    expect(
      buildAgentArgs({ provider: "claude-code", model: "claude-sonnet-4-5", permissionMode: "supervised" }),
    ).toEqual(["--model", "claude-sonnet-4-5"]);
    expect(buildAgentArgs({ provider: "cursor-agent", model: "claude-opus-4-8[context=1m,effort=high]" })).toEqual([
      "--force",
      "--trust",
      "--model",
      "claude-opus-4-8[context=1m,effort=high]",
    ]);
    expect(buildAgentArgs({ provider: "droid", model: "gpt-5" })).toEqual(["--auto", "high"]);
  });

  it.each([
    "gpt 5",
    'gpt"5',
    "gpt&calc",
    "gpt|calc",
    "gpt%PATH%",
    "gpt^5",
    "gpt!x!",
    "gpt>out",
    "--dangerously-skip-permissions",
    "gpt\n5",
  ])("rejects the unsafe model id %j", (model) => {
    expect(() => buildAgentArgs({ provider: "claude-code", model })).toThrow(AgentLaunchError);
  });

  it("names the missing CLI", () => {
    expect(agentCliMissingMessage("cursor-agent")).toBe("Cursor CLI was not found. Install it or check PATH.");
    expect(agentCliMissingMessage("claude-code")).toBe("Claude Code CLI was not found. Install it or check PATH.");
  });
});
