import {
  type HuddleAgentState,
  type HuddleMember,
  type HuddlePost,
  type HuddleProjection,
  huddleAgentInfo,
  huddleKindWantsAnswer,
  shortHuddleId,
} from "@zli-v2/contracts";

/** Earlier inbox messages a combined message carries in full; huddle_read has the rest. */
const MAX_CARRIED = 10;

/**
 * One queue entry per batch a chat gets, named by the batch's fingerprint, so the reactor can tell
 * its own messages in a chat's queue apart.
 */
export function huddleQueueId(huddleId: string, sentHash: string, agentId: string): string {
  return `huddle:${huddleId}:${sentHash}:${agentId}`;
}

/**
 * What a member gets for one huddle message: a heading that says who wrote to whom, the member list
 * the first time, and for terminal agents how to answer, since nothing they print reaches the huddle.
 * unread counts the other messages waiting in the member's inbox.
 */
export function huddleDeliveryText(
  state: HuddleAgentState,
  huddle: HuddleProjection,
  post: HuddlePost,
  member: HuddleMember,
  posts: readonly HuddlePost[],
  unread = 0,
): string {
  const short = shortHuddleId(huddle.huddleId);
  const lines = [`Huddle "${huddle.name}", ${postHeading(state, post, member, posts)}`, "", post.text];
  if (unread > 0)
    lines.push(
      "",
      `${unread === 1 ? "1 other message waits" : `${unread} other messages wait`} in your inbox: ${readHint(member, short)}.`,
    );
  if (!member.introduced) lines.push("", ...introduction(state, huddle, member));
  else if (member.kind === "terminal" && huddleKindWantsAnswer(post.kind))
    lines.push(
      "",
      `Answer with huddle_post, or: zli huddle post --huddle ${short} --reply-to ${post.number} "your answer".`,
    );
  return lines.join("\n");
}

/**
 * One message for a chat that has several waiting: the ones it has to act on, with the inbox
 * messages that arrived since it last read, oldest first, so it takes one turn for all of them.
 */
export function huddleBatchText(
  state: HuddleAgentState,
  huddle: HuddleProjection,
  member: HuddleMember,
  waking: readonly HuddlePost[],
  inbox: readonly HuddlePost[],
  posts: readonly HuddlePost[],
): string {
  const [only] = waking;
  if (only && waking.length === 1 && inbox.length === 0) return huddleDeliveryText(state, huddle, only, member, posts);
  const carried = inbox.slice(-MAX_CARRIED);
  const left = inbox.length - carried.length;
  const shown = [...waking, ...carried].sort((a, b) => a.number - b.number);
  const lines = [`Huddle "${huddle.name}": ${shown.length} new messages.`];
  for (const post of shown) lines.push("", capitalize(postHeading(state, post, member, posts)), post.text);
  if (left > 0)
    lines.push("", `${left} earlier messages are not shown: ${readHint(member, shortHuddleId(huddle.huddleId))}.`);
  if (!member.introduced) lines.push("", ...introduction(state, huddle, member));
  return lines.join("\n");
}

/**
 * A short line typed into a terminal agent in place of several full messages, so its CLI does not
 * queue a prompt for each one.
 */
export function huddleNudgeText(
  state: HuddleAgentState,
  huddle: HuddleProjection,
  member: HuddleMember,
  waiting: readonly HuddlePost[],
): string {
  const senders = [
    ...new Set(
      waiting.map((post) =>
        post.from.kind === "person" ? "the person" : agentLabel(state, post.from.agentId, member.agentId),
      ),
    ),
  ];
  const short = shortHuddleId(huddle.huddleId);
  const lines = [
    `Huddle "${huddle.name}": ${waiting.length} new messages for you, from ${senders.join(", ")}. When you reach a stopping point, run: zli huddle read --huddle ${short}`,
  ];
  if (!member.introduced) lines.push("", ...introduction(state, huddle, member));
  return lines.join("\n");
}

/** Such as `message 4, answering message 2: Ana asks you:`. */
function postHeading(state: HuddleAgentState, post: HuddlePost, member: HuddleMember, posts: readonly HuddlePost[]) {
  const sender =
    post.from.kind === "person" ? "the person running ZLI" : agentLabel(state, post.from.agentId, member.agentId);
  const audience = audienceFor(state, post, member.agentId);
  const action = {
    ask: `${sender} asks ${audience}`,
    assign: `${sender} gives ${audience} this task`,
    done: `${sender} tells ${audience} this is done`,
    blocked: `${sender} is blocked and needs a decision from ${audience}`,
    note: `${sender} writes to ${audience}`,
  }[post.kind];
  const answering = post.replyTo ? posts.find((candidate) => candidate.postId === post.replyTo) : undefined;
  return `message ${post.number}${answering ? `, answering message ${answering.number}` : ""}: ${capitalize(action)}:`;
}

function introduction(state: HuddleAgentState, huddle: HuddleProjection, member: HuddleMember): string[] {
  const short = shortHuddleId(huddle.huddleId);
  const members = huddle.members
    .map((other) => {
      const label = agentLabel(state, other.agentId, member.agentId);
      return other.agentId === member.agentId ? `${label} (you)` : `${label} (${other.kind})`;
    })
    .join(", ");
  const lead =
    huddle.lead === undefined
      ? ""
      : huddle.lead === member.agentId
        ? ` You lead it: the others report to you. Give each member its task with kind assign; you can post several tasks in a row. Their reports reach you together, once everyone you gave a task has reported.${
            member.kind === "chat"
              ? " Your answer to them is posted to the person."
              : ` Then report to the person: zli huddle post --huddle ${short} --to person --kind done "summary".`
          }`
        : ` ${agentLabel(state, huddle.lead, member.agentId)} leads it: your posts go to the lead unless you name someone else. When you finish a task from the lead, report with kind done, or blocked if you are stuck.`;
  const how =
    member.kind === "chat"
      ? "Your answer to an ask, a task, or a blocker is posted to the huddle for you. To write to the huddle yourself, use huddle_post; huddle_read shows what you missed and huddle_decisions what was agreed."
      : `Nothing you print reaches the huddle. Answer with the huddle_post tool, or run: zli huddle post --huddle ${short} "your answer". huddle_read shows what you missed and huddle_decisions what was agreed.`;
  return [
    `You are in the ZLI huddle "${huddle.name}" (huddle ${short}), a conversation between agents that the person running ZLI follows and steers. Members: ${members}.${lead}`,
    how,
    "Post when you finish (kind done), are stuck (blocked), or need an answer (ask), and put everything in one post. Do not post to acknowledge or thank. A note starts no turn for anyone; members see it when they next read the huddle.",
  ];
}

function readHint(member: HuddleMember, short: string): string {
  return member.kind === "chat" ? "huddle_read shows them" : `run zli huddle read --huddle ${short}`;
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
