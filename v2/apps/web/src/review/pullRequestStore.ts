import type { PullRequestInfo, PullRequestStatusResult, RuntimeProjection } from "@zli-v2/contracts";
import { useEffect, useRef, useSyncExternalStore } from "react";

import { useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { type Dispatch, pullRequestStatus } from "./pullRequestClient.js";

export type PullRequestEntry = {
  status?: PullRequestStatusResult;
  error?: string;
  checking: boolean;
  checkedAt?: number;
};

const SAVED_KEY = "zli.pullRequests.lastKnown";

/**
 * The last answer for each worktree from the previous run. It shows at once on start, with no checkedAt, so the
 * first poll looks it up again; the Pull requests page no longer waits on GitHub before it lists anything.
 */
function readSaved(): Map<string, PullRequestEntry> {
  try {
    const raw = typeof window === "undefined" ? null : window.localStorage.getItem(SAVED_KEY);
    if (!raw) return new Map();
    const saved = JSON.parse(raw) as Record<string, PullRequestStatusResult>;
    return new Map(Object.entries(saved).map(([id, status]) => [id, { status, checking: false }]));
  } catch {
    return new Map();
  }
}

function writeSaved(): void {
  try {
    const saved: Record<string, PullRequestStatusResult> = {};
    for (const [id, entry] of entries) if (entry.status?.pullRequest) saved[id] = entry.status;
    window.localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
  } catch {
    // Without storage the list fills in from GitHub as before.
  }
}

// Shared by the sidebar and the Changes panel so both show the same answer from one GitHub lookup.
let entries: ReadonlyMap<string, PullRequestEntry> = readSaved();
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<void>>();
const latestRequest = new Map<string, number>();
let requestCount = 0;

function setEntry(worktreeId: string, entry: PullRequestEntry): void {
  const next = new Map(entries);
  next.set(worktreeId, entry);
  entries = next;
  if (entry.status && !entry.checking) writeSaved();
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
const PUSHED_MS = 60_000;
const QUIET_MS = 5 * 60_000;
const TICK_MS = 15_000;

/** How long an answer stays fresh: checks still running are looked at again soon, quiet branches rarely. */
export function staleAfter(entry: PullRequestEntry): number {
  const status = entry.status;
  const pullRequest = status?.pullRequest;
  if (entry.error || status?.problem) return QUIET_MS;
  if (!pullRequest) {
    // A pushed branch with its own commits is the one most likely to get a pull request opened on GitHub.
    const pushed = status?.upstream && !status.upstream.gone && (status.commitsAhead ?? 0) > 0;
    return pushed ? PUSHED_MS : QUIET_MS;
  }
  if (pullRequest.state !== "OPEN") return QUIET_MS;
  const checks = pullRequest.checks ?? [];
  // A new pull request has no checks until CI picks it up, so it is looked at again soon too.
  return checks.length === 0 || checks.some((check) => check.state === "pending") ? PENDING_CHECKS_MS : OPEN_MS;
}

/** A command after which the branch's pull request or its checks likely changed. */
const PULL_REQUEST_COMMAND = /\bgh\s+pr\s+(?:create|merge|close|reopen|ready|edit)\b|\bgit\s+push\b/u;
const PULL_REQUEST_LINK = /https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+/u;
/** A second look after a push or a new pull request, once CI has had time to register its checks. */
const FOLLOW_UP_MS = 15_000;

/**
 * One line per agent step that should refresh a worktree's pull request: a finished `gh pr create`, `gh pr merge`,
 * or `git push`, or a reply that links a pull request. Each line is "worktreeId id".
 */
export function pullRequestTriggers(
  projection: Pick<RuntimeProjection, "threads" | "activities" | "messages"> | undefined,
): string {
  if (!projection) return "";
  const worktreeOf = new Map(projection.threads.map((thread) => [thread.threadId, thread.worktreeId]));
  const lines: string[] = [];
  for (const activity of projection.activities ?? []) {
    if (activity.kind !== "command" || activity.status !== "completed") continue;
    if (!PULL_REQUEST_COMMAND.test(activity.command ?? activity.title)) continue;
    const worktreeId = worktreeOf.get(activity.threadId);
    if (worktreeId) lines.push(`${worktreeId} ${activity.activityId}`);
  }
  for (const message of projection.messages ?? []) {
    if (message.role !== "assistant" || !message.text.includes("/pull/") || !PULL_REQUEST_LINK.test(message.text)) {
      continue;
    }
    const worktreeId = worktreeOf.get(message.threadId);
    if (worktreeId) lines.push(`${worktreeId} ${message.messageId}`);
  }
  return lines.join("\n");
}

/**
 * Re-checks a worktree's pull request as soon as one of its agents opens, merges, or pushes to it, so a pull
 * request an agent opened shows at once instead of on the next poll. Steps already there on mount do nothing.
 */
export function usePullRequestTriggers(dispatch: Dispatch): void {
  const key = useRuntimeSelector(pullRequestTriggers);
  const seen = useRef<Set<string> | undefined>(undefined);
  useEffect(() => {
    const lines = key ? key.split("\n") : [];
    if (!seen.current) {
      seen.current = new Set(lines);
      return;
    }
    const worktrees = new Set<string>();
    for (const line of lines) {
      if (seen.current.has(line)) continue;
      seen.current.add(line);
      const worktreeId = line.slice(0, line.indexOf(" "));
      if (worktreeId) worktrees.add(worktreeId);
    }
    for (const worktreeId of worktrees) {
      void refreshPullRequest(dispatch, worktreeId, true);
      setTimeout(() => void refreshPullRequest(dispatch, worktreeId, true), FOLLOW_UP_MS);
    }
  }, [dispatch, key]);
}

/** Keeps pull request and check status current for the given worktrees while the window is visible. */
export function usePullRequestPolling(dispatch: Dispatch, worktreeIds: readonly string[]): void {
  const key = worktreeIds.join("\n");
  useEffect(() => {
    const ids = key ? key.split("\n") : [];
    if (ids.length === 0) return;
    const tick = () => {
      // No document once the page is gone (a test's teardown); nothing is shown, so nothing is checked.
      if (typeof document === "undefined" || document.visibilityState === "hidden") return;
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
  try {
    window.localStorage.removeItem(SAVED_KEY);
  } catch {
    // No storage in this test environment.
  }
  inFlight.clear();
  latestRequest.clear();
}
