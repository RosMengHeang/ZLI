import { z } from "zod";

import { WorktreeId } from "./ids.js";

const BranchName = z.string().min(1).max(255);

export const PullRequestMergeMethod = z.enum(["squash", "merge", "rebase"]);
export type PullRequestMergeMethod = z.infer<typeof PullRequestMergeMethod>;

export const PullRequestReviewEvent = z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);
export type PullRequestReviewEvent = z.infer<typeof PullRequestReviewEvent>;

/** A GraphQL node id of a review thread, such as PRRT_kwDOABC. */
const ThreadNodeId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_=-]+$/u);
const CommentBody = z.string().trim().min(1).max(60_000);

/** Handled directly by the runtime server; none of these reach the event log. */
export const PullRequestCommand = z.discriminatedUnion("type", [
  /** `base` is the branch the defaults are computed against; without it the repository default is used. */
  z.object({ type: z.literal("review.pr.status"), worktreeId: WorktreeId, base: BranchName.optional() }),
  z.object({ type: z.literal("review.pr.push"), worktreeId: WorktreeId }),
  /** Reads the failed part of a GitHub Actions job log; `url` is the check's details link. */
  z.object({ type: z.literal("review.pr.checkLog"), worktreeId: WorktreeId, url: z.string().url().max(2_000) }),
  /** Reads the unresolved review threads and review summaries of the branch's pull request. */
  z.object({ type: z.literal("review.pr.comments"), worktreeId: WorktreeId }),
  z.object({
    type: z.literal("review.pr.create"),
    worktreeId: WorktreeId,
    title: z.string().trim().min(1).max(256),
    body: z.string().max(60_000),
    base: BranchName,
    draft: z.boolean(),
  }),
  /** Merges the branch's pull request on GitHub. `deleteBranch` removes the branch from origin afterwards. */
  z.object({
    type: z.literal("review.pr.merge"),
    worktreeId: WorktreeId,
    method: PullRequestMergeMethod,
    deleteBranch: z.boolean(),
  }),
  /** Local branches and the branches origin had at the last fetch. */
  z.object({ type: z.literal("review.git.branches"), worktreeId: WorktreeId }),
  /** Fetches origin, pruning branches deleted there, and answers with the new branch list. */
  z.object({ type: z.literal("review.git.fetch"), worktreeId: WorktreeId }),
  /** Fast-forwards the checked-out branch to its copy on origin. */
  z.object({ type: z.literal("review.git.pull"), worktreeId: WorktreeId }),
  /** Submits a review. GitHub requires a body for COMMENT and REQUEST_CHANGES. */
  z.object({
    type: z.literal("review.pr.review"),
    worktreeId: WorktreeId,
    event: PullRequestReviewEvent,
    body: z.string().max(60_000),
  }),
  /** Adds a comment to a review thread. */
  z.object({ type: z.literal("review.pr.reply"), worktreeId: WorktreeId, threadId: ThreadNodeId, body: CommentBody }),
  z.object({
    type: z.literal("review.pr.resolve"),
    worktreeId: WorktreeId,
    threadId: ThreadNodeId,
    resolved: z.boolean(),
  }),
  /** Adds a comment to the pull request's conversation, outside any review. */
  z.object({ type: z.literal("review.pr.comment"), worktreeId: WorktreeId, body: CommentBody }),
  /** Turns auto-merge on with `method`, or off. `method` is required when `enabled` is true. */
  z.object({
    type: z.literal("review.pr.autoMerge"),
    worktreeId: WorktreeId,
    enabled: z.boolean(),
    method: PullRequestMergeMethod.optional(),
  }),
]);
export type PullRequestCommand = z.infer<typeof PullRequestCommand>;
export const PULL_REQUEST_COMMAND_TYPES = [
  "review.pr.status",
  "review.pr.push",
  "review.pr.create",
  "review.pr.checkLog",
  "review.pr.comments",
  "review.pr.merge",
  "review.git.branches",
  "review.git.fetch",
  "review.git.pull",
  "review.pr.review",
  "review.pr.reply",
  "review.pr.resolve",
  "review.pr.comment",
  "review.pr.autoMerge",
] as const;

export const PullRequestCheckState = z.enum(["pending", "passed", "failed", "skipped"]);
export type PullRequestCheckState = z.infer<typeof PullRequestCheckState>;

/** One CI check on the pull request's latest commit, reduced to what ZLI shows. */
export const PullRequestCheck = z.object({
  name: z.string().min(1).max(300),
  workflow: z.string().max(300).optional(),
  state: PullRequestCheckState,
  url: z.string().url().optional(),
});
export type PullRequestCheck = z.infer<typeof PullRequestCheck>;

export const PullRequestReviewDecision = z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]);
export type PullRequestReviewDecision = z.infer<typeof PullRequestReviewDecision>;

export const PullRequestInfo = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  /** Absent when GitHub did not report checks, for example right after the pull request was created. */
  checks: z.array(PullRequestCheck).max(200).optional(),
  reviewDecision: PullRequestReviewDecision.optional(),
  /** Present while auto-merge is on: GitHub merges once the required checks and reviews pass. */
  autoMerge: z
    .object({ method: PullRequestMergeMethod.optional(), enabledBy: z.string().min(1).max(100).optional() })
    .optional(),
});
export type PullRequestInfo = z.infer<typeof PullRequestInfo>;

