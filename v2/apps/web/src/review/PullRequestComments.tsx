import type {
  PullRequestCommentsResult,
  PullRequestReviewSummary,
  PullRequestReviewThread,
  WorktreeProjection,
} from "@zli-v2/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useRuntime } from "../runtime/RuntimeProvider.js";
import type { SessionMode } from "../sessions/sessions.js";
import { Badge } from "../ui/Badge.js";
import { Button, IconButton } from "../ui/Button.js";
import { Icon } from "../ui/Icon.js";
import { openExternalLink } from "./links.js";
import { formatPullRequestCommentsMessage, reviewStateText, threadLocation } from "./pullRequestComments.js";
import { readReviewComments } from "./pullRequestClient.js";
import { SendToAgentDialog } from "./SendToAgentDialog.js";

/**
 * The pull request's open review threads and written reviews, read from GitHub when the person
 * asks for them. Everything starts selected; unticking leaves an item out of the message.
 */
export function PullRequestComments({
  worktree,
  checkKey,
  onShowAgent,
}: {
  worktree: WorktreeProjection;
  checkKey: number;
  onShowAgent?: ((sessionId: string, mode: SessionMode) => void) | undefined;
}) {
  const { bridge, dispatch } = useRuntime();
  const [result, setResult] = useState<PullRequestCommentsResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [left, setLeft] = useState<ReadonlySet<string>>(() => new Set());
  const [sending, setSending] = useState(false);
  const request = useRef(0);
  const worktreeId = worktree.worktreeId;

  const load = () => {
    const id = ++request.current;
    setLoading(true);
    setError(undefined);
    readReviewComments(dispatch, worktreeId).then(
      (next) => {
        if (id !== request.current) return;
        setResult(next);
        setLoading(false);
      },
      (cause: unknown) => {
        if (id !== request.current) return;
        setError(cause instanceof Error ? cause.message : "The review comments could not be read.");
        setLoading(false);
      },
    );
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: checkKey is the trigger to read again.
  useEffect(() => {
    load();
    return () => {
      request.current += 1;
    };
  }, [dispatch, worktreeId, checkKey]);

  const threads = result?.threads ?? [];
  const reviews = result?.reviews ?? [];
  const pickedThreads = useMemo(() => threads.filter((thread) => !left.has(thread.id)), [threads, left]);
  const pickedReviews = useMemo(() => reviews.filter((review) => !left.has(review.id)), [reviews, left]);
  const picked = pickedThreads.length + pickedReviews.length;
  const total = threads.length + reviews.length;
  const message = useMemo(
    () => (result ? formatPullRequestCommentsMessage(result, pickedThreads, pickedReviews, worktree.branch) : ""),
    [result, pickedThreads, pickedReviews, worktree.branch],
  );

  const toggle = (id: string) =>
    setLeft((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const open = (url: string | undefined) => {
    if (url) void openExternalLink(bridge, url).then((failure) => failure && setError(failure));
  };

  return (
    <section className="pr-comments" aria-label="Pull request comments">
      <header className="pr-comments-header">
        {loading && !result ? (
          <span className="pr-comments-status" role="status">
            <span className="spinner" aria-hidden="true" />
            Reading review comments from GitHub
          </span>
        ) : error ? (
          <span className="pr-comments-status is-problem" role="alert">
            <Icon name="alert" size={13} />
            <span>{error}</span>
          </span>
        ) : (
          <span className="pr-comments-status">
            {total === 0 ? "No open review comments" : `${total} open review comment${total === 1 ? "" : "s"}`}
          </span>
        )}
        <IconButton
          label="Read review comments again"
          tooltip="Read again"
          icon="reload"
          size="xs"
          iconSize={11}
          disabled={loading}
          onClick={load}
        />
        {total > 0 ? (
          <Button size="xs" variant="primary" icon="message" disabled={picked === 0} onClick={() => setSending(true)}>
            Send {picked} to agent
          </Button>
        ) : null}
      </header>
      {total > 0 ? (
        <ul className="pr-comment-list">
          {reviews.map((review) => (
            <ReviewItem
              key={review.id}
              review={review}
              checked={!left.has(review.id)}
              onToggle={() => toggle(review.id)}
              onOpen={() => open(review.url)}
            />
          ))}
          {threads.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              checked={!left.has(thread.id)}
              onToggle={() => toggle(thread.id)}
              onOpen={() => open(thread.comments[0]?.url)}
            />
          ))}
        </ul>
      ) : null}
      {sending && result ? (
        <SendToAgentDialog
          label="Send review comments"
          title={`Send ${picked} review comment${picked === 1 ? "" : "s"}`}
          worktree={worktree}
          message={message}
          noAgentMessage={`No agent is running in ${worktree.branch}. Start one with New agent, then send the review comments.`}
          onClose={() => setSending(false)}
          onShowAgent={onShowAgent}
        />
      ) : null}
    </section>
  );
}

function ReviewItem({
  review,
  checked,
  onToggle,
  onOpen,
}: {
  review: PullRequestReviewSummary;
  checked: boolean;
  onToggle(): void;
  onOpen(): void;
}) {
  const title = `Review by ${review.author}`;
  return (
    <li className="pr-comment">
      <input type="checkbox" checked={checked} aria-label={`Include ${title}`} onChange={onToggle} />
      <div className="pr-comment-main">
        <div className="pr-comment-head">
          <span className="pr-comment-location">{title}</span>
          <Badge tone={review.state === "CHANGES_REQUESTED" ? "danger" : "quiet"}>
            {reviewStateText(review.state)}
          </Badge>
          {review.url ? <OpenButton label={`Open ${title} on GitHub`} onOpen={onOpen} /> : null}
        </div>
        <p className="pr-comment-body">{review.body}</p>
      </div>
    </li>
  );
}

function ThreadItem({
  thread,
  checked,
  onToggle,
  onOpen,
}: {
  thread: PullRequestReviewThread;
  checked: boolean;
  onToggle(): void;
  onOpen(): void;
}) {
  const location = threadLocation(thread);
  const [first, ...replies] = thread.comments;
  return (
    <li className="pr-comment">
      <input type="checkbox" checked={checked} aria-label={`Include comment on ${location}`} onChange={onToggle} />
      <div className="pr-comment-main">
        <div className="pr-comment-head">
          <span className="pr-comment-location is-mono" title={location}>
            {location}
          </span>
          {thread.outdated ? <Badge tone="quiet">outdated</Badge> : null}
          {first?.url ? <OpenButton label={`Open comment on ${location} on GitHub`} onOpen={onOpen} /> : null}
        </div>
        {first ? (
          <p className="pr-comment-body">
            <span className="pr-comment-author">{first.author}</span> {first.body}
          </p>
        ) : null}
        {replies.length > 0 ? (
          <span className="pr-comment-replies">
            {replies.length} more repl{replies.length === 1 ? "y" : "ies"}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function OpenButton({ label, onOpen }: { label: string; onOpen(): void }) {
  return (
    <IconButton label={label} tooltip="Open on GitHub" icon="externalLink" size="xs" iconSize={11} onClick={onOpen} />
  );
}
