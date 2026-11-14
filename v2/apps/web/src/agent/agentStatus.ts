import type { AgentRunProblem, ListedProviderKind, ProviderDiscovery } from "@zli-v2/contracts";

import { planLabel } from "./providers.js";

/**
 * Where an agent stands with its usual login, from what discovery read on this computer and what its
 * last run said. Nothing here is guessed: a value ZLI could not read stays undefined.
 */
export type AgentStatus =
  /** Discovery has not answered yet. */
  | { kind: "checking" }
  | { kind: "missing" }
  /** Its files say no one is signed in, or a run said the login is gone or expired. */
  | { kind: "signed-out"; problem?: AgentRunProblem }
  /** A run said the account has no plan, credits, or subscription that covers it. */
  | { kind: "no-plan"; problem: AgentRunProblem; email?: string; plan?: string }
  | { kind: "subscription"; email?: string; plan?: string }
  | { kind: "api-key" }
  /** Installed, but it keeps its login where ZLI cannot read it, such as the system keychain. */
  | { kind: "unknown" };

export function agentStatus(entry: ProviderDiscovery | undefined): AgentStatus {
  if (!entry) return { kind: "checking" };
  if (entry.status === "missing") return { kind: "missing" };
  const { login, problem } = entry;
  if (problem?.kind === "signed-out") return { kind: "signed-out", problem };
  if (login?.status === "signed-out") return { kind: "signed-out" };
  const who = {
    ...(login?.email ? { email: login.email } : {}),
    ...(login?.plan ? { plan: planLabel(login.plan) } : {}),
  };
  if (problem?.kind === "no-plan") return { kind: "no-plan", problem, ...who };
  if (!login) return { kind: "unknown" };
  if (login.method === "api-key") return { kind: "api-key" };
  return { kind: "subscription", ...who };
}

/**
 * The status that matters for a chat. A chat on a saved account runs with that account's own sign-in or key,
 * so the usual login being signed out or out of plan does not stop it; only a missing install does.
 */
export function chatAgentStatus(entry: ProviderDiscovery | undefined, accountId: string | undefined): AgentStatus {
  const status = agentStatus(entry);
  if (accountId && (status.kind === "signed-out" || status.kind === "no-plan")) return { kind: "unknown" };
  return status;
}

/** Whether a message to this agent can go out. An agent whose login ZLI cannot read is given the chance. */
export function agentUsable(status: AgentStatus): boolean {
  return status.kind !== "missing" && status.kind !== "signed-out" && status.kind !== "no-plan";
}

/** A few words on why the agent cannot run, for a picker row or a disabled control. */
export function unusableReason(status: AgentStatus): string | undefined {
  switch (status.kind) {
    case "missing":
      return "Not installed";
    case "signed-out":
      return status.problem ? "Sign-in expired" : "Not signed in";
    case "no-plan":
      return "No active plan";
    default:
      return undefined;
  }
}

/** The account line: "Signed in as kim@example.com · Pro", "API key", "Not signed in". */
export function statusLine(status: AgentStatus): string {
  switch (status.kind) {
    case "checking":
      return "Checking sign-in";
    case "missing":
      return "Not installed";
    case "signed-out":
      return status.problem ? "Sign-in expired" : "Not signed in";
    case "no-plan":
      return `${status.email ? `Signed in as ${status.email}` : "Signed in"} · No active plan`;
    case "subscription":
      return `${status.email ? `Signed in as ${status.email}` : "Signed in"} · ${status.plan ?? "Plan unknown"}`;
    case "api-key":
      return "Signed in with an API key";
    case "unknown":
      return "Sign-in unknown";
  }
}

/** The shorter form under an agent's name in the model picker. */
export function pickerLine(status: AgentStatus): string | undefined {
  switch (status.kind) {
    case "subscription":
      return status.plan;
    case "api-key":
      return "API key";
    default:
      return unusableReason(status);
  }
}

/** The status of one agent in the projection's discovery list. No list yet reads as still checking. */
export function statusOf(
  providers: readonly ProviderDiscovery[] | undefined,
  provider: ListedProviderKind | string,
): AgentStatus {
  return agentStatus(providers?.find((entry) => entry.provider === provider));
}
