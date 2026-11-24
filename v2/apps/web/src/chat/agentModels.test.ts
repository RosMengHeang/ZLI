import type { Account, PlanLimitReading, ProviderDiscovery } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { accountChoices, accountPlan, accountTag, otherAgents, ownLogin } from "./agentModels.js";

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

describe("accountChoices", () => {
  const accounts = [
    { id: "acc-work", provider: "claude-code", label: "Work", kind: "sign-in" },
    { id: "acc-team", provider: "claude-code", label: "Side project", kind: "sign-in" },
    { id: "acc-key", provider: "codex", label: "Billing", kind: "api-key" },
  ] as const satisfies readonly Account[];
  const providers = [found("claude-code"), found("codex"), found("cursor-agent")];
  const reading = (provider: string, accountId: string, state: PlanLimitReading["state"], plan?: string) =>
    ({ provider, accountId, state, windows: [], ...(plan ? { plan } : {}) }) as PlanLimitReading;
  const choices = () => otherAgents(providers, "");

  it("lists each login of an agent with saved accounts, tagged, apart from the chat's own", () => {
    const list = accountChoices(choices(), {
      accounts,
      readings: [reading("claude-code", "acc-work", "ok", "max")],
      providers,
      current: { provider: "claude-code", accountId: "usual" },
    });
    expect(list.map((choice) => [choice.provider, choice.account, choice.tag, choice.plan])).toEqual([
      ["claude-code", "Work", "WO", "Max"],
      ["claude-code", "Side project", "SP", undefined],
      ["codex", "Your sign-in", "ME", undefined],
      ["codex", "Billing", "BI", "API key"],
      ["cursor-agent", undefined, undefined, undefined],
    ]);
  });

  it("still offers saved accounts when only the usual login is signed out", () => {
    const signedOut = [found("claude-code", { login: { status: "signed-out" } }), found("cursor-agent")];
    const list = accountChoices(otherAgents(signedOut, ""), {
      accounts,
      readings: [reading("claude-code", "acc-team", "expired")],
      providers: signedOut,
      current: { provider: "codex", accountId: undefined },
    });
    expect(list.map((choice) => [choice.provider, choice.account, choice.unavailable])).toEqual([
      ["cursor-agent", undefined, undefined],
      ["claude-code", "Work", undefined],
    ]);
    // With no saved account that can run, the agent stays listed with the usual login's reason.
    const none = accountChoices(otherAgents(signedOut, ""), {
      accounts: [],
      readings: [],
      providers: signedOut,
      current: { provider: "codex", accountId: undefined },
    });
    expect(none.map((choice) => [choice.provider, choice.unavailable])).toEqual([
      ["cursor-agent", undefined],
      ["claude-code", "Not signed in"],
    ]);
  });

  it("leaves out a login the readings say is signed out, and an agent with no other login", () => {
    const list = accountChoices(otherAgents([...providers, found("opencode")], ""), {
      accounts: [],
      readings: [
        reading("cursor-agent", "usual", "expired"),
        reading("codex", "usual", "unavailable"),
        reading("opencode", "usual", "signed-out"),
      ],
      providers: [...providers, found("opencode")],
      current: { provider: "claude-code", accountId: undefined },
    });
    // OpenCode's reading only covers its Go plan, so it stays.
    expect(list.map((choice) => choice.provider)).toEqual(["codex", "opencode"]);
  });

  it("names the chat's own login and its tag", () => {
    expect(ownLogin(accounts, [], "claude-code", "acc-team")).toMatchObject({ label: "Side project", tag: "SP" });
    expect(ownLogin(accounts, [], "claude-code", undefined)).toMatchObject({ id: "usual", label: "Your sign-in" });
    expect(ownLogin(accounts, [], "claude-code", undefined, "kim@example.com")).toMatchObject({
      label: "kim@example.com",
      tag: "KI",
    });
    expect(ownLogin(accounts, [], "cursor-agent", undefined)).toBeUndefined();
    expect(accountTag("work")).toBe("WO");
    expect(accountTag("kim@example.com")).toBe("KI");
  });
});
