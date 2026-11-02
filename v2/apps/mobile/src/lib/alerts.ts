import { describeApproval, describeQuestions } from "@zli-v2/client-runtime";
import type { RuntimeProjection, ThreadProjection, ThreadRequestProjection } from "@zli-v2/contracts";

import { agentTitle, threadMessages } from "./views.js";

export type AgentAlertKind = "approval" | "question" | "finished" | "failed" | "stopped";

export type AgentAlert = {
  /** One notification per request, and one per agent for status changes, so a newer one replaces the older. */
  key: string;
  kind: AgentAlertKind;
  threadId: string;
  title: string;
  body: string;
};

export type AlertContext = {
  /** Whether the app is on screen. */
  active: boolean;
  /** The agent whose conversation is open, if any. */
  openThreadId: string | undefined;
};

const BODY_LIMIT = 180;

export function requestAlertKey(requestId: string): string {
  return `request:${requestId}`;
}

export function threadAlertKey(threadId: string): string {
  return `thread:${threadId}`;
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > BODY_LIMIT ? `${line.slice(0, BODY_LIMIT - 1)}…` : line;
}

function branchLine(projection: RuntimeProjection, thread: ThreadProjection): string {
  const branch = projection.worktrees.find((worktree) => worktree.worktreeId === thread.worktreeId)?.branch;
  return branch ? `On ${branch}` : "Open it to see what happened.";
}

function lastReply(projection: RuntimeProjection, thread: ThreadProjection): string | undefined {
  const reply = threadMessages(projection, thread.threadId)
    .filter((message) => message.role === "assistant" && message.text.trim())
    .at(-1);
  return reply ? oneLine(reply.text) : undefined;
}

function requestAlert(
  projection: RuntimeProjection,
  thread: ThreadProjection,
  request: ThreadRequestProjection,
): AgentAlert {
  const name = agentTitle(thread, projection.providers);
  if (request.kind === "approval") {
    const view = describeApproval(thread.provider, request.payload);
    const field = view.fields[0];
    return {
      key: requestAlertKey(request.requestId),
      kind: "approval",
      threadId: thread.threadId,
      title: `${name} asks to continue`,
      body: oneLine(field ? `${view.title}: ${field.value}` : view.title),
    };
  }
  const questions = describeQuestions(request.payload);
  const first = questions[0]?.question ?? "The agent needs an answer";
  return {
    key: requestAlertKey(request.requestId),
    kind: "question",
    threadId: thread.threadId,
    title: `${name} has a question`,
    body: oneLine(questions.length > 1 ? `${first} (${questions.length} questions)` : first),
  };
}

function statusAlert(
  projection: RuntimeProjection,
  before: ThreadProjection,
  thread: ThreadProjection,
): AgentAlert | undefined {
  if (before.status === thread.status) return undefined;
  const name = agentTitle(thread, projection.providers);
  const base = { key: threadAlertKey(thread.threadId), threadId: thread.threadId };
  if (thread.status === "failed") {
    return {
      ...base,
      kind: "failed",
      title: `${name} failed`,
      body: thread.errorMessage ? oneLine(thread.errorMessage) : branchLine(projection, thread),
    };
  }
  if (thread.status === "stopped" && before.status !== "failed") {
    return { ...base, kind: "stopped", title: `${name} stopped`, body: branchLine(projection, thread) };
  }
  const asking = (projection.requests ?? []).some((request) => request.threadId === thread.threadId);
  if (before.status === "working" && thread.status === "idle" && !asking) {
    return {
      ...base,
      kind: "finished",
      title: `${name} finished`,
      body: lastReply(projection, thread) ?? branchLine(projection, thread),
    };
  }
  return undefined;
}

/**
 * What changed between two projections that the person would want to hear about. Without a previous
 * projection there is nothing to compare, so the first one after launch only sets the baseline.
 */
export function agentAlerts(previous: RuntimeProjection | undefined, next: RuntimeProjection): AgentAlert[] {
  if (!previous) return [];
  const alerts: AgentAlert[] = [];
  const known = new Set((previous.requests ?? []).map((request) => request.requestId));
  for (const request of next.requests ?? []) {
    if (known.has(request.requestId)) continue;
    const thread = next.threads.find((candidate) => candidate.threadId === request.threadId);
    if (thread) alerts.push(requestAlert(next, thread, request));
  }
  for (const thread of next.threads) {
    const before = previous.threads.find((candidate) => candidate.threadId === thread.threadId);
    const alert = before ? statusAlert(next, before, thread) : undefined;
    if (alert) alerts.push(alert);
  }
  return alerts;
}

/** Requests answered since the previous projection, on this phone or elsewhere, so their alerts can go. */
export function answeredAlertKeys(previous: RuntimeProjection | undefined, next: RuntimeProjection): string[] {
  if (!previous) return [];
  const open = new Set((next.requests ?? []).map((request) => request.requestId));
  return (previous.requests ?? [])
    .filter((request) => !open.has(request.requestId))
    .map((request) => requestAlertKey(request.requestId));
}

export function shouldShowAlert(alert: AgentAlert, context: AlertContext): boolean {
  if (!context.active) return true;
  if (alert.threadId === context.openThreadId) return false;
  // On screen, a stop is most often the person's own tap, and the list already shows it.
  return alert.kind !== "stopped";
}
