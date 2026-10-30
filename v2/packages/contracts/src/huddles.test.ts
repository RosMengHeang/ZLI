import { describe, expect, it } from "vitest";

import {
  applyHuddleEvent,
  dropHuddleMembers,
  HUDDLE_AGENT_TURN_LIMIT,
  type HuddleEvent,
  HuddleId,
  type HuddlePost,
  HuddlePostId,
  type HuddleProjection,
  MAX_POSTS_PER_HUDDLE,
} from "./huddles.js";

const HUDDLE = HuddleId.parse("00000000-0000-4000-8000-0000000000e1");
const LEAD = "00000000-0000-4000-8000-0000000000c1";
const HELPER = "00000000-0000-4000-8000-0000000000c2";
const AT = "2026-01-03T00:00:00.000Z";

function post(number: number, fields: Partial<HuddlePost> = {}): HuddlePost {
  return {
    postId: HuddlePostId.parse(`00000000-0000-4000-8000-${String(number).padStart(12, "0")}`),
    huddleId: HUDDLE,
    number,
    from: { kind: "person" },
    to: "everyone",
    kind: "note",
    text: `Message ${number}`,
    createdAt: AT,
    deliveries: [],
    ...fields,
  };
}

const huddle: HuddleProjection = {
  huddleId: HUDDLE,
  name: "Login",
  members: [
    { agentId: LEAD, kind: "chat", joinedAt: AT },
    { agentId: HELPER, kind: "chat", joinedAt: AT },
  ],
  createdAt: AT,
  updatedAt: AT,
  agentTurns: 0,
  nextNumber: 1,
};

const posted = (posts: HuddlePost[], next: HuddlePost) =>
  applyHuddleEvent(
    { huddles: [{ ...huddle, nextNumber: next.number }], huddlePosts: posts },
    { type: "huddle.posted", post: next },
    AT,
  ).huddlePosts ?? [];

describe("huddle fold", () => {
  it("keeps pinned decisions when trimming the oldest posts", () => {
    const posts = Array.from({ length: MAX_POSTS_PER_HUDDLE }, (_, index) =>
      post(index + 1, index === 0 ? { decision: true } : {}),
    );
    const kept = posted(posts, post(MAX_POSTS_PER_HUDDLE + 1));
    expect(kept).toHaveLength(MAX_POSTS_PER_HUDDLE);
    expect(kept.map((entry) => entry.number).slice(0, 2)).toEqual([1, 3]);
  });

  it("clears only the answer a reply points at", () => {
    const waiting = { agentId: HELPER, status: "delivered" as const, awaitingReply: true as const };
    const asks = [post(1, { kind: "ask", deliveries: [waiting] }), post(2, { kind: "ask", deliveries: [waiting] })];
    const reply = post(3, { from: { kind: "agent", agentId: HELPER }, replyTo: asks[0]?.postId });
    const after = posted(asks, reply);
    expect(after[0]?.deliveries[0]?.awaitingReply).toBeUndefined();
    expect(after[1]?.deliveries[0]?.awaitingReply).toBe(true);
  });

  it("counts turns agents start for each other, pauses at the limit, and resets when the person writes", () => {
    const fold = (state: ReturnType<typeof applyHuddleEvent>, event: HuddleEvent) => applyHuddleEvent(state, event, AT);
    let state = applyHuddleEvent(
      { huddles: [huddle], huddlePosts: [post(1, { deliveries: [{ agentId: HELPER, status: "pending" }] })] },
      { type: "huddle.resumed", huddleId: HUDDLE },
      AT,
    );
    const turn = {
      type: "huddle.delivery.changed",
      huddleId: HUDDLE,
      postId: post(1).postId,
      agentId: HELPER,
      status: "delivered",
      turn: true,
    } as const;
    for (let index = 1; index < HUDDLE_AGENT_TURN_LIMIT; index += 1) state = fold(state, turn);
    expect(state.huddles?.[0]?.paused).toBeUndefined();
    state = fold(state, turn);
    expect(state.huddles?.[0]).toMatchObject({ paused: true, agentTurns: HUDDLE_AGENT_TURN_LIMIT });
    state = fold(state, { type: "huddle.posted", post: post(2) });
    expect(state.huddles?.[0]?.paused).toBeUndefined();
    expect(state.huddles?.[0]?.agentTurns).toBe(0);
  });

  it("marks a member that posted until it gets a message or reads one from someone else", () => {
    const fold = (state: ReturnType<typeof applyHuddleEvent>, event: HuddleEvent) => applyHuddleEvent(state, event, AT);
    const helperOf = (state: ReturnType<typeof applyHuddleEvent>) =>
      state.huddles?.[0]?.members.find((member) => member.agentId === HELPER);
    let state = fold(
      { huddles: [huddle], huddlePosts: [] },
      { type: "huddle.posted", post: post(1, { from: { kind: "agent", agentId: HELPER }, to: [LEAD] }) },
    );
    expect(helperOf(state)?.posted).toBe(true);
    // Reading only its own post leaves the mark.
    state = fold(state, { type: "huddle.member.read", huddleId: HUDDLE, agentId: HELPER, upTo: 1 });
    expect(helperOf(state)).toMatchObject({ posted: true, readUpTo: 1 });
    state = fold(state, {
      type: "huddle.posted",
      post: post(2, {
        from: { kind: "agent", agentId: LEAD },
        to: [HELPER],
        deliveries: [{ agentId: HELPER, status: "inbox" }],
      }),
    });
    state = fold(state, { type: "huddle.member.read", huddleId: HUDDLE, agentId: HELPER, upTo: 2 });
    expect(helperOf(state)?.posted).toBeUndefined();
    expect(state.huddlePosts?.[1]?.deliveries[0]?.status).toBe("delivered");
  });

  it("fails a deleted agent's open deliveries, as leaving does", () => {
    const state: { huddles: HuddleProjection[]; huddlePosts: HuddlePost[] } = {
      huddles: [huddle],
      huddlePosts: [
        post(1, {
          deliveries: [
            { agentId: HELPER, status: "held", reason: "Held until the agent finishes starting." },
            { agentId: LEAD, status: "pending" },
          ],
        }),
      ],
    };
    const dropped = dropHuddleMembers(state, [HELPER]);
    expect(dropped.huddles?.[0]?.members.map((member) => member.agentId)).toEqual([LEAD]);
    expect(dropped.huddlePosts?.[0]?.deliveries).toEqual([
      { agentId: HELPER, status: "failed", reason: "Left the huddle before this went out." },
      { agentId: LEAD, status: "pending" },
    ]);
  });
});
