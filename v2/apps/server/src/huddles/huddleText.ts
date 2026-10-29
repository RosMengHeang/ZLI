import {
  type HuddleAgentState,
  type HuddleMember,
  type HuddlePost,
  type HuddleProjection,
  huddleAgentInfo,
  shortHuddleId,
} from "@zli-v2/contracts";

/** One queue entry per delivery, so the reactor can tell its own messages in a chat's queue apart. */
export function huddleQueueId(postId: string, agentId: string): string {
  return `huddle:${postId}:${agentId}`;
}

/**
 * What a member gets for one huddle message: a heading that says who wrote to whom, the member list
 * the first time, and for terminal agents how to answer, since nothing they print reaches the huddle.
 */
export function huddleDeliveryText(
  state: HuddleAgentState,
  huddle: HuddleProjection,
  post: HuddlePost,
  member: HuddleMember,
  posts: readonly HuddlePost[],
): string {
  const short = shortHuddleId(huddle.huddleId);
  const sender =
    post.from.kind === "person" ? "the person running ZLI" : agentLabel(state, post.from.agentId, member.agentId);
  const audience = audienceFor(state, post, member.agentId);
  const action =
    post.kind === "ask"
      ? `${sender} asks ${audience}`
      : post.kind === "assign"
        ? `${sender} gives ${audience} this task`
        : `${sender} writes to ${audience}`;
  const answering = post.replyTo ? posts.find((candidate) => candidate.postId === post.replyTo) : undefined;
  const heading = `Huddle "${huddle.name}", message ${post.number}${answering ? `, answering message ${answering.number}` : ""}: ${capitalize(action)}:`;
  const lines = [heading, "", post.text];
  if (!member.introduced) {
    const members = huddle.members
      .map((other) => {
        const label = agentLabel(state, other.agentId, member.agentId);
        return other.agentId === member.agentId ? `${label} (you)` : `${label} (${other.kind})`;
      })
      .join(", ");
    lines.push(
      "",
      `You are in the ZLI huddle "${huddle.name}" (huddle ${short}), a conversation between agents that the person running ZLI follows and steers. Members: ${members}.`,
      member.kind === "chat"
        ? "Your answer to an ask or a task is posted to the huddle for you. To write to the huddle yourself, use huddle_post; huddle_read shows what you missed and huddle_decisions what was agreed."
        : `Nothing you print reaches the huddle. Answer with the huddle_post tool, or run: zli huddle post --huddle ${short} "your answer". huddle_read shows what you missed and huddle_decisions what was agreed.`,
    );
  } else if (member.kind === "terminal" && post.kind !== "note") {
    lines.push("", `Answer with huddle_post, or: zli huddle post --huddle ${short} "your answer".`);
  }
  return lines.join("\n");
}

/** The agent's name, with its project when it works in another project than the reader. */
export function agentLabel(state: HuddleAgentState, agentId: string, readerId: string): string {
  const info = huddleAgentInfo(state, agentId);
  if (!info) return "an agent that has left";
  const reader = huddleAgentInfo(state, readerId);
  const elsewhere =
    info.projectId !== undefined && reader?.projectId !== undefined && info.projectId !== reader.projectId;
  return elsewhere && info.projectName ? `${info.label} (project ${info.projectName})` : info.label;
}

function audienceFor(state: HuddleAgentState, post: HuddlePost, readerId: string): string {
  if (post.to === "everyone") return "everyone";
  if (post.to === "person") return "the person";
  const others = post.to
    .filter((agentId) => agentId !== readerId)
    .map((agentId) => agentLabel(state, agentId, readerId));
  if (others.length === 0) return "you";
  return `you and ${others.join(", ")}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
