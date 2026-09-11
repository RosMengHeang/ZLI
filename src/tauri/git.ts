import type {
  CommitRequest,
  CommitResult,
  CreateWorktreeRequest,
  CreateWorktreeResult,
  DeleteBranchRequest,
  FileDiff,
  GitStatus,
  MergeOutcome,
  MergeRequest,
  RemovedWorktreeResult,
  RemoveWorktreeRequest,
  WorktreeAudit,
  WorktreeInfo,
} from "../types";
import { GIT_COMMANDS } from "../types/commands";
import { invokeCmd } from "./invoke";

export function gitStatus(worktreePath: string): Promise<GitStatus> {
  return invokeCmd<GitStatus>(GIT_COMMANDS.status, { worktreePath });
}

export function gitDiff(worktreePath: string, filePath?: string | null): Promise<FileDiff[]> {
  return invokeCmd<FileDiff[]>(GIT_COMMANDS.diff, {
    worktreePath,
    filePath: filePath ?? null,
  });
}

export function gitCommit(request: CommitRequest): Promise<CommitResult> {
  return invokeCmd<CommitResult>(GIT_COMMANDS.commit, { request });
}

export function gitMerge(request: MergeRequest): Promise<MergeOutcome> {
  return invokeCmd<MergeOutcome>(GIT_COMMANDS.merge, { request });
}

export function gitAbortMerge(repositoryRoot: string): Promise<void> {
  return invokeCmd<void>(GIT_COMMANDS.abortMerge, { repositoryRoot });
}

export function gitCreateWorktree(request: CreateWorktreeRequest): Promise<CreateWorktreeResult> {
  return invokeCmd<CreateWorktreeResult>(GIT_COMMANDS.createWorktree, { request });
}

export function gitListWorktrees(repositoryRoot: string): Promise<WorktreeInfo[]> {
  return invokeCmd<WorktreeInfo[]>(GIT_COMMANDS.listWorktrees, { repositoryRoot });
}

export function gitAuditWorktrees(repositoryRoot: string): Promise<WorktreeAudit> {
  return invokeCmd<WorktreeAudit>(GIT_COMMANDS.auditWorktrees, { repositoryRoot });
}

export function gitPruneWorktrees(repositoryRoot: string): Promise<void> {
  return invokeCmd<void>(GIT_COMMANDS.pruneWorktrees, { repositoryRoot });
}

export function gitRemoveWorktree(request: RemoveWorktreeRequest): Promise<RemovedWorktreeResult> {
  return invokeCmd<RemovedWorktreeResult>(GIT_COMMANDS.removeWorktree, { request });
}

export function gitDeleteBranch(request: DeleteBranchRequest): Promise<void> {
  return invokeCmd<void>(GIT_COMMANDS.deleteBranch, { request });
}
