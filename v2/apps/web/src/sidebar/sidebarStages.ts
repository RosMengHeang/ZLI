import { describeApproval, describeQuestions } from "@zli-v2/client-runtime";
import type { PullRequestInfo, ReviewProjection, ThreadRequestProjection } from "@zli-v2/contracts";

import type { PullRequestEntry } from "../review/pullRequestStore.js";
import { type AgentSession, type SessionStatus, sessionStatusLabel } from "../sessions/sessions.js";

/** How close a branch is to shipping, in the order the Branches style lists them. */
export type BranchStage = "attention" | "working" | "review" | "ready" | "noGit" | "merged" | "quiet";

/** What needs the person comes first. The two groups with nothing left to do come last and start folded. */
export const branchStages: readonly BranchStage[] = [
  "attention",
  "working",
  "review",
  "ready",
  "noGit",
  "merged",
  "quiet",
];

export const foldedStages: ReadonlySet<BranchStage> = new Set(["merged", "quiet"]);

export const branchStageLabel: Record<BranchStage, string> = {
  attention: "Needs you",
  working: "Working",
  review: "In review",
  ready: "Ready to merge",
  noGit: "Folders without Git",
  merged: "Merged",
  quiet: "No changes",
};

const liveStatuses: ReadonlySet<SessionStatus> = new Set(["preparing", "starting", "working", "waiting", "failed"]);

/** An agent that is running or needs the person. */
export function sessionIsLive(session: Pick<AgentSession, "status">): boolean {
  return liveStatuses.has(session.status);
}

/** An agent that cannot go on until the person answers it or looks at what went wrong. */
export function sessionNeedsPerson(session: Pick<AgentSession, "status">): boolean {
  return session.status === "waiting" || session.status === "failed";
}

/** Open, not a draft, and nothing GitHub would hold the merge back for. */
export function readyToMerge(pullRequest: PullRequestInfo | undefined): boolean {
  if (pullRequest?.state !== "OPEN" || pullRequest.isDraft) return false;
  if (pullRequest.reviewDecision === "CHANGES_REQUESTED" || pullRequest.reviewDecision === "REVIEW_REQUIRED") {
    return false;
  }
  return !(pullRequest.checks ?? []).some((check) => check.state === "failed" || check.state === "pending");
}

export type BranchStageInput = {
  /** False only for a folder that is not a Git repository. */
  git: boolean;
  sessions: readonly Pick<AgentSession, "status">[];
  /** The worktree is being created, failed, or waits on the person. */
  worktreeBusy: boolean;
  /** The worktree failed or waits on the person. */
  worktreeNeedsPerson: boolean;
  /** Changed files, from the review data or the pull request lookup. */
  changedFiles: number;
  pullRequest: PullRequestInfo | undefined;
};

/**
 * What needs the person wins over everything, a folder without Git included, so it is never buried.
 * A live agent wins over the pull request, so Merge is not offered while it may still push to the branch.
 */
export function branchStage({
  git,
  sessions,
  worktreeBusy,
  worktreeNeedsPerson,
  changedFiles,
  pullRequest,
}: BranchStageInput): BranchStage {
  if (worktreeNeedsPerson || sessions.some(sessionNeedsPerson)) return "attention";
  if (!git) return "noGit";
  if (worktreeBusy || sessions.some(sessionIsLive)) return "working";
  if (pullRequest?.state === "OPEN") return readyToMerge(pullRequest) ? "ready" : "review";
  if (pullRequest?.state === "MERGED") return "merged";
  return changedFiles > 0 ? "working" : "quiet";
}

/**
 * What a waiting agent is asking, in the words its row can show. Undefined when the agent has not said,
 * as with an agent in a terminal, so the row falls back to the plain status.
 */
export function waitingQuestion(
  session: Pick<AgentSession, "provider" | "thread">,
  requests: readonly ThreadRequestProjection[] | undefined,
): string | undefined {
  const threadId = session.thread?.threadId;
  const request = threadId ? requests?.find((entry) => entry.threadId === threadId) : undefined;
  if (!request) return undefined;
  const text =
    request.kind === "approval"
      ? describeApproval(session.provider, request.payload).title
      : describeQuestions(request.payload)[0]?.question;
  return text?.trim() || undefined;
}

/**
 * What an agent's own row should say instead of its branch: its question, that it failed, or, once it has
 * stopped, what is holding its pull request back. Leave `pullRequest` out for a sub-agent, whose lead speaks
 * for the branch.
 */
export function agentNote(
  session: Pick<AgentSession, "provider" | "status" | "thread">,
  requests: readonly ThreadRequestProjection[] | undefined,
  pullRequest: PullRequestInfo | undefined,
): { text: string; tone: "waiting" | "failed" } | undefined {
  if (session.status === "waiting") {
    return { text: waitingQuestion(session, requests) ?? sessionStatusLabel.waiting, tone: "waiting" };
  }
  if (session.status === "failed") return { text: sessionStatusLabel.failed, tone: "failed" };
  if (sessionIsLive(session) || pullRequest?.state !== "OPEN") return undefined;
  const held = reviewDetail(pullRequest);
  return held.tone === "danger" ? { text: held.text, tone: "failed" } : undefined;
}

/** A branch's name without its folder, such as fix/ or zli/, since width is tight and the rest tells rows apart. */
export function shortBranchName(branch: string): string {
  return branch.slice(branch.lastIndexOf("/") + 1) || branch;
}

