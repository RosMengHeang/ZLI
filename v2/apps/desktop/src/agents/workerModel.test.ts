import { describe, expect, it } from "vitest";

import { workerModel } from "./AgentControlActions.js";

const state = {
  providers: [
    {
      provider: "claude-code",
      displayName: "Claude Code",
      status: "found",
      path: "claude",
      models: [
        { id: "claude-opus-5-5", label: "Opus" },
        { id: "claude-sonnet-5-5", label: "Sonnet" },
      ],
    },
    { provider: "codex", displayName: "Codex", status: "found", path: "codex" },
  ],
} as Parameters<typeof workerModel>[0];

describe("workerModel", () => {
  it("runs the lead's model when the lead names none for a worker of the same agent", () => {
    const lead = { provider: "claude-code", model: "claude-opus-5-5" };
    expect(workerModel(state, { provider: "claude-code" }, lead)).toBe("claude-opus-5-5");
  });

  it("leaves another agent on its own default", () => {
    expect(workerModel(state, { provider: "codex" }, { provider: "claude-code", model: "claude-opus-5-5" })).toBe(
      undefined,
    );
    expect(workerModel(state, { provider: "claude-code" }, undefined)).toBe(undefined);
  });

  it("takes the model the lead picks, by id or by name", () => {
    const lead = { provider: "claude-code", model: "claude-opus-5-5" };
    expect(workerModel(state, { provider: "claude-code", model: "Sonnet" }, lead)).toBe("claude-sonnet-5-5");
    expect(workerModel(state, { provider: "claude-code", model: "claude-sonnet-5-5" }, lead)).toBe("claude-sonnet-5-5");
  });

  it("refuses a model the agent does not offer and lists the ones it does", () => {
    expect(() => workerModel(state, { provider: "claude-code", model: "gpt-9" }, undefined)).toThrow(
      "gpt-9 is not a model Claude Code offers here. Pick one of: claude-opus-5-5 (Opus), claude-sonnet-5-5 (Sonnet).",
    );
  });

  it("passes a model through when the agent did not list its models", () => {
    expect(workerModel(state, { provider: "codex", model: "gpt-5.5-codex" }, undefined)).toBe("gpt-5.5-codex");
  });
});
