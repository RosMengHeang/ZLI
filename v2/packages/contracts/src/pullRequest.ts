import { z } from "zod";

import { WorktreeId } from "./ids.js";

const BranchName = z.string().min(1).max(255);

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
]);
export type PullRequestCommand = z.infer<typeof PullRequestCommand>;
export const PULL_REQUEST_COMMAND_TYPES = [
  "review.pr.status",
  "review.pr.push",
  "review.pr.create",
  "review.pr.checkLog",
  "review.pr.comments",
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

export const PullRequestCheckLogResult = z.object({
  /** The end of the failed step's output, without timestamps; empty when the log had no lines. */
  excerpt: z.string().max(40_000),
  /** True when earlier lines of the failed step were left out. */
  truncated: z.boolean(),
});
export type PullRequestCheckLogResult = z.infer<typeof PullRequestCheckLogResult>;

export const PullRequestReviewComment = z.object({
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
