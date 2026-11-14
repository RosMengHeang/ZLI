import type { AgentLogin, AgentRunProblem, ListedProviderKind, ProviderDiscovery } from "@zli-v2/contracts";

type Kind = AgentRunProblem["kind"];

/**
 * Words agent CLIs use when the account itself cannot run them. Only these mark an agent as unusable: a
 * usage limit that resets, a network error, or a bad model are ordinary failures and leave it alone.
 */
const NO_PLAN = [
  /credit balance is too low/iu,
  /insufficient[_ ]quota/iu,
  /exceeded your current quota/iu,
  /check your plan and billing/iu,
  /\bno active (?:subscription|plan)\b/iu,
  /\bsubscription (?:is )?(?:required|expired|inactive)\b/iu,
  /\brequires? an? (?:active |paid )?(?:subscription|plan)\b/iu,
  /\bdoes not have access to claude\b/iu,
  /\borganization has been disabled\b/iu,
  /\bpayment required\b/iu,
  /\bout of credits\b/iu,
];

const SIGNED_OUT = [
  /\bnot (?:logged|signed) in\b/iu,
  /\bplease (?:log|sign) ?in\b/iu,
  /\brun \S*\s*\/login\b/iu,
  /\binvalid (?:x-)?api[ _-]?key\b/iu,
  /\bauthentication[_ ](?:failed|error)\b/iu,
  /\b401\b.*\bunauthori[sz]ed\b|\bunauthori[sz]ed\b.*\b401\b/iu,
  /\b(?:oauth )?token (?:has )?(?:expired|been revoked|revoked)\b/iu,
  /\btoken_expired\b/iu,
  /\brefresh[_ ]token\b.*\b(?:expired|invalid|reused)\b/iu,
];

const MAX_MESSAGE = 300;

/** What the error says about the account, or undefined when it says nothing about it. */
export function classifyRunError(message: string | undefined): Kind | undefined {
  if (!message?.trim()) return undefined;
  if (NO_PLAN.some((pattern) => pattern.test(message))) return "no-plan";
  if (SIGNED_OUT.some((pattern) => pattern.test(message))) return "signed-out";
  return undefined;
}

/** The agent's message, one line, short, and without anything shaped like a key or token. */
export function cleanRunMessage(message: string): string {
  const oneLine = message
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC.
    .replace(/\u001b\[[0-9;]*[A-Za-z]/gu, "")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{6,}/gu, "[key]")
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_\-.=+/]{40,}/gu, "[token]")
    .replace(/\s+/gu, " ")
    .trim();
  return oneLine.length > MAX_MESSAGE ? `${oneLine.slice(0, MAX_MESSAGE - 1)}…` : oneLine;
}

/** Changes when the person signs in again as someone else, or with another plan or method. */
export function loginKey(login: AgentLogin | undefined): string {
  if (!login) return "unknown";
  return [login.status, login.method ?? "", login.email ?? "", login.plan ?? ""].join("|");
}

type Entry = { problem: AgentRunProblem; loginKey: string | undefined };

/**
 * The last run failure per agent that says its usual login cannot run it. Kept in memory: after a restart
 * the next failing run records it again.
 */
export class RunProblems {
  private readonly entries = new Map<ListedProviderKind, Entry>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Records the failure if it is about the account. `login` is the login known when it failed. */
  record(provider: ListedProviderKind, message: string | undefined, login?: AgentLogin): boolean {
    const kind = classifyRunError(message);
    if (!kind || !message) return false;
    const problem: AgentRunProblem = { kind, message: cleanRunMessage(message), at: this.now().toISOString() };
    const previous = this.entries.get(provider)?.problem;
    this.entries.set(provider, { problem, loginKey: login ? loginKey(login) : undefined });
    if (previous?.kind !== kind || previous.message !== problem.message) this.changed();
    return true;
  }

  /** A run went through, or the person asked to try again. */
  clear(provider: ListedProviderKind): void {
    if (this.entries.delete(provider)) this.changed();
  }

  get(provider: ListedProviderKind): AgentRunProblem | undefined {
    return this.entries.get(provider)?.problem;
  }

  /**
   * Adds each agent's problem to its discovery. A problem recorded under one login is dropped once the
   * agent is signed in differently, since the new login has not failed yet.
   */
  apply(discoveries: readonly ProviderDiscovery[]): readonly ProviderDiscovery[] {
    // The same list when there is nothing to add, so callers that cache by identity keep working.
    if (this.entries.size === 0) return discoveries;
    let dropped = false;
    const result = discoveries.map((entry) => {
      const stored = this.entries.get(entry.provider);
      if (!stored) return entry;
      if (entry.status !== "found") {
        this.entries.delete(entry.provider);
        dropped = true;
        return entry;
      }
      const key = loginKey(entry.login);
      if (stored.loginKey === undefined) stored.loginKey = key;
      else if (stored.loginKey !== key) {
        this.entries.delete(entry.provider);
        dropped = true;
        return entry;
      }
      return { ...entry, problem: stored.problem };
    });
    if (dropped) this.changed();
    return result;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
