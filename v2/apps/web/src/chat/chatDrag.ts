import type { ThreadMessageProjection } from "@zli-v2/contracts";

/** The drag type of a chat dragged from the sidebar, which a message box takes as context. */
export const CHAT_DRAG_TYPE = "application/x-zli-chat";

const MAX_TRANSCRIPT = 40_000;

export type DraggedChat = { title: string; transcript: string };

/** The conversation as plain text, newest kept when it is long, for another chat to read. */
export function chatTranscript(title: string, messages: readonly ThreadMessageProjection[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = message.text.trim();
    if (!text) continue;
    lines.push(`## ${message.role === "user" ? "User" : "Agent"}\n\n${text}`);
  }
  let body = lines.join("\n\n");
  if (body.length > MAX_TRANSCRIPT) body = `(Earlier messages left out.)\n\n${body.slice(-MAX_TRANSCRIPT)}`;
  return `# Context from the chat "${title}"\n\n${body}`;
}

export function readDraggedChat(data: DataTransfer): DraggedChat | undefined {
  try {
    const value = JSON.parse(data.getData(CHAT_DRAG_TYPE)) as Partial<DraggedChat> | null;
    return value && typeof value.title === "string" && typeof value.transcript === "string"
      ? { title: value.title, transcript: value.transcript }
      : undefined;
  } catch {
    return undefined;
  }
}
