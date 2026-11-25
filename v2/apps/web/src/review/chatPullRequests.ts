import type { PullRequestInfo, ThreadMessageProjection } from "@zli-v2/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { type Dispatch, lookupPullRequests } from "./pullRequestClient.js";

/** A pull request link as an agent writes it in a reply. */
const PULL_REQUEST_LINK = /https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+/gu;
const MOST = 30;
/** How long a lookup stays fresh; the views read it again after that while they show. */
const FRESH_MS = 90_000;

/**
 * The pull requests a chat's agents linked in their replies, newest first, each once. A chat that opened a stack of
 * pull requests on several branches lists them all, not only the one on its own branch.
 */
export function chatPullRequestLinks(
  messages: readonly ThreadMessageProjection[] | undefined,
  threadIds: ReadonlySet<string>,
): string[] {
  const links: string[] = [];
  for (const message of messages ?? []) {
    if (!threadIds.has(message.threadId) || (message.role !== "assistant" && message.role !== "agent")) continue;
    for (const match of message.text.matchAll(PULL_REQUEST_LINK)) links.push(match[0]);
  }
  const seen = new Set<string>();
  const newest: string[] = [];
  for (const link of links.reverse()) {
    if (seen.has(link)) continue;
    seen.add(link);
    newest.push(link);
    if (newest.length === MOST) break;
  }
  return newest;
}

type Entry = { pullRequests: readonly PullRequestInfo[]; checkedAt: number; checking: boolean };

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const EMPTY: readonly PullRequestInfo[] = [];

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function refresh(dispatch: Dispatch, worktreeId: string, links: readonly string[], key: string): void {
  const current = entries.get(key);
  if (current?.checking || (current && Date.now() - current.checkedAt < FRESH_MS)) return;
  entries.set(key, {
    pullRequests: current?.pullRequests ?? EMPTY,
    checkedAt: current?.checkedAt ?? 0,
    checking: true,
  });
  void lookupPullRequests(dispatch, worktreeId, links)
    .then((result) => {
      entries.set(key, { pullRequests: result.pullRequests, checkedAt: Date.now(), checking: false });
    })
    .catch(() => {
      entries.set(key, { pullRequests: current?.pullRequests ?? EMPTY, checkedAt: Date.now(), checking: false });
    })
    .finally(notify);
}

/** The chat's linked pull requests with their state and checks, read again every minute and a half while shown. */
export function useChatPullRequests(
  dispatch: Dispatch,
  worktreeId: string | undefined,
  links: readonly string[],
): readonly PullRequestInfo[] {
  const key = worktreeId && links.length > 0 ? `${worktreeId}\n${links.join("\n")}` : "";
  const pullRequests = useSyncExternalStore(
    subscribe,
    () => (key ? (entries.get(key)?.pullRequests ?? EMPTY) : EMPTY),
    () => EMPTY,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the worktree and the links.
  useEffect(() => {
    if (!key || !worktreeId) return;
    refresh(dispatch, worktreeId, links, key);
    const timer = setInterval(() => refresh(dispatch, worktreeId, links, key), FRESH_MS);
    return () => clearInterval(timer);
  }, [key, dispatch]);
  return pullRequests;
}

/** The worst state across a stack: a failed check anywhere, then checks still running, then all passed. */
export function stackState(pullRequests: readonly PullRequestInfo[]): "failed" | "pending" | "passed" | "none" {
  let worst: "failed" | "pending" | "passed" | "none" = "none";
  for (const pullRequest of pullRequests) {
    if (pullRequest.state !== "OPEN") continue;
    const checks = (pullRequest.checks ?? []).filter((check) => check.state !== "skipped");
    if (checks.some((check) => check.state === "failed")) return "failed";
    if (checks.some((check) => check.state === "pending")) worst = "pending";
    else if (checks.length > 0 && worst === "none") worst = "passed";
  }
  return worst;
}

export function resetChatPullRequestsForTests(): void {
  entries.clear();
}
