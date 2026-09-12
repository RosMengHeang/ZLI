/** Shared frontend/backend contracts. Field names match Rust `camelCase` serde. */

export type TerminalId = string;
export type AgentId = string;
export type PaneId = string;

export interface ProjectInfo {
  path: string;
  name: string;
  repositoryRoot: string;
  currentBranch: string;
  baseBranch: string;
  detachedHead: boolean;
  clean: boolean;
}

export type SessionStatus = "starting" | "running" | "exited" | "killed" | "failed" | "error";

export interface TerminalSession {
  id: TerminalId;
  cwd: string;
  status: SessionStatus;
  title?: string;
  provider?: AgentProviderId;
  cols?: number;
  rows?: number;
  exitCode?: number | null;
  error?: string | null;
}

/** Provider IDs are backend-defined so newly detected CLIs can appear without a frontend release. */
export type AgentProviderId = string;

export interface AgentProvider {
  id: AgentProviderId;
  displayName: string;
  executable: string;
  installed: boolean;
}

export type AgentStatus = "starting" | "running" | "exited" | "error";

export interface Agent {
  id: AgentId;
  name: string;
  provider: AgentProviderId;
  terminalId: TerminalId;
  cwd: string;
  branch: string;
  worktreePath: string | null;
  status: AgentStatus;
  error?: string | null;
  /** Frontend-only workspace metadata used to restore this agent after restart. */
  projectRoot?: string;
  resumeId?: string;
  createWorktree?: boolean;
}

export type TaxChatRoomStatus = "ready" | "running" | "idle" | "paused" | "stopped";
export type TaxChatMessageKind = "user" | "agent" | "delivery" | "system" | "error";
export type TaxChatMessageStatus = "pending" | "delivered" | "failed" | "informational";

export interface TaxChatParticipant {
  agentId: AgentId;
  status: "available" | "queued" | "delivering" | "unavailable";
  routedCount: number;
}

export interface TaxChatMessage {
  id: string;
  senderId: string;
  recipientIds: string[];
  kind: TaxChatMessageKind;
  body: string;
  createdAt: string;
  status: TaxChatMessageStatus;
  round: number;
}

export interface TaxChatRoomSettings {
  inactivityMs: number;
  perAgentMessageLimit: number;
  totalMessageLimit: number;
}

export interface TaxChatRoom {
  id: string;
  status: TaxChatRoomStatus;
  participantIds: AgentId[];
  participants: TaxChatParticipant[];
  messages: TaxChatMessage[];
  round: number;
}

export interface TaxChatProtocolBlock {
  senderId: AgentId;
  recipient: AgentId | "all" | "user";
  body: string;
}

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "typeChanged"
  | "unmerged";

export interface ChangedFile {
  path: string;
  originalPath?: string | null;
  status: FileStatus;
  staged: boolean;
  additions: number | null;
  deletions: number | null;
}

export interface GitStatus {
  branch: string | null;
  clean: boolean;
  changedFiles: ChangedFile[];
  additions: number;
  deletions: number;
}

export interface FileDiff {
  path: string;
  originalPath?: string | null;
  status: FileStatus;
  diff: string;
  binary: boolean;
}

export interface RepositoryInfo {
  path: string;
  repositoryRoot: string;
  currentBranch: string | null;
  detachedHead: boolean;
  baseBranch: string | null;
  clean: boolean;
}

export interface CreateWorktreeRequest {
  repositoryRoot: string;
  provider: string;
  baseBranch?: string | null;
}

export interface CreateWorktreeResult {
  branch: string;
  worktreePath: string;
  baseBranch: string;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
  isMain: boolean;
  locked: boolean;
  prunable: boolean;
  orphaned: boolean;
}

export type WorktreeAuditState =
  | "main"
  | "registered_clean"
  | "registered_dirty"
  | "registered_unknown"
  | "locked"
  | "prunable_metadata"
  | "orphaned_empty"
  | "orphaned_non_empty"
  | "unknown";

export interface WorktreeAuditEntry {
  path: string;
  branch: string | null;
  state: WorktreeAuditState;
  clean: boolean | null;
  safeToRemoveWithoutForce: boolean;
  safeToPruneMetadata: boolean;
  requiresForce: boolean;
  note: string | null;
}

export interface WorktreeAudit {
  repositoryRoot: string;
  storageRoot: string;
  entries: WorktreeAuditEntry[];
  removableWithoutForceCount: number;
  prunableMetadataCount: number;
  requiresForceCount: number;
}

export interface RemoveWorktreeRequest {
  repositoryRoot: string;
  worktreePath: string;
  /** Must be explicit. Never defaulted to true by the UI. */
  force: boolean;
}

export interface RemovedWorktreeResult {
  path: string;
  forced: boolean;
}

export interface DeleteBranchRequest {
  repositoryRoot: string;
  branch: string;
  force: boolean;
}

export interface CommitRequest {
  worktreePath: string;
  message: string;
  stageAll: boolean;
}

export interface CommitResult {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface MergeRequest {
  repositoryRoot: string;
  sourceBranch: string;
  targetBranch?: string | null;
}

export type MergeOutcome =
  | {
      outcome: "success";
      commitHash: string;
      targetBranch: string;
      sourceBranch: string;
      fastForward: boolean;
    }
  | {
      outcome: "conflict";
      targetBranch: string;
      sourceBranch: string;
      conflictedFiles: string[];
    };

export interface LaunchAgentRequest {
  name: string;
  provider: AgentProviderId;
  cwd: string;
  createWorktree: boolean;
  restartAgentId?: string;
  cols?: number;
  rows?: number;
}

export interface CreatePtyRequest {
  cwd: string;
  cols: number;
  rows: number;
  title?: string;
  /** Optional command argv. Omit to use the detected user shell. */
  argv?: string[];
}

export interface AppError {
  code: string;
  message: string;
  details?: string;
}

export type SplitDirection = "horizontal" | "vertical";

export interface LeafPane {
  type: "leaf";
  id: PaneId;
  terminalId: TerminalId;
}

export interface SplitPaneNode {
  type: "split";
  id: PaneId;
  direction: SplitDirection;
  sizes: [number, number];
  first: PaneNode;
  second: PaneNode;
}

export type PaneNode = LeafPane | SplitPaneNode;

export const PROVIDER_CATALOG: {
  id: AgentProviderId;
  displayName: string;
}[] = [
  { id: "claude-code", displayName: "Claude Code" },
  { id: "codex", displayName: "Codex" },
  { id: "cursor-agent", displayName: "Cursor Agent" },
  { id: "opencode", displayName: "OpenCode" },
  { id: "gemini", displayName: "Gemini CLI" },
  { id: "aider", displayName: "Aider" },
  { id: "goose", displayName: "Goose" },
  { id: "shell", displayName: "Terminal" },
];

export function providerDisplayName(id: string): string {
  const aliases: Record<string, string> = {
    claude: "claude-code",
    cursor: "cursor-agent",
  };
  const canonicalId = aliases[id] ?? id;
  return PROVIDER_CATALOG.find((p) => p.id === canonicalId)?.displayName ?? id;
}

/** Git worktree slugs from the git backend comments. */
export function worktreeProviderSlug(id: AgentProviderId): string {
  switch (id) {
    case "claude":
      return "claude-code";
    case "cursor":
      return "cursor-agent";
    default:
      return id;
  }
}
