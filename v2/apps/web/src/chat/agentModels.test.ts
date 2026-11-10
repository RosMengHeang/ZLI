import type { ProviderDiscovery } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { accountPlan, otherAgents } from "./agentModels.js";

const found = (provider: ProviderDiscovery["provider"], extra: object = {}): ProviderDiscovery =>
  ({ provider, displayName: provider, status: "found", path: `/bin/${provider}`, ...extra }) as ProviderDiscovery;

describe("otherAgents", () => {
  it("offers only the other agents signed in to an account, with their plan", () => {
    const others = otherAgents(
      [
        found("codex", { login: { status: "signed-in", plan: "plus" } }),
        found("claude-code", { login: { status: "signed-in", method: "subscription", plan: "max" } }),
        found("cursor-agent", { login: { status: "signed-out" } }),
        found("droid"),
        found("gemini", { login: { status: "signed-in", method: "api-key" } }),
        { provider: "qwen", displayName: "Qwen", status: "missing", reason: "not found" },
      ],
      "codex",
    );
    expect(others.map((agent) => [agent.provider, agent.plan])).toEqual([
      ["claude-code", "Max"],
      ["gemini", "API key"],
    ]);
  });

  it("names the plan, or the API key when there is no plan", () => {
    expect(accountPlan({ status: "signed-in", plan: "pro_plus" })).toBe("Pro Plus");
    expect(accountPlan({ status: "signed-in", method: "subscription" })).toBeUndefined();
    expect(accountPlan({ status: "signed-out" })).toBeUndefined();
  });
});