/** Why a pull request cannot be created from this worktree right now. */
export const PullRequestProblem = z.object({
  code: z.enum(["detached", "no_origin", "gh_missing", "gh_unauthenticated", "gh_failed"]),
  message: z.string().min(1),
});
export type PullRequestProblem = z.infer<typeof PullRequestProblem>;

export const PullRequestStatusResult = z.object({
  branch: z.string().min(1),
  pullRequest: PullRequestInfo.optional(),
  problem: PullRequestProblem.optional(),
  /** Files `git status` reports; they are not part of a pull request until committed. */
  uncommittedFiles: z.number().int().nonnegative(),
  /** Commits on the branch that the base does not have; absent when the base could not be resolved. */
  commitsAhead: z.number().int().nonnegative().optional(),
  defaults: z.object({ title: z.string(), body: z.string(), base: z.string().min(1) }),
});
export type PullRequestStatusResult = z.infer<typeof PullRequestStatusResult>;

export const PullRequestPushResult = z.object({ branch: z.string().min(1), remote: z.literal("origin") });
export type PullRequestPushResult = z.infer<typeof PullRequestPushResult>;

export const PullRequestCreateResult = z.object({ pullRequest: PullRequestInfo });
export type PullRequestCreateResult = z.infer<typeof PullRequestCreateResult>;

export const PullRequestMergeResult = z.object({
  pullRequest: PullRequestInfo,
  /** True when the branch is gone from origin, whether ZLI or a repository setting removed it. */
  branchDeleted: z.boolean(),
});
export type PullRequestMergeResult = z.infer<typeof PullRequestMergeResult>;

export const GitBranchesResult = z.object({
  /** Absent when HEAD is detached. */
  current: z.string().min(1).optional(),
  /** The branch origin/HEAD points at, when origin names one. */
  defaultBranch: z.string().min(1).optional(),
  local: z.array(BranchName).max(1_000),
  /** Branch names on origin, without the `origin/` prefix. */
  remote: z.array(BranchName).max(1_000),
});
export type GitBranchesResult = z.infer<typeof GitBranchesResult>;

export const GitPullResult = z.object({
  branch: z.string().min(1),
  /** Commits the pull brought in; 0 when the branch was already up to date. */
  commits: z.number().int().nonnegative(),
});
export type GitPullResult = z.infer<typeof GitPullResult>;
/** The pull request as GitHub reports it after a review, a comment, or an auto-merge change. */
export const PullRequestUpdateResult = z.object({ pullRequest: PullRequestInfo });
export type PullRequestUpdateResult = z.infer<typeof PullRequestUpdateResult>;

export const PullRequestCheckLogResult = z.object({
  /** The end of the failed step's output, without timestamps; empty when the log had no lines. */
  excerpt: z.string().max(40_000),
  /** True when earlier lines of the failed step were left out. */
  truncated: z.boolean(),
});
export type PullRequestCheckLogResult = z.infer<typeof PullRequestCheckLogResult>;

export const PullRequestReviewComment = z.object({
  /** GraphQL node id; absent in answers from older ZLI versions. */
  id: z.string().min(1).max(200).optional(),
  /** The GitHub login, or "ghost" for a deleted account. */
  author: z.string().min(1).max(100),
  body: z.string().max(20_000),
  url: z.string().url().optional(),
  createdAt: z.string().max(40).optional(),
});
export type PullRequestReviewComment = z.infer<typeof PullRequestReviewComment>;

/** A conversation on lines of the pull request's diff that nobody has marked resolved. */
export const PullRequestReviewThread = z.object({
  id: z.string().min(1).max(200),
  path: z.string().min(1).max(4_000),
  /** Lines in the current version; absent when the thread no longer maps onto the diff. */
  line: z.number().int().positive().optional(),
  startLine: z.number().int().positive().optional(),
  /** True when later commits changed the lines the thread was started on. */
  outdated: z.boolean(),
  /** The end of the diff hunk the first comment was made on, ending at the commented line. */
  diffHunk: z.string().max(8_000).optional(),
  comments: z.array(PullRequestReviewComment).min(1).max(50),
  /** What the signed-in GitHub account may do with the thread; absent when GitHub did not say. */
  viewerCanReply: z.boolean().optional(),
  viewerCanResolve: z.boolean().optional(),
  viewerCanUnresolve: z.boolean().optional(),
});
export type PullRequestReviewThread = z.infer<typeof PullRequestReviewThread>;

/** A submitted review with a written summary, such as a request for changes. */
export const PullRequestReviewSummary = z.object({
  id: z.string().min(1).max(200),
  author: z.string().min(1).max(100),
  state: z.enum(["CHANGES_REQUESTED", "COMMENTED", "APPROVED"]),
  body: z.string().min(1).max(20_000),
  url: z.string().url().optional(),
});
export type PullRequestReviewSummary = z.infer<typeof PullRequestReviewSummary>;

export const PullRequestCommentsResult = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  threads: z.array(PullRequestReviewThread).max(100),
  reviews: z.array(PullRequestReviewSummary).max(30),
});
export type PullRequestCommentsResult = z.infer<typeof PullRequestCommentsResult>;

export const PullRequestReplyResult = z.object({
  threadId: z.string().min(1).max(200),
  comment: PullRequestReviewComment,
});
export type PullRequestReplyResult = z.infer<typeof PullRequestReplyResult>;

export const PullRequestResolveResult = z.object({ threadId: z.string().min(1).max(200), resolved: z.boolean() });
export type PullRequestResolveResult = z.infer<typeof PullRequestResolveResult>;
