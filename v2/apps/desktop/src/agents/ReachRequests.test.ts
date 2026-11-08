import type { AgentReachRequest } from "@zli-v2/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReachRequests } from "./ReachRequests.js";

const ID = "00000000-0000-4000-8000-000000000001";
const ask = { agent: "Bob", project: "collect", target: { agent: "Kim", project: "web" } };

function setup(options: { allow?: () => Promise<void> } = {}) {
  let now = 0;
  const shown: Array<AgentReachRequest | undefined> = [];
  const notified: AgentReachRequest[] = [];
  let allowed = 0;
  const requests = new ReachRequests({
    show: (request) => shown.push(request),
    notify: (request) => notified.push(request),
    allow:
      options.allow ??
      (async () => {
        allowed += 1;
      }),
    now: () => now,
    newId: () => ID,
    waitMs: 1_000,
    declineHoldMs: 60_000,
  });
  return {
    requests,
    shown,
    notified,
    allowed: () => allowed,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ReachRequests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows one question for every agent that asks, and answers them all", async () => {
    const h = setup();
    const first = h.requests.ask(ask);
    const second = h.requests.ask({ agent: "Ana", project: "collect" });
    expect(h.shown).toEqual([{ requestId: ID, ...ask }]);
    expect(h.notified).toHaveLength(1);
    expect(h.requests.current()).toEqual({ requestId: ID, ...ask });
    await h.requests.answer({ requestId: ID, allow: true });
    await expect(first).resolves.toBe("allowed");
    await expect(second).resolves.toBe("allowed");
    expect(h.allowed()).toBe(1);
    expect(h.shown.at(-1)).toBeUndefined();
    expect(h.requests.current()).toBeUndefined();
  });

  it("stops waiting after a while but keeps the question open, so a late Allow still applies", async () => {
    const h = setup();
    const waiting = h.requests.ask(ask);
    vi.advanceTimersByTime(1_000);
    await expect(waiting).resolves.toBe("unanswered");
    expect(h.requests.current()).toBeDefined();
    await h.requests.answer({ requestId: ID, allow: true });
    expect(h.allowed()).toBe(1);
  });

  it("ignores an answer to another question", async () => {
    const h = setup();
    void h.requests.ask(ask);
    await h.requests.answer({ requestId: "00000000-0000-4000-8000-000000000009", allow: true });
    expect(h.allowed()).toBe(0);
    expect(h.requests.current()).toBeDefined();
  });

  it("does not ask again for a while after the person says no", async () => {
    const h = setup();
    const waiting = h.requests.ask(ask);
    await h.requests.answer({ requestId: ID, allow: false });
    await expect(waiting).resolves.toBe("declined");
    await expect(h.requests.ask(ask)).resolves.toBe("declined");
    expect(h.shown).toHaveLength(2);
    h.advance(60_000);
    void h.requests.ask(ask);
    expect(h.shown).toHaveLength(3);
  });

  it("keeps the question open when allowing fails, so the person can try again", async () => {
    let fail = true;
    const h = setup({
      allow: async () => {
        if (fail) throw new Error("store is read-only");
      },
    });
    const waiting = h.requests.ask(ask);
    await expect(h.requests.answer({ requestId: ID, allow: true })).rejects.toThrow("store is read-only");
    expect(h.requests.current()).toBeDefined();
    fail = false;
    await h.requests.answer({ requestId: ID, allow: true });
    await expect(waiting).resolves.toBe("allowed");
  });

  it("asks again after an Allow, once Settings keep agents to their own project again", async () => {
    const h = setup();
    void h.requests.ask(ask);
    await h.requests.answer({ requestId: ID, allow: true });
    const again = h.requests.ask(ask);
    expect(h.requests.current()).toEqual({ requestId: ID, ...ask });
    expect(h.notified).toHaveLength(2);
    await h.requests.answer({ requestId: ID, allow: false });
    await expect(again).resolves.toBe("declined");
  });

  it("holds a no given after the agent stopped waiting", async () => {
    const h = setup();
    const waiting = h.requests.ask(ask);
    vi.advanceTimersByTime(1_000);
    await expect(waiting).resolves.toBe("unanswered");
    await h.requests.answer({ requestId: ID, allow: false });
    expect(h.requests.current()).toBeUndefined();
    await expect(h.requests.ask(ask)).resolves.toBe("declined");
  });

  it("does nothing for an answer to a question that is already closed", async () => {
    const h = setup();
    const waiting = h.requests.ask(ask);
    await h.requests.answer({ requestId: ID, allow: true });
    await h.requests.answer({ requestId: ID, allow: false });
    await expect(waiting).resolves.toBe("allowed");
    expect(h.allowed()).toBe(1);
    void h.requests.ask(ask);
    expect(h.requests.current()).toBeDefined();
  });
});
