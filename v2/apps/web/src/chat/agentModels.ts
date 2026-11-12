import type { AgentLogin, ListedProviderKind, ProviderDiscovery, ProviderModelOption } from "@zli-v2/contracts";

import { listedDiscoveries, planLabel } from "../agent/providers.js";

/** An installed, signed-in agent a chat can switch to, with the models it offers. */
export type AgentChoice = {
  provider: ListedProviderKind;
  name: string;
  models: readonly ProviderModelOption[] | undefined;
  /** "Max", "Plus", "API key": what the account pays with, when the agent's files say. */
  plan: string | undefined;
};

/** The account line under an agent's name: its plan, or how it signs in when there is no plan. */
export function accountPlan(login: AgentLogin | undefined): string | undefined {
  if (login?.status !== "signed-in") return undefined;
  if (login.plan) return planLabel(login.plan);
  return login.method === "api-key" ? "API key" : undefined;
}

/**
 * Every other agent the chat can move to: installed and signed in to an account. An agent that is signed
 * out, or whose login ZLI cannot read, is left out, since a message to it could fail.
 */
export function otherAgents(providers: readonly ProviderDiscovery[] | undefined, current: string): AgentChoice[] {
  return listedDiscoveries(providers).flatMap((entry) =>
    entry.status === "found" && entry.provider !== current && entry.login?.status === "signed-in"
      ? [{ provider: entry.provider, name: entry.displayName, models: entry.models, plan: accountPlan(entry.login) }]
      : [],
  );
}
