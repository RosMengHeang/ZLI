// Agent CLIs cannot rewind a conversation, so editing an older message sends the new version as a fresh
// message and the chat dims the turns it replaced instead of deleting them.

/** One edit of an older message: the message edited, and the last message the person had sent before it. */
export type ReplacedRange = { from: string; after: string };

type Item = { kind: "message"; message: { messageId: string; role: string } } | { kind: "work" };

/**
 * The timeline positions an edit replaced: from the edited message up to the edit itself, which is the first
 * message the person sent after `after`. Until the edit shows up, everything from the edited message on.
 */
export function replacedIndexes(timeline: readonly Item[], ranges: readonly ReplacedRange[]): Set<number> {
  const replaced = new Set<number>();
  const indexOf = (messageId: string) =>
    timeline.findIndex((item) => item.kind === "message" && item.message.messageId === messageId);
  for (const range of ranges) {
    const start = indexOf(range.from);
    const after = indexOf(range.after);
    if (start < 0 || after < start) continue;
    let end = timeline.length;
    for (let index = after + 1; index < timeline.length; index += 1) {
      const item = timeline[index];
      if (item?.kind === "message" && item.message.role === "user") {
        end = index;
        break;
      }
    }
    for (let index = start; index < end; index += 1) replaced.add(index);
  }
  return replaced;
}

/** What the agent reads with the new version of an older message. */
export function replaceNote(original: string): string {
  const lines = original.trim().split(/\r?\n/u);
  const line = lines[0]?.trim() ?? "";
  const quoted = line.length > 80 || lines.length > 1 ? `${line.slice(0, 80).trimEnd()}…` : line;
  return `Replace my earlier message '${quoted}' with this and redo from there; ignore what came after.`;
}

const STORE = "zli.chat.replaced.";

/** The edits a chat remembers, so the dimmed turns stay dimmed after a reload. */
export function loadReplaced(threadId: string): ReplacedRange[] {
  try {
    const raw = localStorage.getItem(STORE + threadId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (range): range is ReplacedRange => typeof range?.from === "string" && typeof range?.after === "string",
    );
  } catch {
    return [];
  }
}

export function saveReplaced(threadId: string, ranges: readonly ReplacedRange[]): void {
  try {
    localStorage.setItem(STORE + threadId, JSON.stringify(ranges));
  } catch {
    // Without storage the marks last until the chat closes.
  }
}
