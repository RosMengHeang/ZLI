import type { PullRequestInfo, RuntimeProjection } from "@zli-v2/contracts";
import { useMemo, useState } from "react";

import { checksSummary } from "../chat/ChatExtras.js";
import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { type AgentSession, conversationThreads } from "../sessions/sessions.js";
import { Icon } from "../ui/Icon.js";
import { chatPullRequestLinks, stackState, useChatPullRequests } from "./chatPullRequests.js";
import { openExternalLink } from "./links.js";
import "./review.css";

const selectMessages = (projection: RuntimeProjection | undefined) => projection?.messages;

/** The pull requests a chat's agents linked, read for their state and checks. */
function useSessionPullRequests(session: AgentSession | undefined): readonly PullRequestInfo[] {
  const { dispatch } = useRuntime();
  const messages = useRuntimeSelector(selectMessages);
  const links = useMemo(() => {
    if (!session?.thread) return [];
    const chain = new Set(conversationThreads(session.thread, session.threads).map((thread) => thread.threadId));
    return chatPullRequestLinks(messages, chain);
  }, [messages, session?.thread, session?.threads]);
  return useChatPullRequests(dispatch, session?.worktreeId, links);
}

function checksLine(pullRequest: PullRequestInfo): { text: string; tone: string } {
  if (pullRequest.state === "MERGED") return { text: "Merged", tone: "merged" };
  if (pullRequest.state === "CLOSED") return { text: "Closed", tone: "closed" };
  const checks = checksSummary(pullRequest);
  if (checks.state === "failed")
    return { text: `${checks.total - checks.failed}/${checks.total} checks`, tone: "failed" };
  if (checks.state === "pending") return { text: "Checks running", tone: "pending" };
  if (checks.state === "passed") return { text: "Checks passed", tone: "passed" };
  return { text: pullRequest.isDraft ? "Draft" : "Open", tone: "open" };
}

/**
 * Every pull request the chat opened, in the computer column: the newest first, the rest one click away. Each shows
 * its title, number, and checks; one with a failing check links straight to it.
 */
export function ChatPullRequestStack({ session }: { session: AgentSession | undefined }) {
  const { bridge } = useRuntime();
  const pullRequests = useSessionPullRequests(session);
  const [open, setOpen] = useState(false);
  if (pullRequests.length < 2) return null;
  const shown = open ? pullRequests : pullRequests.slice(0, 1);
  const openLink = (url: string) => {
    if (bridge) void openExternalLink(bridge, url);
  };
  return (
    <section className="pr-stack" aria-label={`${pullRequests.length} pull requests from this chat`}>
      <ul className="pr-stack-list">
        {shown.map((pullRequest) => {
          const line = checksLine(pullRequest);
          const failing = (pullRequest.checks ?? []).find((check) => check.state === "failed");
          return (
            <li key={pullRequest.url} className={`pr-stack-item is-${line.tone}`}>
              <button type="button" className="pr-stack-open" onClick={() => openLink(pullRequest.url)}>
                <Icon name={pullRequest.state === "MERGED" ? "merge" : "pullRequest"} size={14} />
                <span className="pr-stack-title">{pullRequest.title ?? `Pull request #${pullRequest.number}`}</span>
              </button>
              <span className="pr-stack-meta">
                <span className="pr-stack-number">#{pullRequest.number}</span>
                <span className="pr-stack-checks">
                  {line.tone === "failed" ? <Icon name="x" size={11} /> : null}
                  {line.text}
                </span>
                {failing ? (
                  <button
                    type="button"
                    className="pr-stack-fix"
                    aria-label={`Open the failing check ${failing.name} of #${pullRequest.number}`}
                    onClick={() => openLink(failing.url ?? pullRequest.url)}
                  >
                    Fix
                    <Icon name="arrowUpRight" size={11} />
                  </button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      {pullRequests.length > 1 ? (
        <button type="button" className="pr-stack-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? "chevronUp" : "chevronDown"} size={12} />
          {open ? "Show less" : `Show ${pullRequests.length - 1} more`}
        </button>
      ) : null}
    </section>
  );
}

/** A chat with several pull requests, in the Recent list: a stack with their count, coloured by the worst checks. */
export function ChatPullRequestMark({ session }: { session: AgentSession }) {
  const pullRequests = useSessionPullRequests(session);
  if (pullRequests.length < 2) return null;
  const state = stackState(pullRequests);
  return (
    <span
      className={`pr-stack-mark is-${state}`}
      title={`${pullRequests.length} pull requests${state === "failed" ? ", a check failed" : state === "pending" ? ", checks running" : ""}`}
    >
      <Icon name="stack" size={12} />
      {pullRequests.length}
    </span>
  );
}
