export type ExecutionStatus =
  | "starting"
  | "running"
  | "paused"
  | "exited"
  | "error"
  | "stopped";

export type AttentionStatus =
  | "working"
  | "waiting_for_you"
  | "completed"
  | "failed"
  | "paused"
  | "offline";

const AGENT_EVENT_SOURCES = [
  "runtime",
  "provider",
  "pty",
  "taxchat",
  "browser",
  "user",
  "api",
] as const;

export type AgentEventSource = (typeof AGENT_EVENT_SOURCES)[number];

const AGENT_EVENT_KINDS = [
  "agent_created",
  "agent_started",
  "agent_output",
  "agent_prompt_detected",
  "agent_waiting",
  "agent_message_received",
  "agent_message_delivered",
  "agent_message_failed",
  "agent_focus_requested",
  "agent_completed",
  "agent_failed",
  "agent_paused",
  "agent_stopped",
  "agent_exited",
  "agent_resume_available",
  "agent_resume_unavailable",
  "agent_worktree_created",
  "agent_worktree_cleanup_failed",
  "browser_surface_created",
  "browser_navigation_changed",
  "browser_console_error",
  "browser_command_started",
  "browser_command_completed",
  "browser_command_failed",
  "taxchat_room_started",
  "taxchat_message_sent",
  "taxchat_message_failed",
  "attention_ack",
  "attention_mark_all_read",
] as const;

export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

export type AgentEventPayload =
  | { type: "empty" }
  | { type: "text"; text: string }
  | { type: "exit"; code: number | null }
  | { type: "attention"; reason: string }
  | { type: "message"; messageId: string }
  | {
      type: "taxchat";
      messageId: string;
      body: string;
      recipientIds: string[];
      deliveredIds: string[];
      failedIds: string[];
    }
  | {
      type: "agent";
      name: string;
      providerId: string;
      terminalId: string;
      branch: string;
      worktreePath: string;
      paused: boolean;
    };

export interface AgentEventEnvelope<T = unknown> {
  schemaVersion: 1;
  sequence: number;
  eventId: string;
  projectId: string;
  agentId: string | null;
  parentAgentId: string | null;
  timestamp: string;
  source: AgentEventSource;
  kind: AgentEventKind;
  payload: T;
}

const eventSources = new Set<string>(AGENT_EVENT_SOURCES);
const eventKinds = new Set<string>(AGENT_EVENT_KINDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableId(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isAgentEventPayload(value: unknown): value is AgentEventPayload {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "empty":
      return true;
    case "text":
      return typeof value.text === "string";
    case "exit":
      return value.code === null
        || (typeof value.code === "number"
          && Number.isInteger(value.code)
          && value.code >= -2_147_483_648
          && value.code <= 2_147_483_647);
    case "attention":
      return isNonEmptyString(value.reason);
    case "message":
      return isNonEmptyString(value.messageId);
    case "taxchat": {
      const validIds = (candidate: unknown) => Array.isArray(candidate)
        && candidate.length <= 12
        && candidate.every(isNonEmptyString);
      return isNonEmptyString(value.messageId)
        && typeof value.body === "string"
        && value.body.length <= 16_384
        && validIds(value.recipientIds)
        && validIds(value.deliveredIds)
        && validIds(value.failedIds);
    }
    case "agent":
      return isNonEmptyString(value.name)
        && isNonEmptyString(value.providerId)
        && isNonEmptyString(value.terminalId)
        && typeof value.branch === "string"
        && isNonEmptyString(value.worktreePath)
        && typeof value.paused === "boolean";
    default:
      return false;
  }
}

export function isAgentEventEnvelope(value: unknown): value is AgentEventEnvelope {
  if (!isRecord(value)) {
    return false;
  }

  return value.schemaVersion === 1
    && typeof value.sequence === "number"
    && Number.isSafeInteger(value.sequence)
    && value.sequence >= 0
    && isNonEmptyString(value.eventId)
    && isNonEmptyString(value.projectId)
    && isNullableId(value.agentId)
    && isNullableId(value.parentAgentId)
    && isNonEmptyString(value.timestamp)
    && typeof value.source === "string"
    && eventSources.has(value.source)
    && typeof value.kind === "string"
    && eventKinds.has(value.kind)
    && hasOwn(value, "payload")
    && isAgentEventPayload(value.payload);
}
