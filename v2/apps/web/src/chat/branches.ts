/**
 * Chats branched from another chat: the conversation up to the reply it branched at, which goes along with the
 * new chat's first message, and the title of the chat it came from. Kept on this machine until that message goes.
 */
const STORAGE_KEY = "zli.chat.branches";

export type ChatBranch = { from: string; context: string };

function read(): Record<string, ChatBranch> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, ChatBranch> = {};
    for (const [id, value] of Object.entries(raw)) {
      const entry = value as Partial<ChatBranch> | null;
      if (entry && typeof entry.from === "string" && typeof entry.context === "string") {
        out[id] = { from: entry.from, context: entry.context };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function write(next: Record<string, ChatBranch>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable; the branch then starts without the earlier conversation.
  }
}

export function saveChatBranch(sessionId: string, branch: ChatBranch): void {
  write({ ...read(), [sessionId]: branch });
}

export function chatBranch(sessionId: string): ChatBranch | undefined {
  if (typeof window === "undefined") return undefined;
  return read()[sessionId];
}

/** The branch's context, once: the first message takes it along and the chat no longer needs it. */
export function takeChatBranch(sessionId: string): ChatBranch | undefined {
  const all = read();
  const branch = all[sessionId];
  if (!branch) return undefined;
  delete all[sessionId];
  write(all);
  return branch;
}
