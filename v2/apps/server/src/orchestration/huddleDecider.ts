import {
  HUDDLE_PAUSED_REASON,
  type HuddleCommand,
  type HuddleMemberKind,
  type HuddleProjection,
  type HuddleSender,
  huddleAgentInfo,
  huddleKindWantsAnswer,
  huddlePostsOf,
  huddleRecipients,
  huddleWakes,
  MAX_HUDDLE_MEMBERS,
  type RuntimeProjection,
} from "@zli-v2/contracts";

import { type DomainDecision, DomainError } from "./decider.js";

export function decideHuddle(projection: RuntimeProjection, command: HuddleCommand): DomainDecision[] {
  switch (command.type) {
    case "huddle.create": {
      if ((projection.huddles ?? []).some((huddle) => huddle.huddleId === command.huddleId))
        throw new DomainError("huddle_exists", `Huddle already exists: ${command.huddleId}`);
      const ids = [...new Set(command.members ?? [])];
      return [
        {
          type: "huddle.created",
          huddleId: command.huddleId,
          name: command.name,
          members: ids.map((agentId) => ({ agentId, kind: memberKind(projection, agentId) })),
        },
      ];
    }
    case "huddle.rename": {
      const huddle = requireHuddle(projection, command.huddleId);
      if (huddle.name === command.name) return [];
      return [{ type: "huddle.renamed", huddleId: command.huddleId, name: command.name }];
    }
    case "huddle.archive": {
      const huddle = requireHuddle(projection, command.huddleId);
      if (huddle.archived) return [];
      return [{ type: "huddle.archived", huddleId: command.huddleId }];
    }
    case "huddle.join": {
      const huddle = requireOpenHuddle(projection, command.huddleId);
      if (huddle.members.some((member) => member.agentId === command.agentId)) return [];
      if (huddle.members.length >= MAX_HUDDLE_MEMBERS)
        throw new DomainError("unsupported_command", `A huddle holds up to ${MAX_HUDDLE_MEMBERS} agents.`);
      return [
        {
          type: "huddle.member.joined",
          huddleId: command.huddleId,
          member: { agentId: command.agentId, kind: memberKind(projection, command.agentId) },
        },
      ];
    }
    case "huddle.leave": {
      const huddle = requireHuddle(projection, command.huddleId);
      if (!huddle.members.some((member) => member.agentId === command.agentId)) return [];
      return [{ type: "huddle.member.left", huddleId: command.huddleId, agentId: command.agentId }];
    }
    case "huddle.post":
      return [decidePost(projection, command)];
    case "huddle.decide": {
      requireHuddle(projection, command.huddleId);
      const post = (projection.huddlePosts ?? []).find(
        (candidate) => candidate.postId === command.postId && candidate.huddleId === command.huddleId,
      );
      if (!post) throw new DomainError("huddle_missing", "That message is not in this huddle.");
      if ((post.decision === true) === command.decision) return [];
      return [
        {
          type: "huddle.decision.changed",
          huddleId: command.huddleId,
          postId: command.postId,
          decision: command.decision,
        },
      ];
    }
    case "huddle.resume": {
      const huddle = requireOpenHuddle(projection, command.huddleId);
      if (!huddle.paused && !huddle.agentTurns) return [];
      return [{ type: "huddle.resumed", huddleId: command.huddleId }];
    }
    case "huddle.lead": {
      const huddle = requireOpenHuddle(projection, command.huddleId);
      if (command.agentId !== undefined && !huddle.members.some((member) => member.agentId === command.agentId))
        throw new DomainError("huddle_member_missing", "Only a member of the huddle can lead it.");
      if (huddle.lead === command.agentId) return [];
      return [
        {
          type: "huddle.lead.changed",
          huddleId: command.huddleId,
          ...(command.agentId !== undefined ? { agentId: command.agentId } : {}),
        },
      ];
    }
    case "huddle.read": {
      const huddle = requireOpenHuddle(projection, command.huddleId);
      const member = huddle.members.find((candidate) => candidate.agentId === command.agentId);
      if (!member) throw new DomainError("huddle_member_missing", "Only members of the huddle can read it.");
      const upTo = Math.min(command.upTo, huddle.nextNumber - 1);
      const unread = huddlePostsOf(projection, huddle.huddleId).some(
        (post) =>
          post.number <= upTo &&
          post.deliveries.some((delivery) => delivery.agentId === command.agentId && delivery.status === "inbox"),
      );
      if (upTo <= (member.readUpTo ?? 0) && !unread && !member.typed) return [];
      return [{ type: "huddle.member.read", huddleId: command.huddleId, agentId: command.agentId, upTo }];
    }
    case "huddle.delivery": {
      const post = (projection.huddlePosts ?? []).find((candidate) => candidate.postId === command.postId);
      const delivery = post?.deliveries.find((candidate) => candidate.agentId === command.agentId);
      if (!post || !delivery) throw new DomainError("huddle_missing", "That delivery is not in the huddle.");
      return [{ ...command, type: "huddle.delivery.changed" }];
    }
    case "huddle.release":
      if (!projection.terminals.some((terminal) => terminal.terminalId === command.agentId))
        throw new DomainError("terminal_missing", `Terminal does not exist: ${command.agentId}`);
      return [{ type: "huddle.release.requested", agentId: command.agentId }];
  }
}

