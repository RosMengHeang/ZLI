import type { AttachmentMimeType, RuntimeProjection } from "@zli-v2/contracts";

import { providerDisplayName } from "../agent/providers.js";
import { makeCommandId } from "../runtime/commandId.js";
import { deriveSessions, type SessionMode, sessionStatusLabel, sessionTitle } from "../sessions/sessions.js";
import { readBracketedPaste } from "../terminal/terminalModes.js";
import type { Dispatch } from "./pullRequestClient.js";
import { terminalPaste } from "./reviewComments.js";

/** A file sent along with the message; only chat agents receive these. */
export type SendAttachment = { name: string; mimeType: AttachmentMimeType; dataBase64: string };

export type SendTarget = {
  key: string;
  sessionId: string;
  mode: SessionMode;
  /** The agent's name, such as Codex. */
  agent: string;
  title: string;
  detail: string;
  updatedAt: string;
} & ({ mode: "chat"; threadId: string } | { mode: "terminal"; terminalId: string });

const LAST_TARGET_KEY = "zli.sendTarget.v1";
const MAX_REMEMBERED = 50;

/** Agents in the worktree that can take a message now, the most recently active first. */
export function sendTargets(projection: RuntimeProjection, worktreeId: string): SendTarget[] {
  const targets: SendTarget[] = [];
  for (const session of deriveSessions(projection)) {
    if (session.worktreeId !== worktreeId) continue;
    const title = sessionTitle(session, projection.messages, projection.providers);
    const name = providerDisplayName(session.provider, projection.providers);
    const status = sessionStatusLabel[session.status];
    const { thread, terminal } = session;
    if (thread && (thread.status === "idle" || thread.status === "working" || thread.status === "waiting")) {
      targets.push({
        key: `${session.sessionId}:chat`,
        sessionId: session.sessionId,
        mode: "chat",
        threadId: thread.threadId,
        agent: name,
        title,
        detail: `${name} chat · ${status}`,
        updatedAt: thread.updatedAt ?? thread.createdAt ?? "",
      });
    }
    if (terminal?.status === "running") {
      targets.push({
        key: `${session.sessionId}:terminal`,
        sessionId: session.sessionId,
        mode: "terminal",
        terminalId: terminal.terminalId,
        agent: name,
        title,
        detail: `${name} terminal · ${status}`,
        updatedAt: terminal.updatedAt ?? terminal.createdAt ?? "",
      });
    }
  }
  return targets.sort((left, right) =>
    left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0,
  );
}

function readLastTargets(): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(LAST_TARGET_KEY) ?? "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** The key of the agent the worktree's last message went to. */
export function lastSendTarget(worktreeId: string): string | undefined {
  return readLastTargets()[worktreeId];
}

export function rememberSendTarget(worktreeId: string, key: string): void {
  const { [worktreeId]: _previous, ...others } = readLastTargets();
  // Object keys keep insertion order, so the most recent worktrees are the last ones kept.
  const kept = Object.entries({ ...others, [worktreeId]: key }).slice(-MAX_REMEMBERED);
  try {
    window.localStorage.setItem(LAST_TARGET_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage can be unavailable; the next send asks for the agent again.
  }
}

/** The agent a send can go to without asking: the one used last while it still takes messages, or the only one. */
export function defaultSendTarget(targets: readonly SendTarget[], lastKey: string | undefined): SendTarget | undefined {
  return targets.find((target) => target.key === lastKey) ?? (targets.length === 1 ? targets[0] : undefined);
}

/** Queues the message in the agent's chat, or pastes it at its terminal prompt without pressing Enter. */
export async function deliverToAgent({
  dispatch,
  target,
  message,
  attachments = [],
  onShowAgent,
}: {
  dispatch: Dispatch;
  target: SendTarget;
  message: string;
  attachments?: readonly SendAttachment[] | undefined;
  onShowAgent?: ((sessionId: string, mode: SessionMode) => void) | undefined;
}): Promise<void> {
  let command: Record<string, unknown>;
  if (target.mode === "chat") {
    command = {
      type: "thread.queue",
      queueId: makeCommandId(),
      threadId: target.threadId,
      text: message,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  } else {
    let bracketed = await readBracketedPaste(target.terminalId, 0);
    if (bracketed === undefined) {
      // Showing the terminal mounts its view, which knows whether the program reads bracketed paste.
      onShowAgent?.(target.sessionId, "terminal");
      bracketed = await readBracketedPaste(target.terminalId);
    }
    command = { type: "terminal.write", terminalId: target.terminalId, data: terminalPaste(message, !!bracketed) };
  }
  const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
  if (response?.accepted === false) throw new Error(response.error.message);
}

/** The confirmation shown after a message went out without the dialog. */
export function sentNotice(target: SendTarget, attachments: readonly SendAttachment[] = []): string {
  if (target.mode === "chat") return `Sent to ${target.agent}.`;
  return attachments.length > 0
    ? `Pasted in ${target.agent} without the images. Press Enter there to send it.`
    : `Pasted in ${target.agent}. Press Enter there to send it.`;
}
