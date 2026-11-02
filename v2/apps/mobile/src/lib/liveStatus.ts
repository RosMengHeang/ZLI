import { describeApproval, type RequestChoice } from "@zli-v2/client-runtime";
import type { RuntimeProjection, ThreadProjection, ThreadRequestProjection } from "@zli-v2/contracts";

import { branchLine, describeRequest, lastReply } from "./alerts.js";
import { agentTitle, currentActivity } from "./views.js";

/**
 * A button on the lock screen, in the Dynamic Island, or on the Android notification. The system hands
 * `target` back when it is pressed, possibly much later, so `liveCommand` checks it against the newest
 * projection before anything is sent.
 */
export type LiveAction = { target: string; label: string; kind: "approve" | "reject" | "stop" };

/** The one agent the live status features, and how many others are busy. */
export type LiveStatus = {
  threadId: string;
  needsYou: boolean;
  /** The agent's name alone, for layouts that show the state apart from it. */
  agent: string;
  title: string;
  detail: string;
  /** A word or two for the compact Dynamic Island and the Android status bar chip. */
  badge: string;
  /** The other agents that need you or are working, or nothing when the featured one is alone. */
  others: string | undefined;
  /** Agents that need you or are working, the featured one included. */
  count: number;
  actions: LiveAction[];
};

/** Where the live status shows outside the app. Each platform has its own; see `src/liveDisplay*.ts`. */
export type LiveDisplay = {
  /**
   * Shows the status or replaces the one shown. `background` means the app is off screen, where iOS
   * stops it soon, so the status should look out of date once that happens.
   */
  show(status: LiveStatus, options: { background: boolean }): Promise<void>;
  hide(): Promise<void>;
  /** Calls `listener` with the `target` of a pressed button. */
  onAction(listener: (target: string) => void): { remove(): void };
  /** Whether showing the status keeps the app running, so the connection can stay open in the background. */
  readonly keepsAppRunning: boolean;
};

const busyStatuses = new Set<ThreadProjection["status"]>(["starting", "working"]);

function newestFirst(left: ThreadProjection, right: ThreadProjection): number {
  return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
}

function refuses(choice: RequestChoice): boolean {
  const decision = choice.decision as { approved?: unknown; decision?: unknown } | undefined;
  return decision?.approved === false || decision?.decision === "decline";
}

/** Approve with the provider's main choice and reject with its plain refusal, when it offers one. */
function approvalChoices(thread: ThreadProjection, request: ThreadRequestProjection): RequestChoice[] {
  const choices = describeApproval(thread.provider, request.payload).choices;
  const approve = choices.find((choice) => choice.tone === "primary") ?? choices.find((choice) => !refuses(choice));
  const reject = choices.find(refuses);
  return [approve, reject].filter((choice): choice is RequestChoice => choice !== undefined);
}

function respondTarget(request: ThreadRequestProjection, choice: RequestChoice): string {
  return `respond/${encodeURIComponent(request.requestId)}/${encodeURIComponent(choice.key)}`;
}

