import type {
  Account,
  AgentLogin,
  ListedProviderKind,
  PlanLimitReading,
  ProviderDiscovery,
  ProviderModelOption,
} from "@zli-v2/contracts";
import { USUAL_LOGIN_ACCOUNT_ID } from "@zli-v2/contracts";

import { accountsFor, defaultAccountId } from "../accounts/accounts.js";

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
  /** The login this choice runs under, once the agent has saved accounts. */
  accountId?: string | undefined;
  /** That login's name, such as "Work". */
  account?: string | undefined;
  /** One or two letters on the agent's mark that tell its accounts apart. */
  tag?: string | undefined;
};

/** Tells two choices apart: the same agent on two accounts is two choices. */
export function choiceKey(choice: Pick<AgentChoice, "provider" | "accountId">): string {
  return `${choice.provider}:${choice.accountId ?? ""}`;
}

/** What the person's own login is called: its email when the agent records one. */
export const OWN_LOGIN_LABEL = "Your sign-in";

export function ownLoginLabel(email: string | undefined): string {
  return email ?? OWN_LOGIN_LABEL;
}

/** Two letters for a login: "Work" is WO, "Side project" is SP, kim@example.com is KI, your own is ME. */
export function accountTag(label: string): string {
  if (label === OWN_LOGIN_LABEL) return "ME";
  const name = label.includes("@") ? (label.split("@")[0] ?? label) : label;
  const words = name.split(/[\s\p{P}_]+/u).filter(Boolean);
  const letters =
    words.length > 1 ? words.slice(0, 2).map((word) => [...word][0] ?? "") : [...(words[0] ?? "")].slice(0, 2);
  return letters.join("").toUpperCase();
}

/** The line a login's plan reading gives: "Max", or "API key" for a key account. */
function accountLine(account: Account | undefined, reading: PlanLimitReading | undefined): string | undefined {
  if (account?.kind === "api-key") return "API key";
  return reading?.plan ? planLabel(reading.plan) : undefined;
}

/**
 * The chat's own login, for the picker: its name, tag, and plan. Undefined while the agent has only the
 * usual login, which needs no name.
 */
export function ownLogin(
  accounts: readonly Account[],
  readings: readonly PlanLimitReading[],
  provider: string,
  accountId: string | undefined,
  /** The email the agent's own login records, which names that login. */
  email?: string | undefined,
): { id: string; label: string; tag: string; plan: string | undefined } | undefined {
  const own = accountsFor(accounts, provider);
  if (own.length === 0) return undefined;
  const id = accountId ?? defaultAccountId(accounts, provider);
  const account = own.find((entry) => entry.id === id);
  const label = account?.label ?? ownLoginLabel(email);
  const reading = readings.find((entry) => entry.provider === provider && entry.accountId === id);
  return { id, label, tag: accountTag(label), plan: account ? accountLine(account, reading) : undefined };
}

/**
 * A login the plan readings say cannot run now: signed out, or a sign-in that went stale. OpenCode's
 * reading only covers its Go plan, and OpenCode runs on other providers without it, so its reading
 * never hides it.
 */
function loginOut(reading: PlanLimitReading | undefined): boolean {
  if (!reading || reading.provider === "opencode") return false;
  return reading.state === "signed-out" || reading.state === "expired";
}

/**
 * The picker's choices once saved accounts count: an agent with saved accounts becomes one choice per
 * login, each with a tag, so "Claude Code, Work" can be picked straight away. A login the readings say is
 * signed out is left out, and so is an agent whose only login is, since picking it would only fail. An API
 * key login keeps its place: it runs without a plan.
 */
export function accountChoices(
  choices: readonly AgentChoice[],
  options: {
    accounts: readonly Account[];
    readings: readonly PlanLimitReading[];
    providers: readonly ProviderDiscovery[] | undefined;
    /**
     * The chat's own agent and login, which the picker lists by itself. Pass every agent in `choices`,
     * this one too: its other logins are choices of their own.
     */
    current: { provider: string; accountId: string | undefined };
  },
): AgentChoice[] {
  const { accounts, readings, providers, current } = options;
  const readingOf = (provider: string, accountId: string) =>
    readings.find((reading) => reading.provider === provider && reading.accountId === accountId);
  return choices.flatMap((choice): AgentChoice[] => {
    if (choice.unavailable) return [choice];
    const own = accountsFor(accounts, choice.provider);
    const login = providers?.find((entry) => entry.provider === choice.provider);
    const usualKnownIn = login?.status === "found" && login.login?.status === "signed-in";
    const usualOut = !usualKnownIn && loginOut(readingOf(choice.provider, USUAL_LOGIN_ACCOUNT_ID));
    const isCurrent = choice.provider === current.provider;
    if (own.length === 0) return usualOut || isCurrent ? [] : [choice];
    const currentId = isCurrent ? (current.accountId ?? defaultAccountId(accounts, choice.provider)) : undefined;
    const logins = [
      ...(usualOut
        ? []
        : [
            {
              id: USUAL_LOGIN_ACCOUNT_ID,
              label: ownLoginLabel(login?.status === "found" ? login.login?.email : undefined),
              account: undefined,
            },
          ]),
      ...own
        .filter((account) => !loginOut(readingOf(choice.provider, account.id)))
        .map((account) => ({ id: account.id, label: account.label, account })),
    ];
    return logins
      .filter((entry) => entry.id !== currentId)
      .map((entry) => ({
        ...choice,
        accountId: entry.id,
        account: entry.label,
        tag: accountTag(entry.label),
        plan:
          entry.id === USUAL_LOGIN_ACCOUNT_ID
            ? choice.plan
            : (accountLine(entry.account, readingOf(choice.provider, entry.id)) ?? choice.plan),
      }));
  });
}

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
