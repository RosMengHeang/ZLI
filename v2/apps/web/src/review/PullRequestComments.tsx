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
import { formatPullRequestCommentsMessage, reviewStateText, threadLocation } from "./formatPullRequestComments.js";
import { openExternalLink } from "./links.js";
import { commentOnPullRequest, readReviewComments, replyToThread, resolveThread } from "./pullRequestClient.js";
import { refreshPullRequest } from "./pullRequestStore.js";
import { SendToAgentDialog } from "./SendToAgentDialog.js";

/**
 * The pull request's open review threads and written reviews, read from GitHub when the person
 * asks for them. Everything starts selected; unticking leaves an item out of the message. Threads
 * resolved here stay listed as resolved until the comments are read again.
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
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set());
  const [sending, setSending] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [notice, setNotice] = useState<string>();
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
        setResolved(new Set());
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
  const openThreads = threads.filter((thread) => !resolved.has(thread.id));
  const pickedThreads = useMemo(
    () => threads.filter((thread) => !left.has(thread.id) && !resolved.has(thread.id)),
    [threads, left, resolved],
  );
  const pickedReviews = useMemo(() => reviews.filter((review) => !left.has(review.id)), [reviews, left]);
  const picked = pickedThreads.length + pickedReviews.length;
  const total = openThreads.length + reviews.length;
  const listed = threads.length + reviews.length;
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

  const reply = async (thread: PullRequestReviewThread, body: string) => {
    const answer = await replyToThread(dispatch, worktreeId, { threadId: thread.id, body });
    setResult((current) =>
      current
        ? {
            ...current,
            threads: current.threads.map((item) =>
              item.id === thread.id ? { ...item, comments: [...item.comments, answer.comment].slice(-50) } : item,
            ),
          }
        : current,
    );
    void refreshPullRequest(dispatch, worktreeId, true);
  };

  const setThreadResolved = async (thread: PullRequestReviewThread, next: boolean) => {
    const answer = await resolveThread(dispatch, worktreeId, { threadId: thread.id, resolved: next });
    setResolved((current) => {
      const updated = new Set(current);
      if (answer.resolved) updated.add(thread.id);
      else updated.delete(thread.id);
      return updated;
    });
    void refreshPullRequest(dispatch, worktreeId, true);
  };

  const comment = async (body: string) => {
    await commentOnPullRequest(dispatch, worktreeId, body);
    setCommenting(false);
    setNotice(result ? `Comment added to #${result.number}.` : "Comment added.");
    void refreshPullRequest(dispatch, worktreeId, true);
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
          <span className="pr-comments-status" role="status">
            {notice ??
              (total === 0 ? "No open review comments" : `${total} open review comment${total === 1 ? "" : "s"}`)}
          </span>
        )}
        <IconButton
          label="Read review comments again"
          tooltip="Read again"
          icon="reload"
          size="xs"
          iconSize={11}
          disabled={loading}
          onClick={() => {
            setNotice(undefined);
            load();
          }}
        />
        {result ? (
          <Button
            size="xs"
            variant="ghost"
            icon="message"
            aria-expanded={commenting}
            onClick={() => {
              setNotice(undefined);
              setCommenting((value) => !value);
            }}
          >
            Comment
          </Button>
        ) : null}
        {total > 0 ? (
          <Button size="xs" variant="primary" icon="message" disabled={picked === 0} onClick={() => setSending(true)}>
            Send {picked} to agent
          </Button>
        ) : null}
      </header>
      {commenting && result ? (
        <CommentComposer
          label={`Comment on pull request #${result.number}`}
          placeholder="Write a comment for the pull request conversation"
          submitLabel="Add comment"
          onSubmit={comment}
          onCancel={() => setCommenting(false)}
        />
      ) : null}
      {listed > 0 ? (
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
              resolved={resolved.has(thread.id)}
              checked={!left.has(thread.id)}
              onToggle={() => toggle(thread.id)}
              onOpen={() => open(thread.comments[0]?.url)}
              onReply={(body) => reply(thread, body)}
              onResolve={(next) => setThreadResolved(thread, next)}
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
  resolved,
  checked,
  onToggle,
  onOpen,
  onReply,
  onResolve,
}: {
  thread: PullRequestReviewThread;
  resolved: boolean;
  checked: boolean;
  onToggle(): void;
  onOpen(): void;
  onReply(body: string): Promise<void>;
  onResolve(resolved: boolean): Promise<void>;
}) {
  const location = threadLocation(thread);
  const [first, ...replies] = thread.comments;
  const [replying, setReplying] = useState(false);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string>();
  const canReply = !resolved && thread.viewerCanReply !== false;
  const canToggle = resolved ? thread.viewerCanUnresolve !== false : thread.viewerCanResolve !== false;

  const toggleResolved = async () => {
    setChanging(true);
    setError(undefined);
    try {
      await onResolve(!resolved);
      setReplying(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "GitHub did not change the thread.");
    } finally {
      setChanging(false);
    }
  };

  return (
    <li className={`pr-comment${resolved ? " is-resolved" : ""}`}>
      <input
        type="checkbox"
        checked={checked && !resolved}
        disabled={resolved}
        aria-label={`Include comment on ${location}`}
        onChange={onToggle}
      />
      <div className="pr-comment-main">
        <div className="pr-comment-head">
          <span className="pr-comment-location is-mono" title={location}>
            {location}
          </span>
          {resolved ? <Badge tone="success">Resolved</Badge> : null}
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
        {canReply || canToggle ? (
          <div className="pr-comment-actions">
            {canReply && !replying ? (
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Reply on ${location}`}
                onClick={() => {
                  setError(undefined);
                  setReplying(true);
                }}
              >
                Reply
              </Button>
            ) : null}
            {canToggle ? (
              <Button
                size="xs"
                variant="ghost"
                aria-label={`${resolved ? "Unresolve" : "Resolve"} thread on ${location}`}
                loading={changing}
                onClick={() => void toggleResolved()}
              >
                {resolved ? "Unresolve" : "Resolve"}
              </Button>
            ) : null}
          </div>
        ) : null}
        {replying && canReply ? (
          <CommentComposer
            label={`Reply on ${location}`}
            placeholder="Write a reply"
            submitLabel="Reply"
            onSubmit={async (body) => {
              await onReply(body);
              setReplying(false);
            }}
            onCancel={() => setReplying(false)}
          />
        ) : null}
        {error ? (
          <p className="inline-error pr-error" role="alert">
            <Icon name="alert" size={13} />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    </li>
  );
}

/** A small text box that sends on Mod+Enter and shows the failure under itself. */
function CommentComposer({
  label,
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  label: string;
  placeholder: string;
  submitLabel: string;
  onSubmit(body: string): Promise<void>;
  onCancel(): void;
}) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    if (!body.trim() || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await onSubmit(body.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "GitHub did not take the comment.");
      setSending(false);
    }
  };

  return (
    <form
      className="pr-comment-form"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        className="textarea"
        aria-label={label}
        placeholder={placeholder}
        rows={2}
        // biome-ignore lint/a11y/noAutofocus: the box opens because the person asked to write.
        autoFocus
        value={body}
        disabled={sending}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      {error ? (
        <p className="inline-error pr-error" role="alert">
          <Icon name="alert" size={13} />
          <span>{error}</span>
        </p>
      ) : null}
      <div className="pr-comment-form-actions">
        <Button size="xs" variant="ghost" disabled={sending} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          variant="primary"
          type="submit"
          shortcut="Mod+Enter"
          loading={sending}
          disabled={!body.trim()}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function OpenButton({ label, onOpen }: { label: string; onOpen(): void }) {
  return (
    <IconButton label={label} tooltip="Open on GitHub" icon="externalLink" size="xs" iconSize={11} onClick={onOpen} />
  );
}
