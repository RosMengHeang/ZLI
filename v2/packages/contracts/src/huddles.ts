import { z } from "zod";

import type { ProjectProjection, WorktreeProjection } from "./projections.js";
import type { ProviderDiscovery, ThreadProjection } from "./provider.js";
import type { TerminalProjection } from "./terminal.js";

/**
 * A huddle is a saved conversation between agents, with the person as moderator. Members are chat
 * threads or agent terminals, from one project or, when Settings allow it, several.
 */
export const HuddleId = z.string().uuid().brand<"HuddleId">();
export type HuddleId = z.infer<typeof HuddleId>;

export const HuddlePostId = z.string().uuid().brand<"HuddlePostId">();
export type HuddlePostId = z.infer<typeof HuddlePostId>;

export const MAX_HUDDLE_MEMBERS = 12;
export const MAX_POSTS_PER_HUDDLE = 500;
export const MAX_HUDDLE_TEXT = 8_000;
/** An automatic reply longer than this is cut; the full text stays in the agent's chat. */
export const HUDDLE_REPLY_LIMIT = 2_000;
/**
 * Agent messages in a row, with nothing from the person, before the huddle holds the rest. Agents
 * that keep answering each other are coordinating instead of working.
 */
export const HUDDLE_AGENT_STREAK_LIMIT = 12;
export const HUDDLE_PAUSED_REASON = `Held because the huddle paused after ${HUDDLE_AGENT_STREAK_LIMIT} agent messages in a row.`;
/** Why a terminal agent's copy waits: the person has typed there without pressing Enter. */
export const HUDDLE_TYPING_REASON = "Held while you have unsent typing in this terminal.";

export const HuddleName = z
  .string()
  .trim()
  .min(1, "Give the huddle a name.")
  .max(60, "Keep the huddle name to 60 characters.");

/** A thread id or terminal id. */
export const HuddleAgentId = z.string().min(1).max(200);

export const HuddleMemberKind = z.enum(["chat", "terminal"]);
export type HuddleMemberKind = z.infer<typeof HuddleMemberKind>;

export const HuddleMember = z.object({
  agentId: HuddleAgentId,
  kind: HuddleMemberKind,
  joinedAt: z.string().datetime({ offset: true }),
  /** Set once the member got the list of who else is in the huddle, with its first message. */
  introduced: z.literal(true).optional(),
});
export type HuddleMember = z.infer<typeof HuddleMember>;

export const HuddleSender = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person") }),
  z.object({ kind: z.literal("agent"), agentId: HuddleAgentId }),
]);
export type HuddleSender = z.infer<typeof HuddleSender>;

/** Every member but the sender, only the person, or the listed members. */
export const HuddleTarget = z.union([
  z.literal("everyone"),
  z.literal("person"),
  z.array(HuddleAgentId).min(1).max(MAX_HUDDLE_MEMBERS),
]);
export type HuddleTarget = z.infer<typeof HuddleTarget>;

/**
 * ask wants an answer and assign hands over work; a chat agent's answer to either is posted back for
 * it. note shares information or answers, and expects nothing back, which keeps agents from answering
 * each other's answers forever.
 */
export const HuddlePostKind = z.enum(["ask", "assign", "note"]);
export type HuddlePostKind = z.infer<typeof HuddlePostKind>;

/**
 * pending: not handled yet. held: waiting, with the reason. queued: in a busy chat's queue.
 * delivered: the agent has it. failed: it will not arrive, with the reason.
 */
export const HuddleDeliveryStatus = z.enum(["pending", "held", "queued", "delivered", "failed"]);
export type HuddleDeliveryStatus = z.infer<typeof HuddleDeliveryStatus>;

const SentHash = z.string().regex(/^[0-9a-f]{16}$/u);

export const HuddleDelivery = z.object({
  agentId: HuddleAgentId,
  status: HuddleDeliveryStatus,
  reason: z.string().min(1).max(300).optional(),
  /** A chat agent got this and its answer has not been posted back yet. */
  awaitingReply: z.literal(true).optional(),
  /**
   * A fingerprint of the exact text ZLI handed the member, recorded before typing into a terminal. It
   * finds a chat's answer and keeps a restart from typing a message twice.
   */
  sentHash: SentHash.optional(),
});
export type HuddleDelivery = z.infer<typeof HuddleDelivery>;

