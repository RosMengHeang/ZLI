import { randomUUID } from "node:crypto";

import type { AgentReachAnswer, AgentReachRequest } from "@zli-v2/contracts";

export type ReachOutcome = "allowed" | "declined" | "unanswered";

export type ReachAsk = Omit<AgentReachRequest, "requestId">;

export type ReachRequestsHost = {
  /** Shows the open request in the window, or clears it when undefined. */
  show(request: AgentReachRequest | undefined): void;
  /** Tells the person outside the window that an agent is waiting for an answer. */
  notify(request: AgentReachRequest): void;
  /** Lets agents reach every project. */
  allow(): Promise<void>;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** How long one agent waits for an answer. The request stays open after that. */
  readonly waitMs?: number;
  /** How long a "no" holds before an agent can ask the person again. */
  readonly declineHoldMs?: number;
};

/**
 * Asks the person whether agents may reach other projects. One request is open at a time, and
 * agents that ask while it is open wait for the same answer. An answer given after an agent stopped
 * waiting still applies, so Allow always takes effect.
 */
export class ReachRequests {
  private open: { request: AgentReachRequest; waiters: Set<(outcome: ReachOutcome) => void> } | undefined;
  private declinedAt: number | undefined;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly waitMs: number;
  private readonly declineHoldMs: number;

  constructor(private readonly host: ReachRequestsHost) {
    this.now = host.now ?? Date.now;
    this.newId = host.newId ?? randomUUID;
    this.waitMs = host.waitMs ?? 50_000;
    this.declineHoldMs = host.declineHoldMs ?? 10 * 60_000;
  }

  current(): AgentReachRequest | undefined {
    return this.open?.request;
  }

  ask(details: ReachAsk): Promise<ReachOutcome> {
    if (this.declinedAt !== undefined && this.now() - this.declinedAt < this.declineHoldMs)
      return Promise.resolve("declined");
    if (!this.open) {
      const request: AgentReachRequest = { requestId: this.newId(), ...details };
      this.open = { request, waiters: new Set() };
      this.host.show(request);
      this.host.notify(request);
    }
    const { waiters } = this.open;
    return new Promise<ReachOutcome>((resolve) => {
      const waiter = (outcome: ReachOutcome) => {
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve(outcome);
      };
      const timer = setTimeout(() => waiter("unanswered"), this.waitMs);
      waiters.add(waiter);
    });
  }

  /** When allowing fails, the question stays open so the person can try again. */
  async answer(answer: AgentReachAnswer): Promise<void> {
    const open = this.open;
    if (!open || open.request.requestId !== answer.requestId) return;
    if (answer.allow) {
      await this.host.allow();
      this.declinedAt = undefined;
    } else this.declinedAt = this.now();
    // A second click may have answered while allowing was saved.
    if (this.open !== open) return;
    this.open = undefined;
    this.host.show(undefined);
    for (const waiter of [...open.waiters]) waiter(answer.allow ? "allowed" : "declined");
  }
}
