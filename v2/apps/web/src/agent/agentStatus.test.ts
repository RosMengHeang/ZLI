import type { ProviderDiscovery } from "@zli-v2/contracts";
import { describe, expect, it } from "vitest";

import { agentStatus, agentUsable, chatAgentStatus, statusLine, unusableReason } from "./agentStatus.js";

const at = "2026-11-12T10:00:00.000Z";
const found = (extra: object = {}): ProviderDiscovery =>
  ({ provider: "codex", displayName: "Codex", status: "found", path: "/bin/codex", ...extra }) as ProviderDiscovery;

describe("agentStatus", () => {
  it.each([
    ["still checking", undefined, "checking", "Checking sign-in", true],
    [
      "not installed",
      { provider: "codex", displayName: "Codex", status: "missing", reason: "not found" } as ProviderDiscovery,
      "missing",
      "Not installed",
      false,
    ],
    ["installed, signed out", found({ login: { status: "signed-out" } }), "signed-out", "Not signed in", false],
    [
      "subscription with email and plan",
      found({ login: { status: "signed-in", method: "subscription", email: "kim@example.com", plan: "pro_plus" } }),
      "subscription",
      "Signed in as kim@example.com · Pro Plus",
      true,
    ],
    [
      "API key",
      found({ login: { status: "signed-in", method: "api-key" } }),
      "api-key",
      "Signed in with an API key",
      true,
    ],
    [
      "signed in, plan unknown",
      found({ login: { status: "signed-in", method: "subscription", email: "kim@example.com" } }),
      "subscription",
      "Signed in as kim@example.com · Plan unknown",
      true,
    ],
    [
      "signed in, nothing else known",
      found({ login: { status: "signed-in" } }),
      "subscription",
      "Signed in · Plan unknown",
      true,
    ],
    [
      "a run said there is no plan",
      found({
        login: { status: "signed-in", method: "subscription", email: "kim@example.com", plan: "free" },
        problem: { kind: "no-plan", message: "Upgrade required", at },
      }),
      "no-plan",
      "Signed in as kim@example.com · No active plan",
      false,
    ],
    [
      "a run said the sign-in expired",
      found({
        login: { status: "signed-in", method: "subscription" },
        problem: { kind: "signed-out", message: "Please log in again.", at },
      }),
      "signed-out",
      "Sign-in expired",
      false,
    ],
    ["login kept where ZLI cannot read it", found(), "unknown", "Sign-in unknown", true],
  ])("%s", (_name, entry, kind, line, usable) => {
    const status = agentStatus(entry);
    expect(status.kind).toBe(kind);
    expect(statusLine(status)).toBe(line);
    expect(agentUsable(status)).toBe(usable);
    expect(unusableReason(status) === undefined).toBe(usable);
  });
});

describe("chatAgentStatus", () => {
  it("lets a chat on a saved account run when only the usual login is signed out or out of plan", () => {
    const signedOut = found({ login: { status: "signed-out" } });
    const noPlan = found({
      login: { status: "signed-in", method: "subscription" },
      problem: { kind: "no-plan", message: "Upgrade to use Codex.", at },
    });
    expect(agentUsable(chatAgentStatus(signedOut, undefined))).toBe(false);
    expect(agentUsable(chatAgentStatus(signedOut, "account-1"))).toBe(true);
    expect(agentUsable(chatAgentStatus(noPlan, "account-1"))).toBe(true);
    // A missing install stops every chat, whatever the account.
    expect(agentUsable(chatAgentStatus({ ...found(), status: "missing" } as ProviderDiscovery, "account-1"))).toBe(
      false,
    );
  });
});
