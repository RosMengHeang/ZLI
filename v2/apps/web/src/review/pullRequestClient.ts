import {
  GitBranchesResult,
  GitChangeResult,
  type GitHunkAction,
  GitPullResult,
  type GitStashAction,
  GitStashListResult,
  GitStashResult,
  PullRequestCheckLogResult,
  PullRequestCommentsResult,
  PullRequestCreateResult,
  type PullRequestMergeMethod,
  PullRequestMergeResult,
  PullRequestPushResult,
  PullRequestReplyResult,
  PullRequestResolveResult,
  type PullRequestReviewEvent,
  PullRequestStatusResult,
  PullRequestUpdateResult,
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

export function reviewPullRequest(
  dispatch: Dispatch,
  worktreeId: string,
  input: { event: PullRequestReviewEvent; body: string },
): Promise<PullRequestUpdateResult> {
  return request(
    dispatch,
    { type: "review.pr.review", worktreeId: WorktreeId.parse(worktreeId), ...input },
    PullRequestUpdateResult,
  );
}

export function commentOnPullRequest(
  dispatch: Dispatch,
  worktreeId: string,
  body: string,
): Promise<PullRequestUpdateResult> {
  return request(
    dispatch,
    { type: "review.pr.comment", worktreeId: WorktreeId.parse(worktreeId), body },
    PullRequestUpdateResult,
  );
}

export function replyToThread(
  dispatch: Dispatch,
  worktreeId: string,
  input: { threadId: string; body: string },
): Promise<PullRequestReplyResult> {
  return request(
    dispatch,
    { type: "review.pr.reply", worktreeId: WorktreeId.parse(worktreeId), ...input },
    PullRequestReplyResult,
  );
}

export function resolveThread(
  dispatch: Dispatch,
  worktreeId: string,
  input: { threadId: string; resolved: boolean },
): Promise<PullRequestResolveResult> {
  return request(
    dispatch,
    { type: "review.pr.resolve", worktreeId: WorktreeId.parse(worktreeId), ...input },
    PullRequestResolveResult,
  );
}

export function setAutoMerge(
  dispatch: Dispatch,
  worktreeId: string,
  input: { enabled: true; method: PullRequestMergeMethod } | { enabled: false },
): Promise<PullRequestUpdateResult> {
  return request(
    dispatch,
    { type: "review.pr.autoMerge", worktreeId: WorktreeId.parse(worktreeId), ...input },
    PullRequestUpdateResult,
  );
}

/** Stages the paths, or every change when `paths` is omitted. */
export function stageFiles(
  dispatch: Dispatch,
  worktreeId: string,
  paths?: readonly string[],
): Promise<GitChangeResult> {
  return request(
    dispatch,
    { type: "review.git.stage", worktreeId: WorktreeId.parse(worktreeId), ...(paths ? { paths: [...paths] } : {}) },
    GitChangeResult,
  );
}

/** Unstages the paths, or everything staged when `paths` is omitted. */
export function unstageFiles(
  dispatch: Dispatch,
  worktreeId: string,
  paths?: readonly string[],
): Promise<GitChangeResult> {
  return request(
    dispatch,
    { type: "review.git.unstage", worktreeId: WorktreeId.parse(worktreeId), ...(paths ? { paths: [...paths] } : {}) },
    GitChangeResult,
  );
}

export function discardFile(dispatch: Dispatch, worktreeId: string, path: string): Promise<GitChangeResult> {
  return request(
    dispatch,
    { type: "review.git.discard", worktreeId: WorktreeId.parse(worktreeId), path },
    GitChangeResult,
  );
}

export function applyHunk(
  dispatch: Dispatch,
  worktreeId: string,
  input: { path: string; action: GitHunkAction; index: number; hunk: string },
): Promise<GitChangeResult> {
  return request(
    dispatch,
    { type: "review.git.hunk", worktreeId: WorktreeId.parse(worktreeId), ...input },
    GitChangeResult,
  );
}

export function listStashes(dispatch: Dispatch, worktreeId: string): Promise<GitStashListResult> {
  return request(
    dispatch,
    { type: "review.git.stashList", worktreeId: WorktreeId.parse(worktreeId) },
    GitStashListResult,
  );
}

export function stashChanges(dispatch: Dispatch, worktreeId: string, message?: string): Promise<GitStashResult> {
  return request(
    dispatch,
    { type: "review.git.stash", worktreeId: WorktreeId.parse(worktreeId), ...(message ? { message } : {}) },
    GitStashResult,
  );
}

export function runStashAction(
  dispatch: Dispatch,
  worktreeId: string,
  input: { action: GitStashAction; index: number; commit: string },
): Promise<GitStashResult> {
  return request(
    dispatch,
    { type: "review.git.stashAction", worktreeId: WorktreeId.parse(worktreeId), ...input },
    GitStashResult,
  );
}
