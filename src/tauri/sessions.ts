import type { SessionCheckpoint } from "../lib/sessionPersistence";
import { invokeCmd } from "./invoke";

export const SESSION_PROTOCOL_VERSION = 1 as const;

export type ResumeAvailability = "available" | "unsupported" | "unknown";

export interface ResumeDescriptor {
  providerId: string;
  providerSessionId: string | null;
  resumeCommandKind: string | null;
  workingDirectory: string;
  lastCheckpointAt: string | null;
  availability: ResumeAvailability;
}

export interface SessionDescriptor {
  sessionId: string;
  projectId: string;
  agentId: string;
  parentAgentId: string | null;
  name: string;
  providerId: string;
  terminalId: string;
  workingDirectory: string;
  branch: string;
  worktreePath: string | null;
  resume: ResumeDescriptor | null;
  attached: boolean;
}

export interface ReconnectResult {
  protocolVersion: number;
  currentSequence: number;
  events: unknown[];
  sessions: SessionDescriptor[];
  reconciliation: ReconcileReport;
}

export interface ReconcileReport {
  offlineSessionIds: string[];
  retainedMissingWorktrees: string[];
  stoppedOwnedProcessIds: string[];
  orphanedOwnedProcessIds: string[];
  unknownProcessIds: string[];
  clearedOwnershipRecordIds: string[];
}

export interface RestoreResult {
  snapshot: SessionCheckpoint | null;
  sessionIds: string[];
  createdSessionIds: string[];
}

export interface SessionClient {
  reconnect: (protocolVersion: number, cursor: number) => Promise<ReconnectResult>;
  reconcile: () => Promise<ReconcileReport>;
  restoreProject: (projectId: string) => Promise<RestoreResult>;
  forget: (projectId: string, sessionId: string) => Promise<boolean>;
  resume: (sessionId: string) => Promise<SessionDescriptor>;
  snapshot?: (request: SessionSnapshotRequest) => Promise<SessionCheckpoint>;
}

export interface SessionSnapshotRequest {
  projectId: string;
  paneTree: unknown;
  browser: unknown[];
  taxChatRoom: unknown | null;
  lastEventSequence: number;
}

export const sessionClient: SessionClient = {
  reconnect: (protocolVersion, cursor) =>
    invokeCmd<ReconnectResult>("control_session_reconnect", { protocolVersion, cursor }),
  reconcile: () => invokeCmd<ReconcileReport>("control_session_reconcile", {}),
  restoreProject: (projectId) =>
    invokeCmd<RestoreResult>("control_session_restore", { projectId }),
  forget: (projectId, sessionId) =>
    invokeCmd<boolean>("control_session_forget", { projectId, sessionId }),
  resume: (sessionId) =>
    invokeCmd<SessionDescriptor>("control_session_resume", { sessionId }),
  snapshot: (request) =>
    invokeCmd<SessionCheckpoint>("control_session_snapshot", { request }),
};
