import type { ProviderDiscovery } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { accountPlan, otherAgents } from "./agentModels.js";

const found = (provider: ProviderDiscovery["provider"], extra: object = {}): ProviderDiscovery =>
  ({ provider, displayName: provider, status: "found", path: `/bin/${provider}`, ...extra }) as ProviderDiscovery;

describe("otherAgents", () => {
  it("lists the agents that can run first, then the ones that cannot, each with its reason", () => {
    const others = otherAgents(
      [
        found("codex", { login: { status: "signed-in", plan: "plus" } }),
        { provider: "claude-code", displayName: "Claude Code", status: "missing", reason: "not found" },
        found("cursor-agent", { login: { status: "signed-out" } }),
        found("droid"),
        found("gemini", { login: { status: "signed-in", method: "api-key" } }),
        found("kimi", {
          login: { status: "signed-in", method: "subscription" },
          problem: { kind: "no-plan", message: "Subscription required", at: "2026-11-12T10:00:00.000Z" },
        }),
        found("opencode", { login: { status: "signed-in", method: "subscription", plan: "max" } }),
      ],
      "codex",
    );
    expect(others.map((agent) => [agent.provider, agent.plan, agent.unavailable])).toEqual([
      ["droid", undefined, undefined],
      ["gemini", "API key", undefined],
      ["opencode", "Max", undefined],
      ["cursor-agent", undefined, "Not signed in"],
      ["kimi", undefined, "No active plan"],
      ["claude-code", undefined, "Not installed"],
    ]);
  });

  it("names the plan, or the API key when there is no plan", () => {
    expect(accountPlan({ status: "signed-in", plan: "pro_plus" })).toBe("Pro Plus");
    expect(accountPlan({ status: "signed-in", method: "subscription" })).toBeUndefined();
    expect(accountPlan({ status: "signed-out" })).toBeUndefined();
  });
});