export const HuddlePost = z.object({
  postId: HuddlePostId,
  huddleId: HuddleId,
  /** Counts from 1 within the huddle, so agents and the person can say "message 4". */
  number: z.number().int().positive(),
  from: HuddleSender,
  to: HuddleTarget,
  kind: HuddlePostKind,
  text: z.string().min(1).max(MAX_HUDDLE_TEXT),
  /** Marked as agreed. Agents can read just these with huddle_decisions. */
  decision: z.literal(true).optional(),
  replyTo: HuddlePostId.optional(),
  /** Posted by ZLI from a chat agent's answer, not by a tool call. */
  auto: z.literal(true).optional(),
  /** The answer was longer than HUDDLE_REPLY_LIMIT; the full text is in the agent's chat. */
  cut: z.literal(true).optional(),
  createdAt: z.string().datetime({ offset: true }),
  deliveries: z.array(HuddleDelivery),
});
export type HuddlePost = z.infer<typeof HuddlePost>;

export const HuddleProjection = z.object({
  huddleId: HuddleId,
  name: HuddleName,
  members: z.array(HuddleMember).max(MAX_HUDDLE_MEMBERS),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  archived: z.literal(true).optional(),
  /** Agent messages are held until the person writes or resumes. */
  paused: z.literal(true).optional(),
  /** Agent messages since the person last wrote or resumed. */
  agentStreak: z.number().int().nonnegative(),
  nextNumber: z.number().int().positive(),
});
export type HuddleProjection = z.infer<typeof HuddleProjection>;

const DeliveryFields = {
  huddleId: HuddleId,
  postId: HuddlePostId,
  agentId: HuddleAgentId,
  status: HuddleDeliveryStatus,
  reason: z.string().min(1).max(300).optional(),
  /** true marks the answer as expected, false as handled. */
  awaitingReply: z.boolean().optional(),
  /** The delivered text included the member list, so later ones leave it out. */
  introduced: z.literal(true).optional(),
  sentHash: SentHash.optional(),
};

export const HuddleCommand = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("huddle.create"),
    huddleId: HuddleId,
    name: HuddleName,
    members: z.array(HuddleAgentId).max(MAX_HUDDLE_MEMBERS).optional(),
  }),
  z.object({ type: z.literal("huddle.rename"), huddleId: HuddleId, name: HuddleName }),
  z.object({ type: z.literal("huddle.archive"), huddleId: HuddleId }),
  z.object({ type: z.literal("huddle.join"), huddleId: HuddleId, agentId: HuddleAgentId }),
  /** Takes the agent out; it loses access to the huddle at once. */
  z.object({ type: z.literal("huddle.leave"), huddleId: HuddleId, agentId: HuddleAgentId }),
  z.object({
    type: z.literal("huddle.post"),
    huddleId: HuddleId,
    postId: HuddlePostId,
    /** The member posting. Omitted means the person. */
    from: HuddleAgentId.optional(),
    to: HuddleTarget,
    kind: HuddlePostKind,
    text: z.string().trim().min(1, "Write the message.").max(MAX_HUDDLE_TEXT),
    replyTo: HuddlePostId.optional(),
    auto: z.boolean().optional(),
    cut: z.boolean().optional(),
  }),
  z.object({ type: z.literal("huddle.decide"), huddleId: HuddleId, postId: HuddlePostId, decision: z.boolean() }),
  z.object({ type: z.literal("huddle.resume"), huddleId: HuddleId }),
  /** Internal: the runtime reports how a delivery went. */
  z.object({ type: z.literal("huddle.delivery"), ...DeliveryFields }),
  /** Types the messages held for a terminal agent now, even though the person has unsent input there. */
  z.object({ type: z.literal("huddle.release"), agentId: HuddleAgentId }),
]);
export type HuddleCommand = z.infer<typeof HuddleCommand>;

const NewMember = z.object({ agentId: HuddleAgentId, kind: HuddleMemberKind });