function stopAction(thread: ThreadProjection): LiveAction {
  return { target: `stop/${encodeURIComponent(thread.threadId)}`, label: "Stop", kind: "stop" };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function othersLine(needYou: number, working: number): string | undefined {
  const parts = [
    needYou > 0 ? plural(needYou, "needs you", "need you") : undefined,
    working > 0 ? `${working} working` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? `Also ${parts.join(", ")}` : undefined;
}

/**
 * What the lock screen, the Dynamic Island, and the Android notification show while agents are busy:
 * the agent that needs you first, approvals before questions, else the busy agent that changed last.
 * Nothing when no agent needs you or is working.
 */
export function liveStatus(projection: RuntimeProjection | undefined): LiveStatus | undefined {
  if (!projection) return undefined;
  const requests = projection.requests ?? [];
  const asking = new Set(requests.map((request) => request.threadId));
  const live = projection.threads.filter((thread) => thread.status !== "stopped" && thread.status !== "failed");
  const needYou = live.filter((thread) => asking.has(thread.threadId) || thread.status === "waiting");
  const working = live.filter((thread) => !needYou.includes(thread) && busyStatuses.has(thread.status));
  const count = needYou.length + working.length;

  const byThread = (request: ThreadRequestProjection) => needYou.find((thread) => thread.threadId === request.threadId);
  const request =
    requests.find((candidate) => candidate.kind === "approval" && byThread(candidate)) ??
    requests.find((candidate) => byThread(candidate));
  const asked = request ? byThread(request) : undefined;
  if (request && asked) {
    const agent = agentTitle(asked, projection.providers);
    const described = describeRequest(agent, asked, request);
    const actions =
      described.kind === "approval"
        ? approvalChoices(asked, request).map<LiveAction>((choice) => ({
            target: respondTarget(request, choice),
            label: choice.label,
            kind: refuses(choice) ? "reject" : "approve",
          }))
        : [stopAction(asked)];
    return {
      threadId: asked.threadId,
      needsYou: true,
      agent,
      title: described.title,
      detail: described.body,
      badge: "Needs you",
      others: othersLine(needYou.length - 1, working.length),
      count,
      actions,
    };
  }

  const waiting = needYou[0];
  if (waiting) {
    const agent = agentTitle(waiting, projection.providers);
    return {
      threadId: waiting.threadId,
      needsYou: true,
      agent,
      title: `${agent} needs you`,
      detail: lastReply(projection, waiting) ?? branchLine(projection, waiting),
      badge: "Needs you",
      others: othersLine(needYou.length - 1, working.length),
      count,
      actions: [stopAction(waiting)],
    };
  }

  const busy = [...working].sort(newestFirst)[0];
  if (!busy) return undefined;
  const starting = busy.status === "starting";
  const agent = agentTitle(busy, projection.providers);
  return {
    threadId: busy.threadId,
    needsYou: false,
    agent,
    title: `${agent} is ${starting ? "starting" : "working"}`,
    detail: currentActivity(projection, busy)?.title ?? lastReply(projection, busy) ?? branchLine(projection, busy),
    badge: count > 1 ? `${count} working` : starting ? "Starting" : "Working",
    others: othersLine(0, working.length - 1),
    count,
    actions: [stopAction(busy)],
  };
}

/** The command a pressed live status button stands for, if what it answers is still open. */
export function liveCommand(
  projection: RuntimeProjection | undefined,
  target: string,
): (Record<string, unknown> & { type: string }) | undefined {
  if (!projection) return undefined;
  const [verb, ...rest] = target.split("/");
  const parts = rest.map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return undefined;
    }
  });
  if (verb === "stop" && parts.length === 1) {
    const thread = projection.threads.find((candidate) => candidate.threadId === parts[0]);
    if (!thread || thread.status === "stopped" || thread.status === "failed") return undefined;
    return { type: "thread.stop", threadId: thread.threadId };
  }
  if (verb === "respond" && parts.length === 2) {
    const request = (projection.requests ?? []).find((candidate) => candidate.requestId === parts[0]);
    const thread = projection.threads.find((candidate) => candidate.threadId === request?.threadId);
    if (!request || !thread || request.kind !== "approval") return undefined;
    const choice = describeApproval(thread.provider, request.payload).choices.find(
      (candidate) => candidate.key === parts[1],
    );
    if (!choice) return undefined;
    return {
      type: "thread.respond",
      threadId: thread.threadId,
      requestId: request.requestId,
      decision: choice.decision,
    };
  }
  return undefined;
}

const AGENT_LINK = "zli-remote://agent/";

/** The link a tap on the live status opens, back to the featured agent. */
export function agentLink(threadId: string): string {
  return `${AGENT_LINK}${encodeURIComponent(threadId)}`;
}

export function agentFromLink(url: string | null | undefined): string | undefined {
  if (!url?.startsWith(AGENT_LINK)) return undefined;
  const id = url.slice(AGENT_LINK.length).split(/[/?#]/u)[0];
  if (!id) return undefined;
  try {
    return decodeURIComponent(id);
  } catch {
    return undefined;
  }
}