function decidePost(
  projection: RuntimeProjection,
  command: Extract<HuddleCommand, { type: "huddle.post" }>,
): Extract<DomainDecision, { type: "huddle.posted" }> {
  const huddle = requireOpenHuddle(projection, command.huddleId);
  const isMember = (agentId: string) => huddle.members.some((member) => member.agentId === agentId);
  if (command.from !== undefined && !isMember(command.from))
    throw new DomainError("huddle_member_missing", "Only members of the huddle can post there.");
  if (Array.isArray(command.to)) {
    const outside = command.to.filter((agentId) => !isMember(agentId));
    if (outside.length > 0)
      throw new DomainError(
        "huddle_member_missing",
        `Not in this huddle: ${outside.map((id) => label(projection, id)).join(", ")}.`,
      );
  }
  if ((projection.huddlePosts ?? []).some((post) => post.postId === command.postId))
    throw new DomainError("huddle_exists", `Huddle message id is already in use: ${command.postId}`);
  if (
    command.replyTo !== undefined &&
    !(projection.huddlePosts ?? []).some((post) => post.postId === command.replyTo && post.huddleId === huddle.huddleId)
  )
    throw new DomainError("huddle_missing", "The message this answers is not in the huddle.");
  const from: HuddleSender = command.from === undefined ? { kind: "person" } : { kind: "agent", agentId: command.from };
  const recipients = huddleRecipients(huddle, from, command.to);
  if (command.to !== "person" && recipients.length === 0)
    throw new DomainError(
      "huddle_member_missing",
      from.kind === "person" ? "Add an agent to the huddle first." : "Nobody else is in this huddle yet.",
    );
  const posts = huddlePostsOf(projection, huddle.huddleId);
  const sender = huddle.members.find((member) => member.agentId === command.from);
  const replied = command.replyTo ? posts.find((post) => post.postId === command.replyTo) : undefined;
  if (sender?.posted && !command.auto && !(replied && huddleKindWantsAnswer(replied.kind)))
    throw new DomainError(
      "huddle_posted",
      "You already posted since your last huddle message, so this was not posted. Wait until someone writes to you, and next time put everything into one post; it can name several members. Answers to an ask, a task, or a blocker are always allowed: pass the number you answer as replyTo (--reply-to in the CLI).",
    );
  // Agent messages past the limit wait, unseen by other agents, until the person writes or resumes.
  const held = from.kind === "agent" && huddle.paused === true;
  const draft = { from, to: command.to, kind: command.kind, ...(command.replyTo ? { replyTo: command.replyTo } : {}) };
  return {
    type: "huddle.posted",
    post: {
      postId: command.postId,
      huddleId: huddle.huddleId,
      number: huddle.nextNumber,
      from,
      to: command.to,
      kind: command.kind,
      text: command.text,
      ...(command.replyTo !== undefined ? { replyTo: command.replyTo } : {}),
      ...(command.auto ? { auto: true as const } : {}),
      ...(command.cut ? { cut: true as const } : {}),
      deliveries: recipients.map((agentId) =>
        !huddleWakes(huddle, posts, draft, agentId)
          ? { agentId, status: "inbox" as const }
          : held
            ? { agentId, status: "held" as const, reason: HUDDLE_PAUSED_REASON }
            : { agentId, status: "pending" as const },
      ),
    },
  };
}

function requireHuddle(projection: RuntimeProjection, huddleId: string): HuddleProjection {
  const huddle = (projection.huddles ?? []).find((candidate) => candidate.huddleId === huddleId);
  if (!huddle) throw new DomainError("huddle_missing", `Huddle does not exist: ${huddleId}`);
  return huddle;
}

function requireOpenHuddle(projection: RuntimeProjection, huddleId: string): HuddleProjection {
  const huddle = requireHuddle(projection, huddleId);
  if (huddle.archived) throw new DomainError("huddle_closed", `The huddle ${huddle.name} is archived.`);
  return huddle;
}

/** Only agents take part: a chat, or a terminal running an agent CLI. A plain shell has nobody to read. */
function memberKind(projection: RuntimeProjection, agentId: string): HuddleMemberKind {
  const thread = projection.threads.find((candidate) => candidate.threadId === agentId);
  if (thread) {
    if (thread.status === "failed" && !thread.providerSessionId)
      throw new DomainError("unsupported_command", "That agent failed, so it cannot join a huddle.");
    return "chat";
  }
  const terminal = projection.terminals.find((candidate) => candidate.terminalId === agentId);
  if (!terminal) throw new DomainError("agent_missing", `No agent has the id ${agentId}.`);
  if (!terminal.agent)
    throw new DomainError("unsupported_command", "Only agents can join a huddle. This terminal runs a plain shell.");
  if (terminal.status === "exited" || terminal.status === "failed")
    throw new DomainError("unsupported_command", "That terminal agent has exited, so it cannot join a huddle.");
  return "terminal";
}

function label(projection: RuntimeProjection, agentId: string): string {
  return huddleAgentInfo(projection, agentId)?.label ?? agentId;
}