/** Events leave out times: the fold takes them from the event envelope, so the decider stays pure. */
export const HuddleEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("huddle.created"),
    huddleId: HuddleId,
    name: HuddleName,
    members: z.array(NewMember).max(MAX_HUDDLE_MEMBERS),
  }),
  z.object({ type: z.literal("huddle.renamed"), huddleId: HuddleId, name: HuddleName }),
  z.object({ type: z.literal("huddle.archived"), huddleId: HuddleId }),
  z.object({ type: z.literal("huddle.member.joined"), huddleId: HuddleId, member: NewMember }),
  z.object({ type: z.literal("huddle.member.left"), huddleId: HuddleId, agentId: HuddleAgentId }),
  z.object({ type: z.literal("huddle.posted"), post: HuddlePost.omit({ createdAt: true }) }),
  z.object({
    type: z.literal("huddle.decision.changed"),
    huddleId: HuddleId,
    postId: HuddlePostId,
    decision: z.boolean(),
  }),
  z.object({ type: z.literal("huddle.resumed"), huddleId: HuddleId }),
  z.object({ type: z.literal("huddle.delivery.changed"), ...DeliveryFields }),
  z.object({ type: z.literal("huddle.release.requested"), agentId: HuddleAgentId }),
]);
export type HuddleEvent = z.infer<typeof HuddleEvent>;
export const HUDDLE_EVENT_TYPES: ReadonlySet<string> = new Set(
  HuddleEvent.options.map((option) => option.shape.type.value),
);

export function isHuddleEvent(event: { type: string }): event is HuddleEvent {
  return HUDDLE_EVENT_TYPES.has(event.type);
}

export type HuddleState = {
  huddles?: HuddleProjection[] | undefined;
  huddlePosts?: HuddlePost[] | undefined;
};

const ARCHIVED_REASON = "The huddle was archived before this went out.";
const LEFT_REASON = "Left the huddle before this went out.";

/** Fails the open deliveries in matching posts for matching agents, and stops waiting for their answers. */
function endDeliveries(
  posts: readonly HuddlePost[],
  inPost: (post: HuddlePost) => boolean,
  forAgent: (agentId: string) => boolean,
  reason: string,
): HuddlePost[] {
  return posts.map((post) =>
    !inPost(post) || !post.deliveries.some((delivery) => forAgent(delivery.agentId))
      ? post
      : {
          ...post,
          deliveries: post.deliveries.map((delivery) => {
            if (!forAgent(delivery.agentId)) return delivery;
            if (delivery.status === "delivered" || delivery.status === "failed") return withoutAwaiting(delivery);
            return { agentId: delivery.agentId, status: "failed" as const, reason };
          }),
        },
  );
}

/**
 * Folds one huddle event. The server projector and the client store both use this, so they agree.
 * Returns only the huddle fields.
 */
