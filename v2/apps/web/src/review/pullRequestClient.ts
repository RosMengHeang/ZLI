import {
  GitBranchesResult,
  GitPullResult,
  PullRequestCheckLogResult,
  PullRequestCommentsResult,
  PullRequestCreateResult,
  type PullRequestMergeMethod,
  PullRequestMergeResult,
  PullRequestPushResult,
  PullRequestStatusResult,
  type RpcResponse,
  WorktreeId,
} from "@zli-v2/contracts";

import { makeCommandId } from "../runtime/commandId.js";

export type Dispatch = (request: unknown) => Promise<RpcResponse | undefined>;

export class PullRequestRequestError extends Error {}

async function request<T>(
  dispatch: Dispatch,
  command: Record<string, unknown>,
  schema: { parse(value: unknown): T },
): Promise<T> {
  const response = await dispatch({ protocolVersion: 1, commandId: makeCommandId(), command });
  if (!response) throw new PullRequestRequestError("The runtime is not connected.");
  if (!response.accepted) throw new PullRequestRequestError(response.error.message);
  try {
    return schema.parse(response.result);
  } catch {
    throw new PullRequestRequestError("The runtime sent an unexpected reply. Restart ZLI and try again.");
  }
}

export function pullRequestStatus(
  dispatch: Dispatch,
  worktreeId: string,
  base?: string,
): Promise<PullRequestStatusResult> {
  return request(
    dispatch,
    { type: "review.pr.status", worktreeId: WorktreeId.parse(worktreeId), ...(base ? { base } : {}) },
    PullRequestStatusResult,
  );
}

export function pushBranch(dispatch: Dispatch, worktreeId: string): Promise<PullRequestPushResult> {
  return request(dispatch, { type: "review.pr.push", worktreeId: WorktreeId.parse(worktreeId) }, PullRequestPushResult);
}

export function readCheckLog(dispatch: Dispatch, worktreeId: string, url: string): Promise<PullRequestCheckLogResult> {
  return request(
    dispatch,
    { type: "review.pr.checkLog", worktreeId: WorktreeId.parse(worktreeId), url },
    PullRequestCheckLogResult,
  );
}

export function readReviewComments(dispatch: Dispatch, worktreeId: string): Promise<PullRequestCommentsResult> {
  return request(
    dispatch,
    { type: "review.pr.comments", worktreeId: WorktreeId.parse(worktreeId) },
    PullRequestCommentsResult,
  );
}

export function createPullRequest(
  dispatch: Dispatch,
  worktreeId: string,
  input: { title: string; body: string; base: string; draft: boolean },
): Promise<PullRequestCreateResult> {
  return request(
    dispatch,
    { type: "review.pr.create", worktreeId: WorktreeId.parse(worktreeId), ...input },
    PullRequestCreateResult,
  );
}

export function mergePullRequest(
  dispatch: Dispatch,
  worktreeId: string,
  input: { method: PullRequestMergeMethod; deleteBranch: boolean },
): Promise<PullRequestMergeResult> {
  return request(
    dispatch,
    { type: "review.pr.merge", worktreeId: WorktreeId.parse(worktreeId), ...input },
    PullRequestMergeResult,
  );
}

export function listBranches(dispatch: Dispatch, worktreeId: string): Promise<GitBranchesResult> {
  return request(
    dispatch,
    { type: "review.git.branches", worktreeId: WorktreeId.parse(worktreeId) },
    GitBranchesResult,
  );
}

export function fetchBranches(dispatch: Dispatch, worktreeId: string): Promise<GitBranchesResult> {
  return request(dispatch, { type: "review.git.fetch", worktreeId: WorktreeId.parse(worktreeId) }, GitBranchesResult);
}

export function pullBranch(dispatch: Dispatch, worktreeId: string): Promise<GitPullResult> {
  return request(dispatch, { type: "review.git.pull", worktreeId: WorktreeId.parse(worktreeId) }, GitPullResult);
}
