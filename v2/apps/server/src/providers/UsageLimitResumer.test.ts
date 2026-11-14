import type { RpcRequest, RuntimeProjection, ThreadProjection } from "@zli-v2/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Engine } from "../orchestration/Engine.js";
import { RESUME_TEXT, UsageLimitResumer } from "./UsageLimitResumer.js";

const threadId = "00000000-0000-4000-8000-000000000101";
const reset = Date.parse("2026-11-13T15:00:00.000Z");

function fakeEngine(thread: Partial<ThreadProjection>, refuse = 0, queued = 0) {
  const sent: RpcRequest[] = [];
  let refusals = refuse;
  const state = {
    thread: {
      threadId,
      worktreeId: "00000000-0000-4000-8000-000000000201",
      provider: "claude-code",
      status: "failed",
      capabilities: {},
      providerSessionId: "session-1",
      ...thread,
    } as ThreadProjection,
  };
  const engine = {
    projection: async () =>
      ({
        threads: [state.thread],
        queuedMessages: Array.from({ length: queued }, (_, index) => ({
          queueId: `q${index}`,
          threadId,
          text: "later",
        })),
      }) as unknown as RuntimeProjection,
    subscribe: () => () => undefined,
    dispatchPromise: async (request: RpcRequest) => {
      sent.push(request);
      if (refusals > 0) {
        refusals -= 1;
        return { status: "rejected" };
      }
      const { usageLimit: _limit, ...rest } = state.thread;
      state.thread = { ...rest, status: "starting" };
      return { status: "accepted" };
    },
  } as unknown as Engine;
  return { engine, sent };
}

afterEach(() => vi.useRealTimers());

describe("UsageLimitResumer", () => {
  it("tells the agent to continue once the reset has passed, and only once", async () => {
    let now = reset - 60_000;
    const { engine, sent } = fakeEngine({ usageLimit: { resetsAt: new Date(reset).toISOString(), autoResume: true } });
    const resumer = new UsageLimitResumer(engine, { now: () => now });
    await resumer.check();
    expect(sent).toEqual([]);
    now = reset + 31_000;
    await resumer.check();
    await resumer.check();
    expect(sent.map((request) => request.command)).toEqual([
      expect.objectContaining({ type: "thread.queue", threadId, text: RESUME_TEXT }),
    ]);
    resumer.stop();
  });

  it("tries again when the runtime refuses the resume, instead of giving up on the chat", async () => {
    const { engine, sent } = fakeEngine(
      { usageLimit: { resetsAt: new Date(reset).toISOString(), autoResume: true } },
      1,
    );
    const resumer = new UsageLimitResumer(engine, { now: () => reset + 31_000 });
    await resumer.check();
    await resumer.check();
    expect(sent).toHaveLength(2);
    await resumer.check();
    expect(sent).toHaveLength(2);
    resumer.stop();
  });

  it("only wakes a chat that already has messages waiting, so a full queue never blocks the resume", async () => {
    const { engine, sent } = fakeEngine(
      { usageLimit: { resetsAt: new Date(reset).toISOString(), autoResume: true } },
      0,
      20,
    );
    const resumer = new UsageLimitResumer(engine, { now: () => reset + 31_000 });
    await resumer.check();
    expect(sent.map((request) => request.command)).toEqual([{ type: "thread.wake", threadId }]);
    resumer.stop();
  });

  it("leaves a chat alone unless the person asked it to resume", async () => {
    const { engine, sent } = fakeEngine({ usageLimit: { resetsAt: new Date(reset).toISOString() } });
    const resumer = new UsageLimitResumer(engine, { now: () => reset + 3_600_000 });
    await resumer.check();
    expect(sent).toEqual([]);
    resumer.stop();
  });
});
