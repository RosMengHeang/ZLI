import type { TerminalProjection, ThreadMessageProjection, ThreadProjection } from "@zli-v2/contracts";

import { handoffTranscript, TAKEOVER_CHAR_BUDGET } from "../sessions/handoff.js";
import type { TimelineItem } from "../sessions/sessions.js";

/**
 * A chat is a room: its own agent, the agents the person brought in (guests), and the helpers its agents
 * started on their own. Guests talk in the chat; helpers work beside it and show as cards.
 */
export type RoomHelper =
  | { kind: "chat"; id: string; thread: ThreadProjection }
  | { kind: "terminal"; id: string; terminal: TerminalProjection };

export function roomGuests(chainIds: ReadonlySet<string>, threads: readonly ThreadProjection[]): ThreadProjection[] {
  return threads.filter((thread) => thread.joins !== undefined && chainIds.has(thread.joins));
}

export function roomHelpers(
  memberIds: ReadonlySet<string>,
  threads: readonly ThreadProjection[],
  terminals: readonly TerminalProjection[],
): RoomHelper[] {
  const helpers: RoomHelper[] = [];
  for (const thread of threads) {
    if (thread.joins !== undefined || !thread.startedBy || !memberIds.has(thread.startedBy)) continue;
    if (memberIds.has(thread.threadId)) continue;
    helpers.push({ kind: "chat", id: thread.threadId, thread });
  }
  for (const terminal of terminals) {
    if (!terminal.agent || !terminal.startedBy || !memberIds.has(terminal.startedBy)) continue;
    helpers.push({ kind: "terminal", id: terminal.terminalId, terminal });
  }
  return helpers;
}

/**
 * Puts the guests' messages into the chat's own timeline, in the order they were written. Each one goes in
 * before the first message of the chat's own agent written after it.
 */
export function mergeRoomTimeline(
  own: readonly TimelineItem[],
  guestMessages: readonly ThreadMessageProjection[],
  order: ReadonlyMap<string, number>,
): TimelineItem[] {
  if (guestMessages.length === 0) return [...own];
  const merged: TimelineItem[] = [];
  let next = 0;
  const placeOf = (message: ThreadMessageProjection) => order.get(message.messageId) ?? Number.MAX_SAFE_INTEGER;
  for (const item of own) {
    if (item.kind === "message") {
      const at = order.get(item.message.messageId);
      if (at !== undefined) {
        while (next < guestMessages.length && placeOf(guestMessages[next] as ThreadMessageProjection) < at) {
          merged.push({ kind: "message", message: guestMessages[next] as ThreadMessageProjection });
          next += 1;
        }
      }
    }
    merged.push(item);
  }
  for (; next < guestMessages.length; next += 1) {
    merged.push({ kind: "message", message: guestMessages[next] as ThreadMessageProjection });
  }
  return merged;
}

/** Messages that count as conversation: what the person and the agents said, not notes or notices. */
function said(message: ThreadMessageProjection): boolean {
  return (message.role === "user" || message.role === "assistant") && message.text.trim().length > 0;
}

/**
 * What one member of the chat missed: everything the others said after the member's own last message.
 * `messages` is the whole room, oldest first.
 */
export function missedBy(
  memberIds: ReadonlySet<string>,
  messages: readonly ThreadMessageProjection[],
): ThreadMessageProjection[] {
  let lastOwn = -1;
  messages.forEach((message, index) => {
    if (memberIds.has(message.threadId)) lastOwn = index;
  });
  return messages.slice(lastOwn + 1).filter((message) => !memberIds.has(message.threadId) && said(message));
}

/**
 * What a member reads ahead of the person's message: who it is and who else is in the chat the first time,
 * then whatever the others said since it last spoke. Undefined when it missed nothing.
 */
export function roomBrief(input: {
  name: string;
  /** The first time this member hears from the person in this chat. */
  joining: boolean;
  others: readonly string[];
  branch: string;
  missed: readonly ThreadMessageProjection[];
  nameOf(message: ThreadMessageProjection): string;
  instructions?: string | undefined;
}): string | undefined {
  const transcript = handoffTranscript(input.missed, input.nameOf, TAKEOVER_CHAR_BUDGET);
  const company = input.others.length > 0 ? ` with ${listNames(input.others)}` : "";
  const parts: string[] = [];
  if (input.joining) {
    parts.push(
      `You are ${input.name}. The person brought you into a shared chat${company}, in the same folder, on branch ${input.branch}. Everyone in it sees what you write. Reply to the person; when you want another member to do something, name them with @Name in your reply.`,
    );
    if (input.instructions) parts.push(`Your standing instructions:\n\n${input.instructions}`);
  }
  if (transcript.included > 0) {
    parts.push(
      input.joining
        ? `The conversation so far, oldest first. Files may have changed since, so check them before you rely on it.\n\n<chat-so-far>\n${transcript.text}\n</chat-so-far>`
        : `Since your last reply, this was said in the chat${company}:\n\n<chat-since>\n${transcript.text}\n</chat-since>`,
    );
  }
  if (parts.length === 0) return undefined;
  parts.push("The person's new message:");
  return parts.join("\n\n");
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// The step a member is on lives with the rest of the live status, so every place that shows it agrees.
export { runningStep } from "./liveStatus.js";
