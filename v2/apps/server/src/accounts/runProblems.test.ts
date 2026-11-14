import type { ProviderDiscovery } from "@zli-v2/contracts";
import { describe, expect, it, vi } from "vitest";

import { classifyRunError, cleanRunMessage, RunProblems } from "./runProblems.js";

const at = new Date("2026-11-12T10:00:00.000Z");

type Login = Extract<ProviderDiscovery, { status: "found" }>["login"];

function found(provider: "claude-code" | "codex", login?: Login) {
  return {
    provider,
    displayName: provider === "codex" ? "Codex" : "Claude Code",
    status: "found",
    path: `/bin/${provider}`,
    ...(login ? { login } : {}),
  } satisfies ProviderDiscovery;
}

describe("classifyRunError", () => {
  it.each([
    ["Credit balance is too low", "no-plan"],
    ["Your organization does not have access to Claude. Please login again or contact your administrator.", "no-plan"],
    ["This organization has been disabled.", "no-plan"],
    ["You exceeded your current quota, please check your plan and billing details.", "no-plan"],
    ['stream error: {"code":"insufficient_quota"}', "no-plan"],
    ["Codex requires an active subscription", "no-plan"],
    ["Invalid API key · Please run /login", "signed-out"],
    ["OAuth token has expired. Please obtain a new token or refresh your existing token.", "signed-out"],
    ["unexpected status 401 Unauthorized: Missing bearer or basic authentication in header", "signed-out"],
    [
      "Your access token could not be refreshed because your refresh token was already used. Please log in again.",
      "signed-out",
    ],
    ["Not logged in. Run cursor-agent login.", "signed-out"],
    ['{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', "signed-out"],
  ] as const)("reads %j as %s", (message, kind) => {
    expect(classifyRunError(message)).toBe(kind);
  });

  it.each([
    "You've hit your usage limit. Try again at 3:00 PM.",
    "Claude AI usage limit reached|1762963200",
    "stream disconnected before completion: error sending request",
    "model 'gpt-9' not found",
    "Provider turn failed.",
    "",
  ])("leaves %j alone: it says nothing about the account", (message) => {
    expect(classifyRunError(message)).toBeUndefined();
  });
});

describe("cleanRunMessage", () => {
  it("keeps one short line and hides anything shaped like a key or token", () => {
    const cleaned = cleanRunMessage(
      `\u001b[31mInvalid API key\u001b[0m sk-ant-api03-abcdefghijklmnop\n  Bearer ${"a".repeat(60)}`,
    );
    expect(cleaned).toBe("Invalid API key [key] [token]");
    expect(cleanRunMessage("x ".repeat(400)).length).toBeLessThanOrEqual(300);
  });
});

describe("RunProblems", () => {
  it("records only account failures and adds them to the agent's discovery", () => {
    const problems = new RunProblems(() => at);
    expect(problems.record("codex", "network is down")).toBe(false);
    expect(problems.record("claude-code", "Credit balance is too low")).toBe(true);
    const [claude, codex] = problems.apply([found("claude-code"), found("codex")]);
    expect(claude).toMatchObject({
      problem: { kind: "no-plan", message: "Credit balance is too low", at: at.toISOString() },
    });
    expect(codex).not.toHaveProperty("problem");
  });

  it("returns the same list when nothing is recorded", () => {
    const list = [found("codex")];
    expect(new RunProblems().apply(list)).toBe(list);
  });

  it("clears after a successful run and tells listeners", () => {
    const problems = new RunProblems(() => at);
    const listener = vi.fn();
    problems.subscribe(listener);
    problems.record("codex", "Please log in again.");
    problems.clear("codex");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(problems.apply([found("codex")])[0]).not.toHaveProperty("problem");
  });

  it("drops the problem once the agent signs in as someone else or with another plan", () => {
    const problems = new RunProblems(() => at);
    const before = { status: "signed-in", method: "subscription", email: "kim@example.com", plan: "free" } as const;
    problems.record("codex", "Codex requires an active subscription", before);
    expect(problems.apply([found("codex", before)])[0]).toHaveProperty("problem");
    const after = { ...before, plan: "plus" };
    expect(problems.apply([found("codex", after)])[0]).not.toHaveProperty("problem");
    expect(problems.get("codex")).toBeUndefined();
  });

  it("takes the login it first sees when none was known at the failure", () => {
    const problems = new RunProblems(() => at);
    problems.record("claude-code", "Credit balance is too low");
    const login = { status: "signed-in", method: "api-key" } as const;
    expect(problems.apply([found("claude-code", login)])[0]).toHaveProperty("problem");
    expect(problems.apply([found("claude-code", login)])[0]).toHaveProperty("problem");
    expect(problems.apply([found("claude-code", { status: "signed-out" })])[0]).not.toHaveProperty("problem");
  });

  it("forgets an agent that is no longer installed", () => {
    const problems = new RunProblems(() => at);
    problems.record("codex", "Please log in again.");
    problems.apply([{ provider: "codex", displayName: "Codex", status: "missing", reason: "not found" }]);
    expect(problems.get("codex")).toBeUndefined();
  });
});
