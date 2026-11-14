import type { AgentLogin, ListedProviderKind, ProviderDiscovery, ProviderModelOption } from "@zli-v2/contracts";

import { agentStatus, agentUsable, pickerLine } from "../agent/agentStatus.js";
import { listedDiscoveries, planLabel } from "../agent/providers.js";

/** An agent a chat can switch to, with the models it offers. */
export type AgentChoice = {
  provider: ListedProviderKind;
  name: string;
  models: readonly ProviderModelOption[] | undefined;
  /** "Max", "Plus", "API key": what the account pays with, when the agent's files say. */
  plan: string | undefined;
  /** Why the agent cannot take a message: "Not installed", "Not signed in", "No active plan". */
  unavailable?: string | undefined;
};

/** The account line under an agent's name: its plan, or how it signs in when there is no plan. */
export function accountPlan(login: AgentLogin | undefined): string | undefined {
  if (login?.status !== "signed-in") return undefined;
  if (login.plan) return planLabel(login.plan);
  return login.method === "api-key" ? "API key" : undefined;
}

/**
 * Every other agent ZLI supports. The ones that can run come first; an agent that is not installed, not
 * signed in, or whose last run said it has no plan stays in the list with the reason, so it is never just
 * missing, but it cannot be picked.
 */
export function otherAgents(providers: readonly ProviderDiscovery[] | undefined, current: string): AgentChoice[] {
  const choices = listedDiscoveries(providers)
    .filter((entry) => entry.provider !== current)
    .map((entry): AgentChoice => {
      const status = agentStatus(entry);
      const usable = agentUsable(status);
      return {
        provider: entry.provider,
        name: entry.displayName,
        models: entry.status === "found" ? entry.models : undefined,
        plan: usable ? pickerLine(status) : undefined,
        ...(usable ? {} : { unavailable: pickerLine(status) }),
      };
    });
  const rank = (choice: AgentChoice) =>
    choice.unavailable === undefined ? 0 : choice.unavailable === "Not installed" ? 2 : 1;
  return choices
    .map((choice, index) => ({ choice, index }))
    .sort((a, b) => rank(a.choice) - rank(b.choice) || a.index - b.index)
    .map(({ choice }) => choice);
}