/** What stands beside a pull request's number: how its checks went, or that it merged. */
export function pullRequestMark(pullRequest: PullRequestInfo): {
  icon: "check" | "x" | "merge" | "pullRequest";
  tone: "success" | "danger" | "warning" | "quiet";
  label: string;
} {
  if (pullRequest.state === "MERGED") return { icon: "merge", tone: "quiet", label: "merged" };
  const checks = pullRequest.checks ?? [];
  if (checks.some((check) => check.state === "failed")) return { icon: "x", tone: "danger", label: "checks failed" };
  if (checks.some((check) => check.state === "pending")) {
    return { icon: "pullRequest", tone: "warning", label: "checks running" };
  }
  return checks.length > 0
    ? { icon: "check", tone: "success", label: "checks passed" }
    : { icon: "pullRequest", tone: "quiet", label: "no checks" };
}

/** Line totals for a branch. Undefined when there is no review data or no text lines changed, so nothing is guessed. */
export function diffTotals(
  review: Pick<ReviewProjection, "files"> | undefined,
): { additions: number; deletions: number } | undefined {
  if (!review) return undefined;
  const additions = review.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = review.files.reduce((sum, file) => sum + file.deletions, 0);
  return additions + deletions > 0 ? { additions, deletions } : undefined;
}

/**
 * Greater than zero when a branch holds work its base does not have. Review data covers committed and
 * uncommitted files; without it, the pull request lookup counts both sides of that.
 */
export function changedFileCount(
  review: Pick<ReviewProjection, "files"> | undefined,
  entry: PullRequestEntry | undefined,
): number {
  return review?.files.length ?? (entry?.status?.uncommittedFiles ?? 0) + (entry?.status?.commitsAhead ?? 0);
}

/** Says what is holding an open pull request back, for its row in the Branches style. */
export function reviewDetail(pullRequest: PullRequestInfo): { text: string; tone: "danger" | "warning" | "quiet" } {
  const checks = pullRequest.checks ?? [];
  const failed = checks.filter((check) => check.state === "failed").length;
  if (failed > 0) return { text: `${failed} check${failed === 1 ? "" : "s"} failed`, tone: "danger" };
  if (pullRequest.reviewDecision === "CHANGES_REQUESTED") return { text: "Changes requested", tone: "danger" };
  if (checks.some((check) => check.state === "pending")) return { text: "Checks running", tone: "warning" };
  if (pullRequest.isDraft) return { text: "Draft", tone: "quiet" };
  if (pullRequest.reviewDecision === "REVIEW_REQUIRED") return { text: "Review required", tone: "quiet" };
  return { text: "Open", tone: "quiet" };
}

/** Why GitHub could not be asked, once per reason, for the note under the Branches list. */
export function pullRequestProblems(entries: Iterable<PullRequestEntry | undefined>): string[] {
  const problems = new Set<string>();
  for (const entry of entries) {
    const problem = entry?.status?.problem;
    // A checkout with no origin or a detached head is ordinary; only trouble reaching GitHub hides Merge everywhere.
    if (problem && problem.code !== "detached" && problem.code !== "no_origin") problems.add(problem.message);
  }
  return [...problems];
}

/**
 * The live count a project shows. What needs the person comes first, so a project whose only news is a failed
 * agent still says so.
 */
export function railBadge(
  sessions: readonly Pick<AgentSession, "status">[],
): { count: number; tone: "waiting" | "failed" | "working" } | undefined {
  const waiting = sessions.filter((session) => session.status === "waiting").length;
  if (waiting > 0) return { count: waiting, tone: "waiting" };
  const failed = sessions.filter((session) => session.status === "failed").length;
  if (failed > 0) return { count: failed, tone: "failed" };
  const working = sessions.filter(
    (session) => session.status === "working" || session.status === "starting" || session.status === "preparing",
  ).length;
  return working > 0 ? { count: working, tone: "working" } : undefined;
}

/** Splits a project's top-level agents for the rail's list. `recent` is capped; the rest fold away as earlier. */
export function splitActive<T extends { sessionId: string; updatedAt?: string | undefined }>(
  agents: readonly T[],
  isActive: (agent: T) => boolean,
  recentLimit = 3,
): { active: T[]; recent: T[]; earlier: T[] } {
  const active = agents.filter(isActive);
  const rest = agents
    .filter((agent) => !isActive(agent))
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
  return { active, recent: rest.slice(0, recentLimit), earlier: rest.slice(recentLimit) };
}

/** A project's characters from its first letter or digit on, so a name like ".dotfiles" still reads as D. */
function tileCharacters(name: string): string[] {
  const characters = Array.from(name);
  const start = characters.findIndex((character) => /[\p{L}\p{N}]/u.test(character));
  return start > 0 ? characters.slice(start) : characters;
}

/** One letter per rail tile, or two where projects share a first letter, so no two tiles look alike by accident. */
export function railTileLabels(names: readonly string[]): string[] {
  const first = (name: string) => (tileCharacters(name)[0] ?? "").toLocaleUpperCase();
  return names.map((name) => {
    const initial = first(name);
    if (names.filter((other) => first(other) === initial).length < 2) return initial;
    return `${initial}${tileCharacters(name)[1] ?? ""}`;
  });
}
