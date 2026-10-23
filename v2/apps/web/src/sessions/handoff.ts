import type { ThreadMessageProjection } from "@zli-v2/contracts";

import type { AgentSession } from "./sessions.js";

/** Older messages are dropped first; the newest ones carry what the next agent needs most. */
export const HANDOFF_CHAR_BUDGET = 60_000;
const MESSAGE_CHAR_LIMIT = 8_000;

export const HANDOFF_FILE_NAME = "handoff-conversation.md";

export type FirstMessageFile = { name: string; text: string };

export type HandoffMessage = {
  /** What the new agent receives as the message. */
  text: string;
  /** The earlier conversation, attached in a chat and pasted after the message in a terminal. */
  transcript: FirstMessageFile;
  /** Messages included in the transcript, and how many older ones did not fit. */
  included: number;
  omitted: number;
};

function trimMessage(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MESSAGE_CHAR_LIMIT) return trimmed;
  const half = Math.floor(MESSAGE_CHAR_LIMIT / 2);
  const cut = trimmed.length - half * 2;
  return `${trimmed.slice(0, half)}\n\n[${cut.toLocaleString("en-US")} characters left out]\n\n${trimmed.slice(-half)}`;
}

function speaker(message: ThreadMessageProjection, fromName: string): string | undefined {
  if (message.role === "user") return "User";
  if (message.role === "assistant") return fromName;
  if (message.role === "agent") return "Message from another agent";
  return undefined;
}

/** The conversation as Markdown sections, newest messages kept when it is over the budget. */
export function handoffTranscript(
  messages: readonly ThreadMessageProjection[],
  fromName: string,
  budget = HANDOFF_CHAR_BUDGET,
): { text: string; included: number; omitted: number } {
  const sections = messages.flatMap((message) => {
    const who = speaker(message, fromName);
    if (!who || (!message.text.trim() && !message.attachments?.length)) return [];
    const files = (message.attachments ?? []).map((file) => `- Attached: ${file.name} (${file.path})`);
    const body = [trimMessage(message.text), ...files].filter(Boolean).join("\n");
    return [`## ${who}\n\n${body}`];
  });
  const kept: string[] = [];
  let used = 0;
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index] ?? "";
    if (kept.length > 0 && used + section.length > budget) break;
    kept.unshift(section);
    used += section.length + 2;
  }
  const omitted = sections.length - kept.length;
  const head = omitted > 0 ? [`(${omitted} earlier ${omitted === 1 ? "message" : "messages"} left out)`] : [];
  return { text: [...head, ...kept].join("\n\n"), included: kept.length, omitted };
}

export function handoffMessage(input: {
  title: string;
  fromName: string;
  branch: string;
  messages: readonly ThreadMessageProjection[];
  note?: string | undefined;
}): HandoffMessage {
  const transcript = handoffTranscript(input.messages, input.fromName);
  const note = input.note?.trim();
  const text = [
    `Continue: ${input.title.replace(/^(Continue: )+/u, "")}`,
    `You are taking over this work from ${input.fromName} in the same folder, on branch ${input.branch}. Its changes are already on disk. The conversation so far is in ${HANDOFF_FILE_NAME}.`,
    note ||
      "Read the conversation, check the current state of the files, then carry on from where it stopped. Start by saying in a sentence or two what you will do next.",
  ].join("\n\n");
  return {
    text,
    transcript: {
      name: HANDOFF_FILE_NAME,
      text: `# Conversation with ${input.fromName}\n\n${transcript.text}\n`,
    },
    included: transcript.included,
    omitted: transcript.omitted,
  };
}

/** A chat with something said in it can be handed to another agent. */
export function canHandOff(
  session: Pick<AgentSession, "thread">,
  messages: readonly ThreadMessageProjection[] | undefined,
): boolean {
  const threadId = session.thread?.threadId;
  if (!threadId) return false;
  return (messages ?? []).some(
    (message) =>
      message.threadId === threadId && (message.role === "user" || message.role === "assistant") && message.text.trim(),
  );
}

/** A first message as typed into an agent CLI, which cannot take attachments. */
export function inlineFirstMessage(text: string, file: FirstMessageFile | undefined): string {
  return file ? `${text}\n\n${file.name}:\n\n${file.text.trim()}` : text;
}
