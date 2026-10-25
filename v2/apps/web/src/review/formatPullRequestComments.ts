import type { PullRequestCommentsResult, PullRequestReviewSummary, PullRequestReviewThread } from "@zli-v2/contracts";

import { fenceFor } from "./reviewComments.js";

const MAX_BODY_CHARS = 4_000;

const reviewStateLabel: Record<PullRequestReviewSummary["state"], string> = {
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "commented",
  APPROVED: "approved",
};

export function reviewStateText(state: PullRequestReviewSummary["state"]): string {
  return reviewStateLabel[state];
}

/** `path:12`, `path:10-12`, or just the path when GitHub no longer maps the thread onto a line. */
export function threadLocation(thread: Pick<PullRequestReviewThread, "path" | "line" | "startLine">): string {
  if (!thread.line) return thread.path;
  return thread.startLine ? `${thread.path}:${thread.startLine}-${thread.line}` : `${thread.path}:${thread.line}`;
}

function clip(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > MAX_BODY_CHARS ? `${trimmed.slice(0, MAX_BODY_CHARS)}…` : trimmed;
}

/**
 * The message an agent receives: each review summary, then each thread with the diff lines it was
 * left on and every comment in it, so the agent sees the whole conversation.
 */
export function formatPullRequestCommentsMessage(
  pullRequest: Pick<PullRequestCommentsResult, "number" | "url">,
  threads: readonly PullRequestReviewThread[],
  reviews: readonly PullRequestReviewSummary[],
  branch: string | undefined,
): string {
  const count = threads.length + reviews.length;
  const intro = `Please address ${count === 1 ? "this review comment" : "these review comments"} from pull request #${pullRequest.number}${branch ? ` for the branch ${branch}` : ""}.\n${pullRequest.url}`;
  const reviewSections = reviews.map(
    (review) => `Review by ${review.author} (${reviewStateText(review.state)}):\n${clip(review.body)}`,
  );
  const threadSections = threads.map((thread) => {
    const hunk = thread.diffHunk ? thread.diffHunk.split("\n") : [];
    const fence = fenceFor(hunk);
    return [
      `${threadLocation(thread)}${thread.outdated ? " (outdated: the code changed after this comment)" : ""}`,
      ...(hunk.length > 0 ? [`${fence}diff`, ...hunk, fence] : []),
      ...thread.comments.map((comment) => `${comment.author}: ${clip(comment.body)}`),
    ].join("\n");
  });
  return [intro, ...reviewSections, ...threadSections].join("\n\n");
}
