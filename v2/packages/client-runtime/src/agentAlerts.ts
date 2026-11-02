import type {
  ProviderDiscovery,
  RuntimeProjection,
  ThreadMessageProjection,
  ThreadProjection,
  ThreadRequestProjection,
} from "@zli-v2/contracts";

import { describeApproval, describeQuestions } from "./requestView.js";

/**
 * The phone's agent alerts. The phone shows them as local notifications while it is connected, and
 * the desktop sends the same ones as push notifications while it is not, so both read the same.
 */

export type AgentAlertKind = "approval" | "question" | "finished" | "failed" | "stopped";

export type AgentAlert = {
  /** One notification per request, and one per agent for status changes, so a newer one replaces the older. */
  key: string;
  kind: AgentAlertKind;
  threadId: string;
  /** The agent's name. */
  title: string;
  /** What happened, in a few words, shown beside the name. */
  state: string;
  body: string;
};

const BODY_LIMIT = 180;

export function providerName(provider: string, providers: readonly ProviderDiscovery[] | undefined): string {
  return providers?.find((entry) => entry.provider === provider)?.displayName ?? provider;
}

/** The name the person gave the agent, or its provider's name, as the desktop shows it. */
export function agentTitle(
  thread: Pick<ThreadProjection, "name" | "provider">,
  providers: readonly ProviderDiscovery[] | undefined,
): string {
  return thread.name?.trim() || providerName(thread.provider, providers);
}

export function threadMessages(projection: RuntimeProjection, threadId: string): ThreadMessageProjection[] {
  return (projection.messages ?? []).filter(
    (message) => message.threadId === threadId && (message.text.trim() || message.attachments?.length),
  );
}

export function requestAlertKey(requestId: string): string {
  return `request:${requestId}`;
}

export function threadAlertKey(threadId: string): string {
  return `thread:${threadId}`;
}

/** Approvals, questions, and failures play a sound; finished and stopped agents arrive quietly. */
export function isUrgentAlert(alert: Pick<AgentAlert, "kind">): boolean {
  return alert.kind === "approval" || alert.kind === "question" || alert.kind === "failed";
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > BODY_LIMIT ? `${line.slice(0, BODY_LIMIT - 1)}…` : line;
}

export function branchLine(projection: RuntimeProjection, thread: ThreadProjection): string {
  const branch = projection.worktrees.find((worktree) => worktree.worktreeId === thread.worktreeId)?.branch;
  return branch ? `On ${branch}` : "Open it to see what happened.";
}

export function lastReply(projection: RuntimeProjection, thread: ThreadProjection): string | undefined {
  const reply = threadMessages(projection, thread.threadId)
    .filter((message) => message.role === "assistant" && message.text.trim())
    .at(-1);
  return reply ? oneLine(reply.text) : undefined;
}

/** What an agent asks for, as a short state and one line, for notifications, the live status, and Home. */
export function describeRequest(
  thread: Pick<ThreadProjection, "provider">,
  request: ThreadRequestProjection,
): { kind: "approval" | "question"; state: string; body: string } {
  if (request.kind === "approval") {
    const view = describeApproval(thread.provider, request.payload);
    const field = view.fields[0];
    return {
      kind: "approval",
      state: "Asks to continue",
      body: oneLine(field ? `${view.title}: ${field.value}` : view.title),
    };
  }
  const questions = describeQuestions(request.payload);
  const first = questions[0]?.question ?? "The agent needs an answer";
  return {
    kind: "question",
    state: "Has a question",
    body: oneLine(questions.length > 1 ? `${first} (${questions.length} questions)` : first),
  };
}

function requestAlert(
  projection: RuntimeProjection,
  thread: ThreadProjection,
  request: ThreadRequestProjection,
): AgentAlert {
  return {
    key: requestAlertKey(request.requestId),
    threadId: thread.threadId,
    title: agentTitle(thread, projection.providers),
    ...describeRequest(thread, request),
  };
}

function statusAlert(
  projection: RuntimeProjection,
  before: ThreadProjection,
  thread: ThreadProjection,
): AgentAlert | undefined {
  if (before.status === thread.status) return undefined;
  const base = {
    key: threadAlertKey(thread.threadId),
    threadId: thread.threadId,
    title: agentTitle(thread, projection.providers),
  };
  if (thread.status === "failed") {
    return {
      ...base,
      kind: "failed",
      state: "Failed",
      body: thread.errorMessage ? oneLine(thread.errorMessage) : branchLine(projection, thread),
    };
  }
  if (thread.status === "stopped" && before.status !== "failed") {
    return { ...base, kind: "stopped", state: "Stopped", body: branchLine(projection, thread) };
  }
  const asking = (projection.requests ?? []).some((request) => request.threadId === thread.threadId);
  if (before.status === "working" && thread.status === "idle" && !asking) {
    return {
      ...base,
      kind: "finished",
      state: "Finished",
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
