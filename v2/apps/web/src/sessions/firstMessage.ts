import type { AgentSession } from "./sessions.js";

/** How long an agent CLI gets to draw its prompt before the first message is typed into it. */
export const TERMINAL_FIRST_MESSAGE_DELAY_MS = 3_000;

export type FirstMessageStep =
  | { kind: "wait" }
  | { kind: "drop" }
  | { kind: "chat"; threadId: string }
  | { kind: "terminal"; terminalId: string };

/** What to do with a first message that is waiting for its session's agent to be ready for input. */
export function firstMessageStep(session: AgentSession | undefined): FirstMessageStep {
  if (!session) return { kind: "wait" };
  if (session.pending?.errorMessage) return { kind: "drop" };
  const thread = session.thread;
  if (thread) {
    if (thread.status === "idle") return { kind: "chat", threadId: thread.threadId };
    if (thread.status === "stopped" || thread.status === "failed") return { kind: "drop" };
    return { kind: "wait" };
  }
  const terminal = session.terminal;
  if (terminal) {
    if (terminal.status === "running") return { kind: "terminal", terminalId: terminal.terminalId };
    if (terminal.status === "exited" || terminal.status === "failed") return { kind: "drop" };
  }
  return { kind: "wait" };
}

/**
 * Keystrokes that put a message into an agent CLI and submit it. Multi-line text goes in as one
 * bracketed paste so its newlines do not submit early.
 */
export function terminalFirstMessage(text: string): { body: string; submit: string } {
  return { body: /[\r\n]/u.test(text) ? `\u001b[200~${text}\u001b[201~` : text, submit: "\r" };
}
