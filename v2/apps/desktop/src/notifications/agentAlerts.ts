import type { RuntimeProjection, TerminalProjection, ThreadProjection } from "@zli-v2/contracts";

export type AgentAlertKind = "finished" | "approval" | "user-input" | "failed";

export type AgentAlert = {
  /** One key per transition, so a repeated projection never raises the same notification twice. */
  key: string;
  kind: AgentAlertKind;
  /** The session the renderer selects when the notification is clicked. */
  sessionId: string;
  title: string;
  body: string;
};

export type AlertProjection = Pick<RuntimeProjection, "threads" | "terminals" | "worktrees"> &
  Partial<Pick<RuntimeProjection, "requests" | "messages" | "providers">>;

/** The parts of a projection that decide alerts, kept between updates. */
export type AlertState = {
  threads: ReadonlyMap<string, ThreadProjection["status"]>;
  agentTerminals: ReadonlyMap<string, TerminalProjection["status"]>;
  requests: ReadonlySet<string>;
};

const MAX_BODY = 180;

export function alertState(projection: AlertProjection): AlertState {
  const threads = new Map<string, ThreadProjection["status"]>();
  for (const thread of projection.threads) threads.set(thread.threadId, thread.status);
  const agentTerminals = new Map<string, TerminalProjection["status"]>();
  for (const terminal of projection.terminals) {
    if (terminal.kind === "agent") agentTerminals.set(terminal.terminalId, terminal.status);
  }
  return {
    threads,
    agentTerminals,
    requests: new Set((projection.requests ?? []).map((request) => request.requestId)),
  };
}

/**
 * The transitions between two projections that a person would want to hear about: a chat turn
 * that finished (working to idle), a new approval or input request, and an agent that failed.
 * Threads and terminals that were not in `previous` never alert, so the first projection after
 * startup is silent.
 */
export function detectAgentAlerts(previous: AlertState, projection: AlertProjection): AgentAlert[] {
  const alerts: AgentAlert[] = [];
  const threadsById = new Map(projection.threads.map((thread) => [thread.threadId as string, thread]));
  for (const thread of projection.threads) {
    const before = previous.threads.get(thread.threadId);
    if (before === undefined || before === thread.status) continue;
    const name = agentName(thread.provider, projection.providers);
    const sessionId = thread.sessionId ?? thread.threadId;
    if (before === "working" && thread.status === "idle") {
      alerts.push({
        key: `thread:${thread.threadId}:finished:${thread.activeTurnId ?? thread.updatedAt ?? ""}`,
        kind: "finished",
        sessionId,
        title: `${name} finished`,
        body: context(firstUserLine(projection, thread.threadId), branchOf(projection, thread.worktreeId)),
      });
    } else if (thread.status === "failed") {
      alerts.push({
        key: `thread:${thread.threadId}:failed:${thread.updatedAt ?? ""}`,
        kind: "failed",
        sessionId,
        title: `${name} stopped with an error`,
        body: clip(thread.errorMessage) || context(branchOf(projection, thread.worktreeId)),
      });
    }
  }
  for (const request of projection.requests ?? []) {
    if (previous.requests.has(request.requestId)) continue;
    const thread = threadsById.get(request.threadId);
    if (!thread) continue;
    const name = agentName(thread.provider, projection.providers);
    alerts.push({
      key: `request:${request.requestId}`,
      kind: request.kind,
      sessionId: thread.sessionId ?? thread.threadId,
      title: request.kind === "approval" ? `${name} needs approval` : `${name} needs input`,
      body: context(requestSummary(request.payload), branchOf(projection, thread.worktreeId)),
    });
  }
  for (const terminal of projection.terminals) {
    if (terminal.kind !== "agent") continue;
    const before = previous.agentTerminals.get(terminal.terminalId);
    if (before === undefined || before === "failed" || terminal.status !== "failed") continue;
    alerts.push({
      key: `terminal:${terminal.terminalId}:failed`,
      kind: "failed",
      sessionId: terminal.sessionId ?? terminal.terminalId,
      title: `${terminal.title || "Agent"} stopped with an error`,
      body: clip(terminal.errorMessage) || context(branchOf(projection, terminal.worktreeId)),
    });
  }
  return alerts;
}

/** Agents with at least one open approval or input request. */
export function waitingAgentCount(projection: AlertProjection): number {
  const requests = projection.requests ?? [];
  if (requests.length === 0) return 0;
  const threads = new Set(projection.threads.map((thread) => thread.threadId as string));
  const waiting = new Set<string>();
  for (const request of requests) if (threads.has(request.threadId)) waiting.add(request.threadId);
  return waiting.size;
}

/** Names used before provider discovery has reported, matching the renderer's fallbacks. */
const FALLBACK_NAMES: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  "cursor-agent": "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
  gemini: "Gemini",
  copilot: "GitHub Copilot",
  kimi: "Kimi Code",
  qwen: "Qwen Code",
  goose: "Goose",
};

function agentName(provider: string, providers: AlertProjection["providers"]): string {
  return providers?.find((entry) => entry.provider === provider)?.displayName ?? FALLBACK_NAMES[provider] ?? provider;
}

function branchOf(projection: AlertProjection, worktreeId: string): string | undefined {
  return projection.worktrees.find((worktree) => worktree.worktreeId === worktreeId)?.branch;
}

function firstUserLine(projection: AlertProjection, threadId: string): string | undefined {
  const message = projection.messages?.find(
    (candidate) => candidate.threadId === threadId && candidate.role === "user" && candidate.text.trim(),
  );
  return message?.text.trim().split(/\r?\n/u)[0];
}

function requestSummary(payload: Record<string, unknown>): string | undefined {
  for (const key of ["command", "title", "question", "message"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim().split(/\r?\n/u)[0];
  }
  return undefined;
}

function context(...parts: (string | undefined)[]): string {
  return clip(parts.filter((part): part is string => Boolean(part)).join(" · "));
}

function clip(value: string | undefined): string {
  if (!value) return "";
  const text = value.trim();
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text;
}
