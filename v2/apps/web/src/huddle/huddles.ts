import {
  HUDDLE_AGENT_TURN_LIMIT,
  HUDDLE_LEAD_ROUND_LIMIT,
  HUDDLE_TYPING_REASON,
  type HuddleAgentInfo,
  type HuddleDelivery,
  type HuddlePost,
  type HuddlePostKind,
  type HuddleProjection,
  type HuddleTarget,
  huddleAgentInfo,
  type RuntimeProjection,
} from "@zli-v2/contracts";

import type { AgentSession } from "../sessions/sessions.js";

/** The drag payload a tile header carries: the agent's thread or terminal id. */
export const HUDDLE_AGENT_DRAG_TYPE = "application/x-zli-huddle-agent";

export function pausedMessage(huddle: Pick<HuddleProjection, "lead">): string {
  const cause =
    huddle.lead === undefined
      ? `agents started ${HUDDLE_AGENT_TURN_LIMIT} turns for each other`
      : `${HUDDLE_LEAD_ROUND_LIMIT} rounds of reports to the lead`;
  return `Paused after ${cause}. Their messages wait until you write or resume.`;
}

export const huddleKindLabel: Record<HuddlePostKind, string> = {
  ask: "Ask",
  assign: "Task",
  done: "Done",
  blocked: "Blocked",
  note: "Note",
};

const statusLabels: Record<string, string> = {
  starting: "Starting",
  idle: "Ready",
  working: "Working",
  waiting: "Needs input",
  stopped: "Stopped",
  failed: "Failed",
  running: "Running",
  exited: "Exited",
};

export function agentStatusLabel(status: string): string {
  return statusLabels[status] ?? status;
}

export function liveHuddles(projection: Pick<RuntimeProjection, "huddles">): HuddleProjection[] {
  return (projection.huddles ?? []).filter((huddle) => !huddle.archived);
}

/** The id a huddle knows the session's agent by: the chat on screen, or the agent terminal. */
export function sessionAgentId(session: Pick<AgentSession, "mode" | "terminal" | "thread">): string | undefined {
  if (session.mode === "terminal") return session.terminal?.agent ? session.terminal.terminalId : undefined;
  return session.thread?.threadId;
}

/** The session that holds an agent id, whether it is the chat on screen or an earlier one. */
export function sessionOfAgent(sessions: readonly AgentSession[], agentId: string): AgentSession | undefined {
  return sessions.find(
    (session) =>
      session.terminal?.terminalId === agentId ||
      session.thread?.threadId === agentId ||
      session.threads?.some((thread) => thread.threadId === agentId),
  );
}

export type MemberView = HuddleAgentInfo & { display: string };

/**
 * Who each member is, by agent id. Project names are added to labels only when the members come
 * from more than one project, since the same project on every chip says nothing.
 */
export function memberViews(
  projection: RuntimeProjection,
  huddle: Pick<HuddleProjection, "members">,
): Map<string, MemberView> {
  const infos = huddle.members
    .map((member) => huddleAgentInfo(projection, member.agentId))
    .filter((info): info is HuddleAgentInfo => info !== undefined);
  const projects = new Set(infos.map((info) => info.projectName ?? ""));
  const mixed = projects.size > 1;
  return new Map(
    infos.map((info) => [
      info.agentId,
      { ...info, display: mixed && info.projectName ? `${info.label} (${info.projectName})` : info.label },
    ]),
  );
}

export function agentDisplay(
  projection: RuntimeProjection,
  views: ReadonlyMap<string, MemberView>,
  agentId: string,
): string {
  return views.get(agentId)?.display ?? huddleAgentInfo(projection, agentId)?.label ?? "A removed agent";
}

export function recipientsText(to: HuddleTarget, name: (agentId: string) => string): string {
  if (to === "everyone") return "to everyone";
  if (to === "person") return "to you";
  return `to ${to.map(name).join(", ")}`;
}

const deliveryWords: Partial<Record<HuddleDelivery["status"], string>> = {
  pending: "not sent yet",
  held: "held",
  queued: "queued",
  failed: "not delivered",
};

/**
 * One line per recipient whose copy has not simply arrived, such as "Coder: Held while ...", and one
 * line for every recipient it started no turn for.
 */
export function deliveryNotes(post: HuddlePost, name: (agentId: string) => string): string[] {
  const unread = post.deliveries
    .filter((delivery) => delivery.status === "inbox" && !delivery.reason)
    .map((delivery) => name(delivery.agentId));
  const quiet =
    unread.length > 0 ? [`No turn started for ${unread.join(", ")}. They see it when they next read the huddle.`] : [];
  return post.deliveries
    .flatMap((delivery) => {
      if (delivery.status === "inbox") return delivery.reason ? [`${name(delivery.agentId)}: ${delivery.reason}`] : [];
      // A held copy's reason is a whole sentence that already says it is held.
      if (delivery.status === "held" && delivery.reason) return [`${name(delivery.agentId)}: ${delivery.reason}`];
      const word = deliveryWords[delivery.status];
      if (word) return [`${name(delivery.agentId)}: ${word}${delivery.reason ? `. ${delivery.reason}` : "."}`];
      if (delivery.awaitingReply) return [`${name(delivery.agentId)}: has it, answer not posted yet.`];
      return [];
    })
    .concat(quiet);
}

/** Messages in an agent's inbox in one huddle: they started no turn, and it has not read them yet. */
export function unreadCount(posts: readonly HuddlePost[], agentId: string): number {
  return posts.filter((post) =>
    post.deliveries.some((delivery) => delivery.agentId === agentId && delivery.status === "inbox"),
  ).length;
}

/** Messages held for an agent in one huddle. */
export function heldCount(posts: readonly HuddlePost[], agentId: string): number {
  return posts.filter((post) =>
    post.deliveries.some((delivery) => delivery.agentId === agentId && delivery.status === "held"),
  ).length;
}

/** Messages, across every huddle, waiting for the person to stop typing in this terminal. */
export function typingHeldCount(projection: Pick<RuntimeProjection, "huddlePosts">, agentId: string): number {
  return (projection.huddlePosts ?? []).filter((post) =>
    post.deliveries.some(
      (delivery) =>
        delivery.agentId === agentId && delivery.status === "held" && delivery.reason === HUDDLE_TYPING_REASON,
    ),
  ).length;
}

/** A huddle name that fits the 60 character limit. */
export function fitHuddleName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 59).trimEnd()}…` : trimmed;
}

export function shortText(text: string, length = 80): string {
  const line = text.trim().split(/\r?\n/u)[0] ?? "";
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}