export function applyHuddleEvent(state: HuddleState, event: HuddleEvent, occurredAt: string): Required<HuddleState> {
  const huddles = state.huddles ?? [];
  const posts = state.huddlePosts ?? [];
  const updateHuddle = (huddleId: string, change: (huddle: HuddleProjection) => HuddleProjection) =>
    huddles.map((huddle) => (huddle.huddleId === huddleId ? change(huddle) : huddle));
  const updatePost = (postId: string, change: (post: HuddlePost) => HuddlePost) =>
    posts.map((post) => (post.postId === postId ? change(post) : post));
  const endOpenDeliveries = (huddleId: string, agentId: string | undefined, reason: string) =>
    endDeliveries(
      posts,
      (post) => post.huddleId === huddleId,
      (id) => agentId === undefined || id === agentId,
      reason,
    );
  switch (event.type) {
    case "huddle.created":
      return {
        huddles: [
          ...huddles.filter((huddle) => huddle.huddleId !== event.huddleId),
          {
            huddleId: event.huddleId,
            name: event.name,
            members: event.members.map((member) => ({ ...member, joinedAt: occurredAt })),
            createdAt: occurredAt,
            updatedAt: occurredAt,
            agentStreak: 0,
            nextNumber: 1,
          },
        ],
        huddlePosts: posts,
      };
    case "huddle.renamed":
      return {
        huddles: updateHuddle(event.huddleId, (huddle) => ({ ...huddle, name: event.name, updatedAt: occurredAt })),
        huddlePosts: posts,
      };
    case "huddle.archived":
      return {
        huddles: updateHuddle(event.huddleId, (huddle) => ({ ...huddle, archived: true, updatedAt: occurredAt })),
        huddlePosts: endOpenDeliveries(event.huddleId, undefined, ARCHIVED_REASON),
      };
    case "huddle.member.joined":
      return {
        huddles: updateHuddle(event.huddleId, (huddle) => ({
          ...huddle,
          members: [
            ...huddle.members.filter((member) => member.agentId !== event.member.agentId),
            { ...event.member, joinedAt: occurredAt },
          ],
          updatedAt: occurredAt,
        })),
        huddlePosts: posts,
      };
    case "huddle.member.left":
      return {
        huddles: updateHuddle(event.huddleId, (huddle) => ({
          ...huddle,
          members: huddle.members.filter((member) => member.agentId !== event.agentId),
          updatedAt: occurredAt,
        })),
        huddlePosts: endOpenDeliveries(event.huddleId, event.agentId, LEFT_REASON),
      };
    case "huddle.posted": {
      const post: HuddlePost = { ...event.post, createdAt: occurredAt };
      const fromAgent = post.from.kind === "agent" ? post.from.agentId : undefined;
      const kept = posts.filter((candidate) => candidate.postId !== post.postId);
      // A member that writes to the huddle has answered what it replies to, or without a reply
      // number, whatever it was expected to answer there.
      const answered = fromAgent
        ? kept.map((candidate) =>
            candidate.huddleId !== post.huddleId || (post.replyTo !== undefined && candidate.postId !== post.replyTo)
              ? candidate
              : {
                  ...candidate,
                  deliveries: candidate.deliveries.map((delivery) =>
                    delivery.agentId === fromAgent ? withoutAwaiting(delivery) : delivery,
                  ),
                },
          )
        : kept;
      return {
        huddles: updateHuddle(post.huddleId, (huddle) => {
          const agentStreak = fromAgent ? huddle.agentStreak + 1 : 0;
          const { paused: _paused, ...rest } = huddle;
          return {
            ...rest,
            agentStreak,
            nextNumber: Math.max(huddle.nextNumber, post.number + 1),
            updatedAt: occurredAt,
            ...(agentStreak > HUDDLE_AGENT_STREAK_LIMIT ? { paused: true as const } : {}),
          };
        }),
        huddlePosts: trimHuddle([...answered, post], post.huddleId),
      };
    }
    case "huddle.decision.changed":
      return {
        huddles,
        huddlePosts: updatePost(event.postId, (post) => {
          const { decision: _decision, ...rest } = post;
          return event.decision ? { ...rest, decision: true as const } : rest;
        }),
      };
    case "huddle.resumed":
      return {
        huddles: updateHuddle(event.huddleId, (huddle) => {
          const { paused: _paused, ...rest } = huddle;
          return { ...rest, agentStreak: 0, updatedAt: occurredAt };
        }),
        huddlePosts: posts,
      };
    case "huddle.delivery.changed":
      return {
        huddles: event.introduced
          ? updateHuddle(event.huddleId, (huddle) => ({
              ...huddle,
              members: huddle.members.map((member) =>
                member.agentId === event.agentId ? { ...member, introduced: true as const } : member,
              ),
            }))
          : huddles,
        huddlePosts: updatePost(event.postId, (post) => ({
          ...post,
          deliveries: post.deliveries.map((delivery) => {
            if (delivery.agentId !== event.agentId) return delivery;
            const awaiting = event.awaitingReply === undefined ? delivery.awaitingReply === true : event.awaitingReply;
            const sentHash = event.sentHash ?? delivery.sentHash;
            return {
              agentId: delivery.agentId,
              status: event.status,
              ...(event.reason ? { reason: event.reason } : {}),
              ...(awaiting ? { awaitingReply: true as const } : {}),
              ...(sentHash ? { sentHash } : {}),
            };
          }),
        })),
      };
    case "huddle.release.requested":
      return { huddles, huddlePosts: posts };
  }
}

function withoutAwaiting(delivery: HuddleDelivery): HuddleDelivery {
  if (!delivery.awaitingReply) return delivery;
  const { awaitingReply: _awaiting, ...rest } = delivery;
  return rest;
}

