import type { AgentEventEnvelope, AttentionStatus, ExecutionStatus } from "./agentEvents.ts";

export interface AttentionState {
  executionStatus: ExecutionStatus;
  attentionStatus: AttentionStatus;
  unread: boolean;
  unreadCount: number;
}

export interface AttentionNotification {
  eventId: string;
  projectId: string;
  agentId: string | null;
  timestamp: string;
  attentionStatus: AttentionStatus;
  message: string;
}

export type WaitingEvidence =
  | { kind: "generic_output"; lastOutputAt?: number }
  | { kind: "provider_hook" | "process_exit" | "taxchat_delivery" | "api" | "provider_prompt" };

// The detector supplies a prompt candidate and monotonic milliseconds, not raw output.
export function shouldPromoteToWaiting(state: AttentionState, evidence: WaitingEvidence, now: number): boolean {
  if (state.attentionStatus !== "working"
    || (state.executionStatus !== "starting" && state.executionStatus !== "running")) return false;
  if (!Number.isFinite(now) || now < 0) return false;
  if (evidence.kind !== "generic_output") return true;
  return evidence.lastOutputAt !== undefined
    && Number.isFinite(evidence.lastOutputAt) && evidence.lastOutputAt >= 0
    && now - evidence.lastOutputAt >= 5000;
}

const terminalExecutionStatuses: ReadonlySet<ExecutionStatus> = new Set(["error", "exited", "stopped"]);

// Envelopes must be validated, ordered, and deduplicated by the caller.
export function reduceAttention(state: AttentionState, event: AgentEventEnvelope): AttentionState {
  const next = { ...state };
  switch (event.kind) {
    case "attention_ack":
    case "attention_mark_all_read":
      return { ...state, unread: false, unreadCount: 0 };
    case "agent_started":
      break;
    default:
      if (terminalExecutionStatuses.has(state.executionStatus)) return next;
  }
  switch (event.kind) {
    case "agent_started":
      next.executionStatus = "running";
      next.attentionStatus = "working";
      break;
    case "agent_prompt_detected":
    case "agent_waiting":
      next.attentionStatus = "waiting_for_you";
      break;
    case "agent_completed":
      next.attentionStatus = "completed";
      break;
    case "agent_failed":
      next.executionStatus = "error";
      next.attentionStatus = "failed";
      break;
    case "agent_paused":
      next.executionStatus = "paused";
      next.attentionStatus = "paused";
      break;
    case "agent_stopped":
      next.executionStatus = "stopped";
      next.attentionStatus = "offline";
      break;
    case "agent_exited": {
      if (state.executionStatus === "stopped") break;
      next.executionStatus = "exited";
      const payload = event.payload;
      const code = typeof payload === "object" && payload !== null && "type" in payload
        && payload.type === "exit" && "code" in payload ? payload.code : null;
      if (typeof code === "number" && code !== 0) next.attentionStatus = "failed";
      else if (state.attentionStatus !== "completed" && state.attentionStatus !== "failed") {
        next.attentionStatus = code === 0 ? "completed" : "offline";
      }
      break;
    }
    default:
      return next;
  }
  if (next.attentionStatus !== state.attentionStatus && notificationMessage(next.attentionStatus) !== null) {
    next.unread = true;
    next.unreadCount = Math.min(Number.MAX_SAFE_INTEGER, state.unreadCount + 1);
  }
  return next;
}

function notificationMessage(status: AttentionStatus): string | null {
  switch (status) {
    case "waiting_for_you": return "Agent is waiting for your input.";
    case "completed": return "Agent completed its task.";
    case "failed": return "Agent failed. Check its terminal for details.";
    default: return null;
  }
}

// Pass the state before applying this event. Payload text is never copied into notifications.
export function deriveNotification(event: AgentEventEnvelope, state: AttentionState): AttentionNotification | null {
  const next = reduceAttention(state, event);
  const message = notificationMessage(next.attentionStatus);
  if (next.attentionStatus === state.attentionStatus || message === null) return null;
  return { eventId: event.eventId, projectId: event.projectId, agentId: event.agentId,
    timestamp: event.timestamp, attentionStatus: next.attentionStatus, message };
}
