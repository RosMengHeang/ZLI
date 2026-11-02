import {
  type FileDiffResult,
  FileDiffResult as FileDiffResultSchema,
  GitBranchesResult,
  type GitUpstream,
  PullRequestPushResult,
  type ReviewFileProjection,
  type ReviewProjection,
  type RuntimeProjection,
} from "@zli-v2/contracts";

import { type CommandOutcome, sendCommand } from "./launch.js";
import type { LinkSnapshot, RemoteLink } from "./link.js";
import type { Tone } from "./views.js";

type ChangesLink = Pick<RemoteLink, "command" | "getSnapshot" | "subscribe">;

/** Git answers a refresh or a commit through a new review in the projection; past this the phone stops waiting. */
export const GIT_ANSWER_TIMEOUT_MS = 60_000;
/** Lines past this stay on the desktop, so a huge diff does not freeze the phone. */
export const DIFF_LINE_LIMIT = 1_500;
/** Characters of one line past this are cut, since a minified file can put a whole bundle on one line. */
export const DIFF_LINE_CHARS = 400;

export type StageState = "staged" | "unstaged" | "partial" | "committed";

/** As on the desktop: committed means the file differs from the base only through commits. */
export function stageStateOf(file: ReviewFileProjection): StageState {
  const unstaged = file.unstaged ?? !file.staged;
  return file.staged && unstaged ? "partial" : file.staged ? "staged" : unstaged ? "unstaged" : "committed";
}

export function reviewFor(
  projection: Pick<RuntimeProjection, "reviews"> | undefined,
  worktreeId: string,
): ReviewProjection | undefined {
  return projection?.reviews?.find((review) => review.worktreeId === worktreeId);
}

/** Reads the changes again against the base the desktop already compares against, or the last commit. */
export function refreshCommand(worktreeId: string, review: Pick<ReviewProjection, "baseRef"> | undefined) {
  return { type: "review.refresh" as const, worktreeId, baseRef: review?.baseRef ?? "HEAD" };
}

export type ChangeTotals = { files: number; additions: number; deletions: number };