/** Drops the oldest posts past the cap. Pinned decisions stay, since agents read them as the agreed plan. */
function trimHuddle(posts: HuddlePost[], huddleId: string): HuddlePost[] {
  let excess = posts.filter((post) => post.huddleId === huddleId).length - MAX_POSTS_PER_HUDDLE;
  if (excess <= 0) return posts;
  return posts.filter((post) => {
    if (excess > 0 && post.huddleId === huddleId && !post.decision) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

/** Takes deleted agents out of every huddle they were in, ending their open deliveries as leaving does. */
export function dropHuddleMembers<T extends HuddleState>(state: T, agentIds: readonly string[]): T {
  if (!state.huddles || agentIds.length === 0) return state;
  const gone = new Set(agentIds);
  return {
    ...state,
    huddles: state.huddles.map((huddle) =>
      huddle.members.some((member) => gone.has(member.agentId))
        ? { ...huddle, members: huddle.members.filter((member) => !gone.has(member.agentId)) }
        : huddle,
    ),
    ...(state.huddlePosts
      ? {
          huddlePosts: endDeliveries(
            state.huddlePosts,
            () => true,
            (agentId) => gone.has(agentId),
            LEFT_REASON,
          ),
        }
      : {}),
  };
}

/** The live huddles an agent is a member of. */
export function huddlesOf(state: HuddleState, agentId: string): HuddleProjection[] {
  return (state.huddles ?? []).filter(
    (huddle) => !huddle.archived && huddle.members.some((member) => member.agentId === agentId),
  );
}

export function huddlePostsOf(state: HuddleState, huddleId: string): HuddlePost[] {
  return (state.huddlePosts ?? []).filter((post) => post.huddleId === huddleId);
}

/** Who a post is delivered to: everyone named, or every member but the sender. The person needs no delivery. */
export function huddleRecipients(
  huddle: Pick<HuddleProjection, "members">,
  from: HuddleSender,
  to: HuddleTarget,
): string[] {
  if (to === "person") return [];
  const sender = from.kind === "agent" ? from.agentId : undefined;
  const members = huddle.members.map((member) => member.agentId);
  return (to === "everyone" ? members : to.filter((id) => members.includes(id))).filter((id) => id !== sender);
}

export type HuddleAgentState = {
  projects: readonly ProjectProjection[];
  worktrees: readonly WorktreeProjection[];
  threads: readonly ThreadProjection[];
  terminals: readonly TerminalProjection[];
  providers?: readonly ProviderDiscovery[] | undefined;
};

export type HuddleAgentInfo = {
  agentId: string;
  kind: HuddleMemberKind;
  /** The agent's name, or its provider when it has none. */
  label: string;
  name?: string;
  providerName: string;
  status: string;
  projectId?: string;
  projectName?: string;
  /** The agent that started this one, which makes this one its sub-agent. */
  startedBy?: string;
};

/** Who an agent id is, for headings and member lists. Undefined when it is not a chat or an agent terminal. */
export function huddleAgentInfo(state: HuddleAgentState, agentId: string): HuddleAgentInfo | undefined {
  const providerName = (provider: string) =>
    state.providers?.find((entry) => entry.provider === provider)?.displayName ?? provider;
  const place = (worktreeId: string) => {
    const projectId = state.worktrees.find((worktree) => worktree.worktreeId === worktreeId)?.projectId;
    const projectName = state.projects.find((project) => project.projectId === projectId)?.name;
    return { ...(projectId ? { projectId } : {}), ...(projectName ? { projectName } : {}) };
  };
  const thread = state.threads.find((candidate) => candidate.threadId === agentId);
  if (thread) {
    const provider = providerName(thread.provider);
    return {
      agentId,
      kind: "chat",
      label: thread.name ?? provider,
      ...(thread.name ? { name: thread.name } : {}),
      providerName: provider,
      status: thread.status,
      ...place(thread.worktreeId),
      ...(thread.startedBy ? { startedBy: thread.startedBy } : {}),
    };
  }
  const terminal = state.terminals.find((candidate) => candidate.terminalId === agentId);
  if (terminal?.agent) {
    const provider = providerName(terminal.agent.provider);
    return {
      agentId,
      kind: "terminal",
      label: terminal.name ?? provider,
      ...(terminal.name ? { name: terminal.name } : {}),
      providerName: provider,
      status: terminal.status,
      ...place(terminal.worktreeId),
      ...(terminal.startedBy ? { startedBy: terminal.startedBy } : {}),
    };
  }
  return undefined;
}

/** The huddle's members come from more than one project. */
export function huddleSpansProjects(state: HuddleAgentState, agentIds: readonly string[]): boolean {
  const projects = new Set(agentIds.map((agentId) => huddleAgentInfo(state, agentId)?.projectId).filter(Boolean));
  return projects.size > 1;
}

/** The short id agents and the CLI can use for a huddle. */
export function shortHuddleId(huddleId: string): string {
  return huddleId.slice(0, 8);
}
