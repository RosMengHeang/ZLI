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
  worktreeId: string;
  /** The branch of the agent's worktree, the name the sidebar shows for it. */
  branch: string;
} & ({ mode: "chat"; threadId: string } | { mode: "terminal"; terminalId: string });

/** The agents of one worktree, in the order the send menu and dialog list them. */
export type SendTargetGroup = { worktreeId: string; branch: string; targets: SendTarget[] };

/**
 * Lets a message go to agents in the project's other worktrees too. Their checkout can differ from the one
 * the message is about, so they get a line saying where it came from.
 */
export type OtherWorktrees = {
  /** Put before the message for an agent in another worktree. */
  context(target: SendTarget): string;
  /** Shown in the dialog while an agent in another worktree is picked. */
  note(target: SendTarget): string;
};

const LAST_TARGET_KEY = "zli.sendTarget.v1";
const MAX_REMEMBERED = 50;
/** A worktree on its way out takes no new work. */
const REMOVED = new Set(["cancelling", "cancelled"]);

/**
 * Agents that can take a message now: the worktree's own, the most recently active first. With otherWorktrees,
 * the agents in the rest of the project follow, grouped by worktree in the order the sidebar lists them.
 */
export function sendTargets(
  projection: RuntimeProjection,
  worktreeId: string,
  { otherWorktrees = false }: { otherWorktrees?: boolean } = {},
): SendTarget[] {
  const here = projection.worktrees.find((worktree) => worktree.worktreeId === worktreeId);
  const order = new Map<string, { rank: number; branch: string }>();
  order.set(worktreeId, { rank: 0, branch: here?.branch ?? "" });
  if (otherWorktrees && here)
    projection.worktrees.forEach((worktree, index) => {
      if (worktree.worktreeId === worktreeId || worktree.projectId !== here.projectId) return;
      if (REMOVED.has(worktree.status)) return;
      order.set(worktree.worktreeId, { rank: index + 1, branch: worktree.branch });
    });
  const targets: Array<SendTarget & { rank: number }> = [];
  for (const session of deriveSessions(projection)) {
    const place = order.get(session.worktreeId);
    if (!place) continue;
    const title = sessionTitle(session, projection.messages, projection.providers);
    const name = providerDisplayName(session.provider, projection.providers);
    const status = sessionStatusLabel[session.status];
    const shared = { sessionId: session.sessionId, agent: name, title, worktreeId: session.worktreeId, ...place };
    const { thread, terminal } = session;
    if (thread && (thread.status === "idle" || thread.status === "working" || thread.status === "waiting")) {
      targets.push({
        ...shared,
        key: `${session.sessionId}:chat`,
        mode: "chat",
        threadId: thread.threadId,
        detail: `${name} chat · ${status}`,
        updatedAt: thread.updatedAt ?? thread.createdAt ?? "",
      });
    }
    if (terminal?.status === "running") {
      targets.push({
        ...shared,
        key: `${session.sessionId}:terminal`,
        mode: "terminal",
        terminalId: terminal.terminalId,
        detail: `${name} terminal · ${status}`,
        updatedAt: terminal.updatedAt ?? terminal.createdAt ?? "",
      });
    }
  }
  return targets
    .sort(
      (left, right) =>
        left.rank - right.rank || (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0),
    )
    .map(({ rank: _rank, ...target }) => target as SendTarget);
}

/** Splits targets listed by sendTargets into their worktrees, keeping the order. */
export function sendTargetGroups(targets: readonly SendTarget[]): SendTargetGroup[] {
  const groups: SendTargetGroup[] = [];
  for (const target of targets) {
    const last = groups.at(-1);
    if (last?.worktreeId === target.worktreeId) last.targets.push(target);
    else groups.push({ worktreeId: target.worktreeId, branch: target.branch, targets: [target] });
  }
  return groups;
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

/**
 * The agent a send can go to without asking: the one the worktree's last message went to while it still takes
 * messages, wherever it works, or else the only one in the worktree. An agent in another worktree is never
 * picked just because it is the only one running.
 */
export function defaultSendTarget(
  targets: readonly SendTarget[],
  lastKey: string | undefined,
  worktreeId: string,
): SendTarget | undefined {
  const remembered = targets.find((target) => target.key === lastKey);
  if (remembered) return remembered;
  const here = targets.filter((target) => target.worktreeId === worktreeId);
  return here.length === 1 ? here[0] : undefined;
}

/** The message as the target receives it, with where it came from when the agent works in another worktree. */
export function messageForTarget(
  message: string,
  target: SendTarget | undefined,
  worktreeId: string,
  otherWorktrees: OtherWorktrees | undefined,
): string {
  if (!target || !otherWorktrees || target.worktreeId === worktreeId) return message;
  return `${otherWorktrees.context(target)}\n\n${message}`;
}

/** Queues the message in the agent's chat, or pastes it at its terminal prompt without pressing Enter. */
export async function deliverToAgent({
  dispatch,
  target,
  message,
  attachments = [],
  worktreeId,
  onShowAgent,
}: {
  dispatch: Dispatch;
  target: SendTarget;
  message: string;
  attachments?: readonly SendAttachment[] | undefined;
  /** The worktree the message is sent from. */
  worktreeId?: string | undefined;
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
      if (worktreeId === undefined || target.worktreeId === worktreeId) {
        // Showing the terminal mounts its view, which knows whether the program reads bracketed paste.
        onShowAgent?.(target.sessionId, "terminal");
        bracketed = await readBracketedPaste(target.terminalId);
      } else {
        // Showing an agent in another worktree would move the app there in the middle of the send. Agent CLIs
        // read bracketed paste, which messages between agents rely on as well.
        bracketed = true;
      }
    }
    command = { type: "terminal.write", terminalId: target.terminalId, data: terminalPaste(message, !!bracketed) };
  }
  const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
  if (response?.accepted === false) throw new Error(response.error.message);
}

/** The confirmation shown after a message went out without the dialog. */
export function sentNotice(
  target: SendTarget,
  attachments: readonly SendAttachment[] = [],
  worktreeId: string = target.worktreeId,
): string {
  const agent = target.worktreeId === worktreeId ? target.agent : `${target.agent} on ${target.branch}`;
  if (target.mode === "chat") return `Sent to ${agent}.`;
  return attachments.length > 0
    ? `Pasted in ${agent} without the images. Press Enter there to send it.`
    : `Pasted in ${agent}. Press Enter there to send it.`;
}
