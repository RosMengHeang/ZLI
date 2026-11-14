import type { ThreadActivityProjection, ThreadTurnProjection } from "@zli-v2/contracts";

import type { TimelineItem } from "../sessions/sessions.js";
import { splitAttachedFiles } from "./attachedFiles.js";
import { durationLabel, stepDuration } from "./Thought.js";
import { baseName, exploreCounts } from "./WorkLog.js";

/** One row of the conversation: a timeline item, or an earlier turn's working-out folded into one line. */
export type ChatRow =
  | { kind: "item"; index: number }
  | { kind: "fold"; key: string; indexes: number[]; activities: ThreadActivityProjection[] };

export type ChatTurns = {
  rows: ChatRow[];
  /** The whole reply of each turn, keyed by the timeline index of its last part, which carries Copy. */
  replies: Map<number, string>;
  /** The messages the person sent, in order, for jumping around a long chat, each with the start of its reply. */
  prompts: { id: string; text: string; reply?: string }[];
  /** Where the latest turn starts in the timeline. */
  latestStart: number;
};

const isUser = (item: TimelineItem) => item.kind === "message" && item.message.role === "user";
const isReply = (item: TimelineItem) => item.kind === "message" && item.message.role === "assistant";

/**
 * Splits the timeline into turns at each message the person sent. In every turn but the latest,
 * the steps and the remarks between them fold into one row, so what stays in view is the question
 * and the answer. The latest turn stays open: it is the one being read or still running.
 */
export function groupTurns(timeline: readonly TimelineItem[]): ChatTurns {
  const rows: ChatRow[] = [];
  const replies = new Map<number, string>();
  const prompts: ChatTurns["prompts"] = [];
  const starts: number[] = [];
  timeline.forEach((item, index) => {
    if (index === 0 || isUser(item)) starts.push(index);
    if (item.kind === "message" && item.message.role === "user") {
      const text = splitAttachedFiles(item.message.text).text.trim();
      if (text) prompts.push({ id: item.message.messageId, text });
    }
  });
  starts.forEach((start, turn) => {
    const end = starts[turn + 1] ?? timeline.length;
    const latest = turn === starts.length - 1;
    const first = timeline[start];
    const bodyStart = first && isUser(first) ? start + 1 : start;
    if (bodyStart > start) rows.push({ kind: "item", index: start });

    let lastWork = -1;
    let lastReply = -1;
    const others: number[] = [];
    const parts: string[] = [];
    for (let index = bodyStart; index < end; index += 1) {
      const item = timeline[index];
      if (!item) continue;
      if (item.kind === "work") lastWork = index;
      else if (isReply(item)) {
        lastReply = index;
        parts.push(item.message.text.trim());
      } else others.push(index);
    }
    if (first && isUser(first) && first.kind === "message" && parts.length > 0) {
      const prompt = prompts.find((entry) => entry.id === first.message.messageId);
      if (prompt) prompt.reply = parts.join("\n\n").slice(0, 600);
    }
    const foldable = !others.some((index) => index < lastWork);
    if (lastReply > lastWork && parts.length > 0) replies.set(lastReply, parts.join("\n\n"));

    // A note from another agent or the system in the middle of the steps keeps the turn open, so it is never hidden.
    const foldEnd = !latest && foldable && lastWork >= bodyStart ? lastWork : -1;
    if (foldEnd >= 0) {
      const indexes: number[] = [];
      const activities: ThreadActivityProjection[] = [];
      for (let index = bodyStart; index <= foldEnd; index += 1) {
        const item = timeline[index];
        if (!item) continue;
        indexes.push(index);
        if (item.kind === "work") activities.push(...item.activities);
      }
      const firstWork = timeline.slice(bodyStart, foldEnd + 1).find((item) => item.kind === "work");
      rows.push({
        kind: "fold",
        key: `fold-${firstWork?.kind === "work" ? firstWork.key : start.toString()}`,
        indexes,
        activities,
      });
    }
    for (let index = Math.max(bodyStart, foldEnd + 1); index < end; index += 1) rows.push({ kind: "item", index });
  });
  return { rows, replies, prompts, latestStart: starts.at(-1) ?? 0 };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** A folded turn in a few words: "Explored 3 files · Edited routes.ts · Ran 2 commands". */
export function trailSummary(all: readonly ThreadActivityProjection[]): string {
  // Thinking is not something the agent did to the project, so it only names a turn that did nothing else.
  const activities = all.filter((entry) => entry.kind !== "reasoning");
  if (activities.length === 0 && all.length > 0) return "Thought";
  const explored = activities.filter(
    (entry) => entry.kind === "file-read" || entry.kind === "search" || entry.kind === "web",
  );
  const edited = new Set<string>();
  let unnamedEdits = 0;
  let commands = 0;
  let tools = 0;
  let failed = 0;
  for (const entry of activities) {
    if (entry.status === "failed") failed += 1;
    if (entry.kind === "file-edit") {
      if (entry.files?.length) for (const file of entry.files) edited.add(file);
      else unnamedEdits += 1;
    } else if (entry.kind === "command") commands += 1;
    else if (entry.kind === "tool") tools += 1;
  }
  const parts: string[] = [];
  if (explored.length > 0) parts.push(`Explored ${exploreCounts(explored)}`);
  const edits = edited.size + unnamedEdits;
  const [onlyFile] = edited;
  if (edits === 1 && onlyFile) parts.push(`Edited ${baseName(onlyFile)}`);
  else if (edits > 0) parts.push(`Edited ${plural(edits, "file", "files")}`);
  if (commands > 0) parts.push(`Ran ${plural(commands, "command", "commands")}`);
  if (tools > 0) parts.push(`Used ${plural(tools, "tool", "tools")}`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ") || plural(activities.length, "step", "steps");
}

/** "Worked for 1m 05s", for a turn that has ended and took at least a second. */
export function workedFor(turn: ThreadTurnProjection | undefined): string | undefined {
  const label = turn ? durationLabel(stepDuration(turn)) : undefined;
  return label ? `Worked for ${label}` : undefined;
}

/** The first line of a message, for the list of messages to jump to. */
export function promptLabel(text: string): string {
  const line = text
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? "";
}
