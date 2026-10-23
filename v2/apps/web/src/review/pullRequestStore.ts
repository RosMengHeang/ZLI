import type { PullRequestInfo, PullRequestStatusResult } from "@zli-v2/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { type Dispatch, pullRequestStatus } from "./pullRequestClient.js";

export type PullRequestEntry = {
  status?: PullRequestStatusResult;
  error?: string;
  checking: boolean;
  checkedAt?: number;
};

// Shared by the sidebar and the Changes panel so both show the same answer from one GitHub lookup.
let entries: ReadonlyMap<string, PullRequestEntry> = new Map();
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<void>>();
const latestRequest = new Map<string, number>();
let requestCount = 0;

function setEntry(worktreeId: string, entry: PullRequestEntry): void {
  const next = new Map(entries);
  next.set(worktreeId, entry);
  entries = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePullRequestEntry(worktreeId: string | undefined): PullRequestEntry | undefined {
  return useSyncExternalStore(subscribe, () => (worktreeId ? entries.get(worktreeId) : undefined));
}

/** Every known entry, for lists like the sidebar that read many worktrees at once. */
export function usePullRequestEntries(): ReadonlyMap<string, PullRequestEntry> {
  return useSyncExternalStore(subscribe, () => entries);
}

export function pullRequestEntry(worktreeId: string): PullRequestEntry | undefined {
  return entries.get(worktreeId);
}

/**
 * Asks the runtime for the branch's pull request. A lookup already running is reused unless `force`
 * is set, which starts a new one whose answer wins, for example after a commit.
 */
export function refreshPullRequest(dispatch: Dispatch, worktreeId: string, force = false): Promise<void> {
  const running = inFlight.get(worktreeId);
  if (running && !force) return running;
  const request = ++requestCount;
  latestRequest.set(worktreeId, request);
  const current = entries.get(worktreeId);
  setEntry(worktreeId, { ...current, checking: true });
  const isLatest = () => latestRequest.get(worktreeId) === request;
  const task = pullRequestStatus(dispatch, worktreeId)
    .then(
      (status) => {
        if (isLatest()) setEntry(worktreeId, { status, checking: false, checkedAt: Date.now() });
      },
      (cause: unknown) => {
        if (!isLatest()) return;
        const previous = entries.get(worktreeId);
        setEntry(worktreeId, {
          ...(previous?.status ? { status: previous.status } : {}),
          error: cause instanceof Error ? cause.message : "Checking failed.",
          checking: false,
          checkedAt: Date.now(),
        });
      },
    )
    .finally(() => {
      if (inFlight.get(worktreeId) === task) inFlight.delete(worktreeId);
    });
  inFlight.set(worktreeId, task);
  return task;
}

/** Records a pull request the person just created, so every view shows it before the next lookup. */
export function recordPullRequest(worktreeId: string, pullRequest: PullRequestInfo): void {
  const current = entries.get(worktreeId);
  if (!current?.status) return;
  setEntry(worktreeId, { ...current, status: { ...current.status, pullRequest } });
}

const PENDING_CHECKS_MS = 30_000;
const OPEN_MS = 2 * 60_000;
const QUIET_MS = 5 * 60_000;
const TICK_MS = 15_000;

/** How long an answer stays fresh: checks still running are looked at again soon, quiet branches rarely. */
export function staleAfter(entry: PullRequestEntry): number {
  const pullRequest = entry.status?.pullRequest;
  if (entry.error || entry.status?.problem || !pullRequest || pullRequest.state !== "OPEN") return QUIET_MS;
  return pullRequest.checks?.some((check) => check.state === "pending") ? PENDING_CHECKS_MS : OPEN_MS;
}

/** Keeps pull request and check status current for the given worktrees while the window is visible. */
export function usePullRequestPolling(dispatch: Dispatch, worktreeIds: readonly string[]): void {
  const key = worktreeIds.join("\n");
  useEffect(() => {
    const ids = key ? key.split("\n") : [];
    if (ids.length === 0) return;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      for (const id of ids) {
        const entry = entries.get(id);
        if (entry?.checking) continue;
        if (!entry?.checkedAt || now - entry.checkedAt >= staleAfter(entry)) void refreshPullRequest(dispatch, id);
      }
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [dispatch, key]);
}

export function resetPullRequestStoreForTests(): void {
  entries = new Map();
  inFlight.clear();
  latestRequest.clear();
}