export function changeTotals(files: readonly ReviewFileProjection[]): ChangeTotals {
  return files.reduce(
    (sum, file) => ({
      files: sum.files + 1,
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function plural(value: number, word: string): string {
  return `${count(value)} ${word}${value === 1 ? "" : "s"}`;
}

/** "+12 −3 in 4 files", the way the desktop's Environment popover counts lines. */
export function totalsLabel(totals: ChangeTotals): string {
  if (totals.files === 0) return "No changes";
  return `+${count(totals.additions)} −${count(totals.deletions)} in ${plural(totals.files, "file")}`;
}

/** The same totals in words, for screen readers. */
export function spokenTotals(totals: ChangeTotals): string {
  if (totals.files === 0) return "No changes";
  return `${plural(totals.additions, "line")} added and ${count(totals.deletions)} removed in ${plural(totals.files, "file")}`;
}

export type FileKindView = { letter: string; label: string; tone: Tone };

export function fileKind(file: Pick<ReviewFileProjection, "kind">): FileKindView {
  switch (file.kind) {
    case "added":
      return { letter: "A", label: "Added", tone: "green" };
    case "untracked":
      return { letter: "U", label: "New, not tracked yet", tone: "green" };
    case "modified":
      return { letter: "M", label: "Modified", tone: "amber" };
    case "renamed":
      return { letter: "R", label: "Renamed", tone: "amber" };
    case "deleted":
      return { letter: "D", label: "Deleted", tone: "red" };
  }
}

/** The file name and the folder it sits in. Git lists a new folder with a trailing slash. */
export function splitPath(path: string): { name: string; folder: string } {
  const trimmed = path.replace(/\/+$/u, "");
  const slash = trimmed.lastIndexOf("/");
  return slash < 0
    ? { name: trimmed, folder: "" }
    : { name: trimmed.slice(slash + 1), folder: trimmed.slice(0, slash) };
}

/** Why a file's diff cannot be shown on the phone, or undefined when it can. */
export function diffUnavailable(
  file: ReviewFileProjection,
  review: Pick<ReviewProjection, "baseRef">,
): string | undefined {
  if (file.path.endsWith("/")) return "New folder";
  if (file.binary) return "Binary file";
  // The phone reads uncommitted diffs; a file that changed only in commits has none.
  if (stageStateOf(file) === "committed") return `Committed since ${review.baseRef}`;
  return undefined;
}

export type CommitPlan =
  | { kind: "commit"; push: boolean; staged: boolean }
  | { kind: "push"; reason: string }
  | { kind: "none"; reason: string };

function trackDescription(upstream: GitUpstream): string {
  if (upstream.gone) return `${upstream.name} no longer exists.`;
  const parts = [
    upstream.ahead > 0 ? `${plural(upstream.ahead, "commit")} to push` : "",
    upstream.behind > 0 ? `${plural(upstream.behind, "commit")} to pull` : "",
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(", ")} against ${upstream.name}.` : `Up to date with ${upstream.name}.`;
}

/** The one Git action the Changes screen offers, the same one the desktop's Environment popover offers. */
export function commitPlan(review: ReviewProjection | undefined, branches: GitBranchesResult | undefined): CommitPlan {
  // Until the branches are read, origin is assumed; a failed push says why.
  const origin = !branches || branches.remote.length > 0 || !!branches.defaultBranch;
  if (!review) return { kind: "none", reason: "Reading the changes." };
  if (review.state === "conflicted") return { kind: "none", reason: "Finish or abort the merge on the desktop first." };
  const states = review.files.map(stageStateOf);
  const current = branches?.current;
  if (states.some((state) => state !== "committed")) {
    return {
      kind: "commit",
      push: origin && (!branches || !!current),
      staged: states.some((state) => state === "staged" || state === "partial"),
    };
  }
  const upstream = current ? branches?.details?.[current]?.upstream : undefined;
  if (branches && origin && current) {
    if (upstream && !upstream.gone && upstream.ahead > 0) return { kind: "push", reason: trackDescription(upstream) };
    if (!upstream && !branches.remote.includes(current)) {
      return { kind: "push", reason: `${current} is not on origin yet.` };
    }
  }
  return { kind: "none", reason: "No changes to commit." };
}

/** What the commit takes in, for the hint under the button and the confirmation. */
export function commitHint(plan: Extract<CommitPlan, { kind: "commit" }>): string {
  return `${plan.staged ? "Commits only the staged changes" : "Commits every change, new files included"}${
    plan.push ? ", then pushes the branch to origin." : ". There is no origin to push to."
  }`;
}

/** The files a commit takes: the staged ones when something is staged, otherwise every uncommitted one. */
export function filesToCommit(review: ReviewProjection, plan: Extract<CommitPlan, { kind: "commit" }>): number {
  return review.files.filter((file) => {
    const state = stageStateOf(file);
    return plan.staged ? state === "staged" || state === "partial" : state !== "committed";
  }).length;
}

/** Resolves with the first review of the worktree newer than `since`, or undefined after the timeout. */
function nextReview(
  link: Pick<RemoteLink, "getSnapshot" | "subscribe">,
  worktreeId: string,
  since: string | undefined,
  timeoutMs: number,
): { done: Promise<ReviewProjection | undefined>; cancel: () => void } {
  let cancel = () => {};
  const done = new Promise<ReviewProjection | undefined>((resolve) => {
    const check = (snapshot: LinkSnapshot) => {
      const review = reviewFor(snapshot.projection, worktreeId);
      if (review && review.updatedAt !== since) finish(review);
    };
    const finish = (review: ReviewProjection | undefined) => {
      clearTimeout(timer);
      stop();
      resolve(review);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const stop = link.subscribe(() => check(link.getSnapshot()));
    cancel = () => finish(undefined);
  });
  return { done, cancel };
}

/** Asks the desktop to read the worktree's changes again and waits until the new list arrives. */
export async function refreshChanges(
  link: ChangesLink,
  worktreeId: string,
  timeoutMs = GIT_ANSWER_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const current = reviewFor(link.getSnapshot().projection, worktreeId);
  const answer = nextReview(link, worktreeId, current?.updatedAt, timeoutMs);
  const sent = await sendCommand(link, refreshCommand(worktreeId, current), "The changes could not be read.");
  if (!sent.ok) {
    answer.cancel();
    return sent;
  }
  const review = await answer.done;
  if (!review) return { ok: false, error: "The desktop has not sent the changes yet. Try again." };
  return { ok: true };
}

/** Local branches and origin's, or undefined when they could not be read. */
export async function readBranches(link: Pick<RemoteLink, "command">, worktreeId: string) {
  const outcome = await sendCommand(
    link,
    { type: "review.git.branches", worktreeId },
    "The branches could not be read.",
  );
  if (!outcome.ok) return undefined;
  const parsed = GitBranchesResult.safeParse(outcome.result);
  return parsed.success ? parsed.data : undefined;
}

export type GitOutcome = { ok: true; notice: string } | { ok: false; error: string };

function pushedBranch(outcome: Extract<CommandOutcome, { ok: true }>): string | undefined {
  const parsed = PullRequestPushResult.safeParse(outcome.result);
  return parsed.success ? parsed.data.branch : undefined;
}

export async function pushBranch(link: Pick<RemoteLink, "command">, worktreeId: string): Promise<GitOutcome> {
  const pushed = await sendCommand(link, { type: "review.pr.push", worktreeId }, "The push failed.");
  if (!pushed.ok) return pushed;
  const branch = pushedBranch(pushed);
  return { ok: true, notice: branch ? `Pushed ${branch} to origin.` : "Pushed to origin." };
}

/**
 * Commits on the desktop, the way its Environment popover does: the commit is done when Git sends back a
 * new review for the worktree, and with `push` the branch then goes to origin.
 */
export async function commitChanges(
  link: ChangesLink,
  input: { worktreeId: string; message: string; push: boolean; onPushing?: () => void },
  timeoutMs = GIT_ANSWER_TIMEOUT_MS,
): Promise<GitOutcome> {
  const message = input.message.trim();
  if (!message) return { ok: false, error: "Write a commit message first." };
  const since = reviewFor(link.getSnapshot().projection, input.worktreeId)?.updatedAt;
  const answer = nextReview(link, input.worktreeId, since, timeoutMs);
  const sent = await sendCommand(
    link,
    { type: "review.commit", worktreeId: input.worktreeId, message },
    "The commit failed.",
  );
  if (!sent.ok) {
    answer.cancel();
    return sent;
  }
  const review = await answer.done;
  if (!review)
    return { ok: false, error: "Git has not answered the commit yet. Read the changes again to see where it stands." };
  if (review.errorMessage) return { ok: false, error: review.errorMessage };
  if (!input.push) return { ok: true, notice: `Committed to ${review.branch}.` };
  input.onPushing?.();
  const pushed = await sendCommand(link, { type: "review.pr.push", worktreeId: input.worktreeId }, "The push failed.");
  if (!pushed.ok) return { ok: false, error: `Committed, but the push failed. ${pushed.error}` };
  return { ok: true, notice: `Committed and pushed ${pushedBranch(pushed) ?? review.branch} to origin.` };
}

export async function readFileDiff(
  link: Pick<RemoteLink, "command">,
  worktreeId: string,
  path: string,
): Promise<{ ok: true; diff: FileDiffResult } | { ok: false; error: string }> {
  const outcome = await sendCommand(link, { type: "files.diff", worktreeId, path }, "The diff could not be read.");
  if (!outcome.ok) return outcome;
  const parsed = FileDiffResultSchema.safeParse(outcome.result);
  return parsed.success
    ? { ok: true, diff: parsed.data }
    : { ok: false, error: "The desktop sent a diff the phone cannot read. Update ZLI on both and try again." };
}

export type DiffLineKind = "add" | "del" | "context" | "hunk" | "note";
export type DiffLine = { kind: DiffLineKind; text: string; number?: number };
export type ParsedDiff = {
  lines: DiffLine[];
  /** Lines in the whole diff, counting the ones past the limit. */
  total: number;
  /** Some lines past the limit were left out. */
  truncated: boolean;
  /** Some lines were cut at DIFF_LINE_CHARS. */
  clipped: boolean;
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/**
 * Splits a unified diff into lines to draw: the file header is dropped, hunk headers stay, and each line
 * keeps its +, -, or space so it reads without color too. Added and context lines carry their new line
 * number, removed lines their old one.
 */
export function parseDiff(patch: string, limits = { lines: DIFF_LINE_LIMIT, chars: DIFF_LINE_CHARS }): ParsedDiff {
  const raw = patch.split("\n");
  if (raw.at(-1) === "") raw.pop();
  const lines: DiffLine[] = [];
  let total = 0;
  let clipped = false;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  for (const line of raw) {
    const hunk = HUNK.exec(line);
    let entry: DiffLine | undefined;
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      entry = { kind: "hunk", text: line };
    } else if (!inHunk) {
      continue;
    } else if (line.startsWith("+")) {
      entry = { kind: "add", text: line, number: newLine };
      newLine += 1;
    } else if (line.startsWith("-")) {
      entry = { kind: "del", text: line, number: oldLine };
      oldLine += 1;
    } else if (line.startsWith("\\")) {
      entry = { kind: "note", text: line };
    } else if (line.startsWith("diff --git ")) {
      // A second file's header: skip it until its first hunk.
      inHunk = false;
      continue;
    } else {
      entry = { kind: "context", text: line, number: newLine };
      oldLine += 1;
      newLine += 1;
    }
    total += 1;
    if (lines.length >= limits.lines) continue;
    let text = entry.text.replaceAll("\t", "    ").replace(/\r$/u, "");
    if (text.length > limits.chars) {
      text = `${text.slice(0, limits.chars)}…`;
      clipped = true;
    }
    lines.push({ ...entry, text });
  }
  return { lines, total, truncated: total > lines.length, clipped };
}
