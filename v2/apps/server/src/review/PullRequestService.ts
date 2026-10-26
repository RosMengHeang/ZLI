import {
  GitBranchesResult,
  type GitLocalBranch,
  GitPullResult,
  type GitUpstream,
  type PullRequestCheck,
  PullRequestCheckLogResult,
  type PullRequestCheckState,
  type PullRequestCommand,
  PullRequestCommentsResult,
  PullRequestCreateResult,
  PullRequestInfo,
  type PullRequestMergeMethod,
  PullRequestMergeResult,
  type PullRequestProblem,
  PullRequestPushResult,
  PullRequestReplyResult,
  PullRequestResolveResult,
  type PullRequestReviewComment,
  type PullRequestReviewEvent,
  type PullRequestReviewSummary,
  type PullRequestReviewThread,
  PullRequestStatusResult,
  PullRequestUpdateResult,
  type RuntimeProjection,
  type WorktreeProjection,
} from "@zli-v2/contracts";
import { spawnCli } from "@zli-v2/shared";

import { assertRef } from "./ReviewService.js";

export type ProcessResult = { code: number; stdout: string; stderr: string };

/** Runs `git` or `gh` without a shell. Resolves for any exit code; rejects when the program cannot start. */
export type ProcessRunner = (
  command: "git" | "gh",
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; maxOutputBytes?: number; input?: string },
) => Promise<ProcessResult>;

/** A failure the person can act on; the message is shown as is. */
export class PullRequestError extends Error {
  override readonly name = "PullRequestError";
}

export type PullRequestInput = {
  worktreePath: string;
  /** Used when origin does not name a default branch. */
  fallbackBase: string;
};

const GIT_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 120_000;
const GH_TIMEOUT_MS = 60_000;
const LOG_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
// Whole job logs come back even with --log-failed, and the failed step is near the end.
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_LOG_LINES = 150;
const MAX_LOG_CHARS = 30_000;
const MAX_BODY_SUBJECTS = 50;
const GH_READY_MS = 5 * 60_000;
const PR_FIELDS = "url,state,isDraft,number,statusCheckRollup,reviewDecision,autoMergeRequest";
const MAX_THREADS = 100;
const MAX_THREAD_COMMENTS = 50;
const MAX_REVIEWS = 30;
const MAX_BRANCHES = 1_000;
const MAX_COMMENT_CHARS = 20_000;
const MAX_HUNK_LINES = 12;
const BRANCH_FORMAT = "%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(worktreepath)";
const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${MAX_THREADS}) {
        nodes {
          id isResolved isOutdated path line startLine originalLine originalStartLine
          viewerCanReply viewerCanResolve viewerCanUnresolve
          comments(first: ${MAX_THREAD_COMMENTS}) { nodes { id author { login } body url createdAt diffHunk } }
        }
      }
      reviews(last: ${MAX_REVIEWS}) { nodes { id author { login } state body url } }
    }
  }
}`;

const REPLY_MUTATION = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id author { login } body url createdAt }
  }
}`;
const RESOLVE_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;
const UNRESOLVE_MUTATION = `mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;
const REVIEW_FLAGS: Record<PullRequestReviewEvent, string> = {
  APPROVE: "--approve",
  REQUEST_CHANGES: "--request-changes",
  COMMENT: "--comment",
};

export const GH_MISSING =
  "GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com, then check again.";
export const GH_SIGNED_OUT = "GitHub CLI is not signed in. Run gh auth login in a terminal, then check again.";
const NO_ORIGIN = "This repository has no origin remote. Add one with git remote add origin <url>, then check again.";
const DETACHED = "This worktree is not on a branch. Check out a branch to open a pull request from it.";
const NO_PULL_REQUEST = "This branch has no pull request yet.";
const UNREADABLE_PULL_REQUEST = "GitHub CLI returned a pull request ZLI could not read.";
const NOT_ACTIONS = "ZLI can read logs only for GitHub Actions checks. Open the check on GitHub to see why it failed.";

export class PullRequestService {
  /** Status is checked often, so a working GitHub CLI is trusted for a while instead of asked every time. */
  private ghReadyUntil = 0;

  constructor(private readonly runner: ProcessRunner = runProcess) {}

  async status(input: PullRequestInput, requestedBase?: string): Promise<PullRequestStatusResult> {
    const cwd = input.worktreePath;
    const [branch, uncommittedFiles] = await Promise.all([this.currentBranch(cwd), this.uncommittedFiles(cwd)]);
    const base = requestedBase ?? (await this.originDefaultBranch(cwd)) ?? input.fallbackBase;
    assertRef(base);
    const result = (problem: PullRequestProblem | undefined, extra: Partial<PullRequestStatusResult> = {}) =>
      PullRequestStatusResult.parse({
        branch: branch ?? "HEAD",
        uncommittedFiles,
        defaults: { title: branch ?? "", body: "", base },
        ...(problem ? { problem } : {}),
        ...extra,
      });
    if (!branch) return result({ code: "detached", message: DETACHED });
    if (!(await this.hasOrigin(cwd))) return result({ code: "no_origin", message: NO_ORIGIN });

    const [subjects, upstream] = await Promise.all([this.subjectsSince(cwd, base), this.upstreamOf(cwd, branch)]);
    const defaults = {
      title: subjects?.at(-1) ?? branch,
      body: formatBody(subjects ?? []),
      base,
    };
    const extra = {
      defaults,
      ...(subjects ? { commitsAhead: subjects.length } : {}),
      ...(upstream ? { upstream } : {}),
    };

    const problem = await this.ghProblem(cwd);
    if (problem) return result(problem, extra);
    const view = await this.gh(["pr", "view", branch, "--json", PR_FIELDS], cwd);
    if (view.code === 0) {
      const pullRequest = parsePullRequest(view.stdout);
      if (pullRequest) return result(undefined, { ...extra, pullRequest });
      return result({ code: "gh_failed", message: UNREADABLE_PULL_REQUEST }, extra);
    }
    if (/no (open )?pull requests? found/iu.test(view.stderr)) return result(undefined, extra);
    return result({ code: "gh_failed", message: ghFailure("could not look up the pull request", view) }, extra);
  }

  async push(input: PullRequestInput): Promise<PullRequestPushResult> {
    const cwd = input.worktreePath;
    const branch = await this.currentBranch(cwd);
    if (!branch) throw new PullRequestError(DETACHED);
    const uncommitted = await this.uncommittedFiles(cwd);
    if (uncommitted > 0) {
      throw new PullRequestError(
        `${uncommitted} file${uncommitted === 1 ? " has" : "s have"} uncommitted changes. Commit them first so they are part of the pull request.`,
      );
    }
    if (!(await this.hasOrigin(cwd))) throw new PullRequestError(NO_ORIGIN);
    const pushed = await this.runner("git", ["push", "-u", "origin", branch], { cwd, timeoutMs: PUSH_TIMEOUT_MS });
    if (pushed.code !== 0) throw new PullRequestError(pushFailure(branch, pushed));
    return PullRequestPushResult.parse({ branch, remote: "origin" });
  }

  async create(
    input: PullRequestInput,
    request: { title: string; body: string; base: string; draft: boolean },
  ): Promise<PullRequestCreateResult> {
    const cwd = input.worktreePath;
    assertRef(request.base);
    const title = request.title.trim();
    if (!title || title.includes("\0") || request.body.includes("\0")) {
      throw new PullRequestError("The pull request needs a title.");
    }
    const branch = await this.currentBranch(cwd);
    if (!branch) throw new PullRequestError(DETACHED);
    const problem = await this.ghProblem(cwd);
    if (problem) throw new PullRequestError(problem.message);
    const args = ["pr", "create", "--head", branch, "--base", request.base, "--title", title, "--body", request.body];
    if (request.draft) args.push("--draft");
    const created = await this.gh(args, cwd);
    if (created.code !== 0) {
      if (/already exists/iu.test(created.stderr)) {
        const existing = await this.view(cwd, branch);
        if (existing) return PullRequestCreateResult.parse({ pullRequest: existing });
      }
      if (/gh auth login|not logged in/iu.test(created.stderr)) throw new PullRequestError(GH_SIGNED_OUT);
      throw new PullRequestError(ghFailure("could not create the pull request", created));
    }
    const url = created.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => /^https?:\/\//u.test(line))
      .at(-1);
    const pullRequest = (url ? await this.view(cwd, url) : undefined) ?? fromUrl(url, request.draft);
    if (!pullRequest) throw new PullRequestError("GitHub CLI created the pull request but did not print its link.");
    return PullRequestCreateResult.parse({ pullRequest });
  }

  async checkLog(input: PullRequestInput, url: string): Promise<PullRequestCheckLogResult> {
    const job = actionsJob(url);
    if (!job) throw new PullRequestError(NOT_ACTIONS);
    const cwd = input.worktreePath;
    const problem = await this.ghProblem(cwd);
    if (problem) throw new PullRequestError(problem.message);
    const result = await this.gh(["run", "view", "--repo", job.repo, "--job", job.jobId, "--log-failed"], cwd, {
      timeoutMs: LOG_TIMEOUT_MS,
      maxOutputBytes: MAX_LOG_BYTES,
    });
    if (result.code !== 0) {
      if (/in progress|still running/iu.test(result.stderr)) {
        throw new PullRequestError("This check is still running. Its log can be read once it finishes.");
      }
      throw new PullRequestError(ghFailure("could not read the check log", result));
    }
    return PullRequestCheckLogResult.parse(failedLogExcerpt(result.stdout));
  }

  /** Unresolved review threads and written review summaries of the branch's pull request. */
  async comments(input: PullRequestInput): Promise<PullRequestCommentsResult> {
    const cwd = input.worktreePath;
    const pullRequest = await this.pullRequestLink(cwd);
    const args = graphqlArgs(pullRequest.host, REVIEW_THREADS_QUERY, [
      ["-f", "owner", pullRequest.owner],
      ["-f", "name", pullRequest.repo],
      ["-F", "number", String(pullRequest.number)],
    ]);
    const result = await this.gh(args, cwd, { maxOutputBytes: 4 * 1024 * 1024 });
    if (result.code !== 0) throw new PullRequestError(ghFailure("could not read the review comments", result));
    const parsed = parseReviewComments(result.stdout);
    if (!parsed) throw new PullRequestError("GitHub returned review comments ZLI could not read.");
    return PullRequestCommentsResult.parse({ number: pullRequest.number, url: pullRequest.url, ...parsed });
  }

  /**
   * Merges the branch's pull request on GitHub. gh's own --delete-branch is not used: it also checks out the
   * base branch here, which fails when another worktree has it. The branch is removed from origin instead.
   */
  async merge(
    input: PullRequestInput,
    request: { method: PullRequestMergeMethod; deleteBranch: boolean },
  ): Promise<PullRequestMergeResult> {
    const cwd = input.worktreePath;
    const { branch, open } = await this.openPullRequest(cwd, { ready: true });
    const merged = await this.gh(["pr", "merge", String(open.number), `--${request.method}`], cwd, {
      timeoutMs: PUSH_TIMEOUT_MS,
    });
    if (merged.code !== 0) throw new PullRequestError(mergeFailure(open.number, merged));
    let branchDeleted = false;
    if (request.deleteBranch) {
      const deleted = await this.runner("git", ["push", "origin", "--delete", branch], {
        cwd,
        timeoutMs: PUSH_TIMEOUT_MS,
      });
      // A repository set to delete merged branches may have removed it already.
      branchDeleted = deleted.code === 0 || /remote ref does not exist/iu.test(deleted.stderr);
    }
    const pullRequest = (await this.view(cwd, String(open.number))) ?? { ...open, state: "MERGED" as const };
    return PullRequestMergeResult.parse({ pullRequest, branchDeleted });
  }

  /** Submits a review of the branch's pull request as the signed-in GitHub account. */
  async review(
    input: PullRequestInput,
    request: { event: PullRequestReviewEvent; body: string },
  ): Promise<PullRequestUpdateResult> {
    const body = request.body.trim();
    if (body.includes("\0")) throw new PullRequestError("The review cannot contain a null character.");
    if (!body && request.event === "REQUEST_CHANGES") {
      throw new PullRequestError("Say what should change before requesting changes.");
    }
    if (!body && request.event === "COMMENT")
      throw new PullRequestError("Write the comment before sending the review.");
    const cwd = input.worktreePath;
    const { open } = await this.openPullRequest(cwd);
    const args = ["pr", "review", String(open.number), REVIEW_FLAGS[request.event]];
    if (body) args.push("--body", body);
    const reviewed = await this.gh(args, cwd);
    if (reviewed.code !== 0) throw new PullRequestError(reviewFailure(open.number, request.event, reviewed));
    return PullRequestUpdateResult.parse({ pullRequest: (await this.view(cwd, String(open.number))) ?? open });
  }

  /** Adds a comment to the pull request's conversation. */
  async comment(input: PullRequestInput, text: string): Promise<PullRequestUpdateResult> {
    const body = text.trim();
    if (!body || body.includes("\0")) throw new PullRequestError("Write the comment first.");
    const cwd = input.worktreePath;
    const { open } = await this.openPullRequest(cwd);
    const commented = await this.gh(["pr", "comment", String(open.number), "--body", body], cwd);
    if (commented.code !== 0) {
      throw new PullRequestError(ghFailure(`could not comment on #${open.number}`, commented));
    }
    return PullRequestUpdateResult.parse({ pullRequest: (await this.view(cwd, String(open.number))) ?? open });
  }

  /** Replies to a review thread through the GraphQL API and answers with the new comment. */
  async reply(input: PullRequestInput, request: { threadId: string; body: string }): Promise<PullRequestReplyResult> {
    const body = request.body.trim();
    if (!body || body.includes("\0")) throw new PullRequestError("Write the reply first.");
    assertThreadId(request.threadId);
    const cwd = input.worktreePath;
    const pullRequest = await this.pullRequestLink(cwd);
    const result = await this.gh(
      graphqlArgs(pullRequest.host, REPLY_MUTATION, [
        ["-f", "threadId", request.threadId],
        ["-f", "body", body],
      ]),
      cwd,
    );
    if (result.code !== 0) throw new PullRequestError(threadFailure("could not reply to the thread", result));
    const [comment] = reviewComment(
      pathIn(parseJson(result.stdout), ["data", "addPullRequestReviewThreadReply", "comment"]),
    );
    if (!comment) throw new PullRequestError("GitHub accepted the reply but sent back a comment ZLI could not read.");
    return PullRequestReplyResult.parse({ threadId: request.threadId, comment });
  }

  /** Marks a review thread resolved or open again. */
  async resolve(
    input: PullRequestInput,
    request: { threadId: string; resolved: boolean },
  ): Promise<PullRequestResolveResult> {
    assertThreadId(request.threadId);
    const cwd = input.worktreePath;
    const pullRequest = await this.pullRequestLink(cwd);
    const mutation = request.resolved ? "resolveReviewThread" : "unresolveReviewThread";
    const result = await this.gh(
      graphqlArgs(pullRequest.host, request.resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION, [
        ["-f", "threadId", request.threadId],
      ]),
      cwd,
    );
    if (result.code !== 0) {
      throw new PullRequestError(
        threadFailure(request.resolved ? "could not resolve the thread" : "could not reopen the thread", result),
      );
    }
    const resolved = pathIn(parseJson(result.stdout), ["data", mutation, "thread", "isResolved"]);
    if (typeof resolved !== "boolean") throw new PullRequestError("GitHub sent back a thread ZLI could not read.");
    return PullRequestResolveResult.parse({ threadId: request.threadId, resolved });
  }

  /**
   * Turns auto-merge on or off. With it on, GitHub merges with `method` once the required checks and
   * reviews pass; ZLI is not involved then, so the branch stays on origin unless the repository deletes it.
   */
  async autoMerge(
    input: PullRequestInput,
    request: { enabled: boolean; method?: PullRequestMergeMethod | undefined },
  ): Promise<PullRequestUpdateResult> {
    if (request.enabled && !request.method) throw new PullRequestError("Choose a merge method for auto-merge.");
    const cwd = input.worktreePath;
    const { open } = await this.openPullRequest(cwd, { ready: request.enabled });
    const number = String(open.number);
    const args = request.enabled
      ? ["pr", "merge", number, "--auto", `--${request.method}`]
      : ["pr", "merge", number, "--disable-auto"];
    const changed = await this.gh(args, cwd, { timeoutMs: PUSH_TIMEOUT_MS });
    if (changed.code !== 0) throw new PullRequestError(autoMergeFailure(open.number, request.enabled, changed));
    const fallback: PullRequestInfo = { ...open };
    if (request.enabled && request.method) fallback.autoMerge = { method: request.method };
    else delete fallback.autoMerge;
    return PullRequestUpdateResult.parse({ pullRequest: (await this.view(cwd, number)) ?? fallback });
  }

  /** The branch's pull request, which must be open; `ready` also refuses drafts. */
  private async openPullRequest(
    cwd: string,
    options: { ready?: boolean } = {},
  ): Promise<{ branch: string; open: PullRequestInfo }> {
    const branch = await this.currentBranch(cwd);
    if (!branch) throw new PullRequestError(DETACHED);
    const problem = await this.ghProblem(cwd);
    if (problem) throw new PullRequestError(problem.message);
    const open = await this.view(cwd, branch);
    if (!open) throw new PullRequestError(NO_PULL_REQUEST);
    if (open.state !== "OPEN") {
      throw new PullRequestError(
        `Pull request #${open.number} is already ${open.state === "MERGED" ? "merged" : "closed"}.`,
      );
    }
    if (options.ready && open.isDraft) {
      throw new PullRequestError(`Pull request #${open.number} is a draft. Mark it ready for review on GitHub first.`);
    }
    return { branch, open };
  }

  /** The host, repository, and number of the branch's pull request, for GraphQL calls. */
  private async pullRequestLink(cwd: string): Promise<NonNullable<ReturnType<typeof parsePullRequestLink>>> {
    const branch = await this.currentBranch(cwd);
    if (!branch) throw new PullRequestError(DETACHED);
    const problem = await this.ghProblem(cwd);
    if (problem) throw new PullRequestError(problem.message);
    const view = await this.gh(["pr", "view", branch, "--json", "number,url"], cwd);
    if (view.code !== 0) {
      if (/no (open )?pull requests? found/iu.test(view.stderr)) throw new PullRequestError(NO_PULL_REQUEST);
      throw new PullRequestError(ghFailure("could not look up the pull request", view));
    }
    const pullRequest = parsePullRequestLink(view.stdout);
    if (!pullRequest) throw new PullRequestError(UNREADABLE_PULL_REQUEST);
    return pullRequest;
  }

  async fetch(input: PullRequestInput): Promise<GitBranchesResult> {
    const cwd = input.worktreePath;
    if (!(await this.hasOrigin(cwd))) throw new PullRequestError(NO_ORIGIN);
    const fetched = await this.runner("git", ["fetch", "--prune", "origin"], { cwd, timeoutMs: PUSH_TIMEOUT_MS });
    if (fetched.code !== 0) throw new PullRequestError(remoteFailure("Fetching from origin", fetched));
    return this.branches(input);
  }

  /** Fast-forwards the checked-out branch to origin's copy. Diverged branches are left for the person to resolve. */
  async pull(input: PullRequestInput): Promise<GitPullResult> {
    const cwd = input.worktreePath;
    const branch = await this.currentBranch(cwd);
    if (!branch) throw new PullRequestError(DETACHED);
    if (!(await this.hasOrigin(cwd))) throw new PullRequestError(NO_ORIGIN);
    const head = await this.git(["rev-parse", "--verify", "--quiet", "HEAD"], cwd);
    const before = head.code === 0 ? head.stdout.trim() : undefined;
    const pulled = await this.runner("git", ["pull", "--ff-only", "origin", branch], {
      cwd,
      timeoutMs: PUSH_TIMEOUT_MS,
    });
    if (pulled.code !== 0) throw new PullRequestError(pullFailure(branch, pulled));
    let commits = 0;
    if (before) {
      const count = await this.git(["rev-list", "--count", `${before}..HEAD`], cwd);
      commits = count.code === 0 ? Number.parseInt(count.stdout.trim(), 10) || 0 : 0;
    }
    return GitPullResult.parse({ branch, commits });
  }

  /**
   * Local branches and origin's branches, most recently committed first, with how each local branch
   * stands against its upstream and which other worktree has it checked out.
   */
  async branches(input: PullRequestInput): Promise<GitBranchesResult> {
    const cwd = input.worktreePath;
    const current = await this.currentBranch(cwd);
    const defaultBranch = await this.originDefaultBranch(cwd);
    const refs = await this.git(
      ["for-each-ref", "--sort=-committerdate", `--format=${BRANCH_FORMAT}`, "refs/heads", "refs/remotes/origin"],
      cwd,
    );
    if (refs.code !== 0) throw new PullRequestError(gitFailure("could not list the branches", refs));
    const local: string[] = [];
    const remote: string[] = [];
    const details: Record<string, GitLocalBranch> = {};
    for (const line of refs.stdout.split(/\r?\n/u)) {
      const [ref = "", upstreamName = "", track = "", worktreePath = ""] = line.trim().split("\0");
      const [list, name] = ref.startsWith("refs/heads/")
        ? [local, ref.slice("refs/heads/".length)]
        : ref.startsWith("refs/remotes/origin/")
          ? [remote, ref.slice("refs/remotes/origin/".length)]
          : [undefined, ""];
      if (!list || name === "HEAD" || !isSafeRef(name) || list.length >= MAX_BRANCHES) continue;
      list.push(name);
      if (list !== local) continue;
      const upstream = parseUpstream(upstreamName, track);
      const elsewhere = name !== current && worktreePath ? nativeGitPath(worktreePath) : undefined;
      if (upstream || elsewhere) {
        details[name] = { ...(upstream ? { upstream } : {}), ...(elsewhere ? { worktreePath: elsewhere } : {}) };
      }
    }
    return GitBranchesResult.parse({
      ...(current ? { current } : {}),
      ...(defaultBranch && isSafeRef(defaultBranch) ? { defaultBranch } : {}),
      local,
      remote,
      ...(Object.keys(details).length > 0 ? { details } : {}),
    });
  }

  /** Creates a local branch that tracks nothing, so the first push sets its own upstream on origin. */
  async createBranch(
    input: PullRequestInput,
    request: { name: string; from?: string | undefined; switchTo: boolean },
  ): Promise<GitBranchesResult> {
    const cwd = input.worktreePath;
    const name = await this.assertNewBranchName(cwd, request.name);
    const from = request.from?.trim() || undefined;
    if (from) {
      if (!isSafeRef(from)) throw new PullRequestError(`${from} is not a branch or commit ZLI can start from.`);
      const resolved = await this.git(["rev-parse", "--verify", "--quiet", `${from}^{commit}`], cwd);
      if (resolved.code !== 0) throw new PullRequestError(`There is no branch or commit named ${from}.`);
    }
    if (await this.localBranchExists(cwd, name)) {
      throw new PullRequestError(`A branch named ${name} already exists. Pick another name or switch to it.`);
    }
    const start = from ? [from] : [];
    if (request.switchTo) {
      const switched = await this.git(["switch", "--no-track", "-c", name, ...start], cwd);
      if (switched.code !== 0) throw new PullRequestError(switchFailure(name, switched));
    } else {
      const created = await this.git(["branch", "--no-track", name, ...start], cwd);
      if (created.code !== 0) throw new PullRequestError(gitFailure(`could not create ${name}`, created));
    }
    return this.branches(input);
  }

  /** Checks out a local branch, or `origin/<name>` as a local branch that tracks it. */
  async switchBranch(input: PullRequestInput, requested: string): Promise<GitBranchesResult> {
    const cwd = input.worktreePath;
    if (!isSafeRef(requested)) throw new PullRequestError(`${requested} is not a branch name ZLI can check out.`);
    let name = requested;
    let args = ["switch", name];
    if (!(await this.localBranchExists(cwd, name))) {
      const remoteName = requested.startsWith("origin/") ? requested.slice("origin/".length) : undefined;
      const onOrigin =
        !!remoteName &&
        (await this.git(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${remoteName}`], cwd)).code === 0;
      if (!remoteName || !onOrigin) throw new PullRequestError(`There is no branch named ${requested}.`);
      name = remoteName;
      args = (await this.localBranchExists(cwd, name))
        ? ["switch", name]
        : ["switch", "-c", name, "--track", `origin/${name}`];
    }
    if (name === (await this.currentBranch(cwd))) return this.branches(input);
    const switched = await this.git(args, cwd);
    if (switched.code !== 0) throw new PullRequestError(switchFailure(name, switched));
    return this.branches(input);
  }

  /** Renames a local branch. Its copy on origin, if any, keeps the old name. */
  async renameBranch(input: PullRequestInput, request: { from: string; to: string }): Promise<GitBranchesResult> {
    const cwd = input.worktreePath;
    const from = request.from;
    if (!isSafeRef(from) || !(await this.localBranchExists(cwd, from))) {
      throw new PullRequestError(`There is no local branch named ${from}.`);
    }
    const to = await this.assertNewBranchName(cwd, request.to);
    if (to === from) return this.branches(input);
    if (await this.localBranchExists(cwd, to)) throw new PullRequestError(`A branch named ${to} already exists.`);
    const elsewhere = (await this.branches(input)).details?.[from]?.worktreePath;
    if (elsewhere) {
      throw new PullRequestError(
        `${from} is checked out in another worktree at ${elsewhere}. Rename it from that worktree instead.`,
      );
    }
    const renamed = await this.git(["branch", "-m", from, to], cwd);
    if (renamed.code !== 0) throw new PullRequestError(gitFailure(`could not rename ${from}`, renamed));
    return this.branches(input);
  }

  /** Deletes a local branch, and with `remote` its copy on origin. The checked-out branch is never deleted. */
  async deleteBranch(
    input: PullRequestInput,
    request: { name: string; force: boolean; remote: boolean },
  ): Promise<GitBranchesResult> {
    const cwd = input.worktreePath;
    const name = request.name;
    if (!isSafeRef(name)) throw new PullRequestError(`${name} is not a branch name ZLI can delete.`);
    const current = await this.currentBranch(cwd);
    if (name === current) {
      throw new PullRequestError(`${name} is checked out in this worktree. Switch to another branch, then delete it.`);
    }
    const local = await this.localBranchExists(cwd, name);
    if (!local && !request.remote) throw new PullRequestError(`There is no local branch named ${name}.`);
    if (request.remote && !(await this.hasOrigin(cwd))) throw new PullRequestError(NO_ORIGIN);
    if (local) {
      const deleted = await this.git(["branch", request.force ? "-D" : "-d", name], cwd);
      if (deleted.code !== 0) throw new PullRequestError(deleteFailure(name, current, deleted));
    }
    if (request.remote) {
      const pushed = await this.runner("git", ["push", "origin", "--delete", name], {
        cwd,
        timeoutMs: PUSH_TIMEOUT_MS,
      });
      if (pushed.code !== 0 && !/remote ref does not exist/iu.test(pushed.stderr)) {
        const failure = remoteFailure(`Deleting ${name} on origin`, pushed);
        throw new PullRequestError(local ? `Deleted ${name} on this computer. ${failure}` : failure);
      }
    }
    return this.branches(input);
  }

  /** A name for a new local branch, as Git would store it; throws a message the person can act on. */
  private async assertNewBranchName(cwd: string, value: string): Promise<string> {
    const name = value.trim();
    if (!name) throw new PullRequestError("Enter a branch name.");
    if (name === "HEAD" || name.startsWith("origin/")) {
      throw new PullRequestError(
        `${name} would be confused with ${name === "HEAD" ? "HEAD" : "a branch on origin"}. Pick another name.`,
      );
    }
    const checked = isSafeRef(name) ? await this.git(["check-ref-format", "--branch", name], cwd) : undefined;
    // --branch also expands shorthands such as @{-1}; only a name Git keeps as typed is accepted.
    if (checked?.code !== 0 || checked.stdout.trim() !== name) {
      throw new PullRequestError(
        `${name} is not a valid branch name. Branch names cannot contain spaces, "..", or any of ~ ^ : ? * [ \\.`,
      );
    }
    return name;
  }

  private async localBranchExists(cwd: string, name: string): Promise<boolean> {
    return (await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], cwd)).code === 0;
  }

  /** How the branch stands against its upstream; undefined when it tracks nothing or Git cannot say. */
  private async upstreamOf(cwd: string, branch: string): Promise<GitUpstream | undefined> {
    const result = await this.git(
      ["for-each-ref", "--format=%(upstream:short)%00%(upstream:track,nobracket)", `refs/heads/${branch}`],
      cwd,
    );
    if (result.code !== 0) return undefined;
    const [name = "", track = ""] = result.stdout.trim().split("\0");
    return parseUpstream(name, track);
  }

  private async view(cwd: string, target: string): Promise<PullRequestInfo | undefined> {
    const view = await this.gh(["pr", "view", target, "--json", PR_FIELDS], cwd);
    return view.code === 0 ? parsePullRequest(view.stdout) : undefined;
  }

  private async ghProblem(cwd: string): Promise<PullRequestProblem | undefined> {
    if (Date.now() < this.ghReadyUntil) return undefined;
    let version: ProcessResult;
    try {
      version = await this.runner("gh", ["--version"], { cwd, timeoutMs: GH_TIMEOUT_MS });
    } catch (error) {
      if (isMissingProgram(error)) return { code: "gh_missing", message: GH_MISSING };
      throw error;
    }
    if (version.code !== 0) return { code: "gh_missing", message: GH_MISSING };
    const auth = await this.gh(["auth", "status"], cwd);
    if (auth.code !== 0) return { code: "gh_unauthenticated", message: GH_SIGNED_OUT };
    this.ghReadyUntil = Date.now() + GH_READY_MS;
    return undefined;
  }

  private async gh(
    args: readonly string[],
    cwd: string,
    options: { timeoutMs?: number; maxOutputBytes?: number } = {},
  ): Promise<ProcessResult> {
    try {
      return await this.runner("gh", args, {
        cwd,
        timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS,
        ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
      });
    } catch (error) {
      if (isMissingProgram(error)) throw new PullRequestError(GH_MISSING);
      throw error;
    }
  }

  private async git(args: readonly string[], cwd: string): Promise<ProcessResult> {
    return this.runner("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  }

  /** The checked-out branch, or undefined when HEAD is detached. */
  private async currentBranch(cwd: string): Promise<string | undefined> {
    const result = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    if (result.code !== 0) throw new PullRequestError(gitFailure("could not read the current branch", result));
    const branch = result.stdout.trim();
    if (!branch || branch === "HEAD") return undefined;
    assertRef(branch);
    return branch;
  }

  private async uncommittedFiles(cwd: string): Promise<number> {
    const result = await this.git(["status", "--porcelain=v1"], cwd);
    if (result.code !== 0) throw new PullRequestError(gitFailure("could not read the worktree status", result));
    return result.stdout.split(/\r?\n/u).filter((line) => line.trim()).length;
  }

  /** Only the exit code is used: the URL can carry credentials and is never read or shown. */
  private async hasOrigin(cwd: string): Promise<boolean> {
    return (await this.git(["remote", "get-url", "origin"], cwd)).code === 0;
  }

  private async originDefaultBranch(cwd: string): Promise<string | undefined> {
    const result = await this.git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd);
    const value = result.code === 0 ? result.stdout.trim() : "";
    return value.startsWith("origin/") && value.length > "origin/".length ? value.slice("origin/".length) : undefined;
  }

  /** Commit subjects on HEAD that `base` lacks, oldest first; undefined when `base` does not resolve. */
  private async subjectsSince(cwd: string, base: string): Promise<string[] | undefined> {
    for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
      const resolved = await this.git(["rev-parse", "--verify", "--quiet", ref], cwd);
      if (resolved.code !== 0) continue;
      const log = await this.git(["log", "--reverse", "--format=%s", `${ref}..HEAD`], cwd);
      if (log.code !== 0) return undefined;
      return log.stdout.split(/\r?\n/u).filter((line) => line.trim());
    }
    return undefined;
  }
}

/**
 * Branches checked out in the project's worktrees that differ from what the projection records: the
 * current branch of the worktree the command ran in, and branches Git reports checked out elsewhere.
 */
export function branchChanges(
  projection: RuntimeProjection,
  worktree: WorktreeProjection,
  result: GitBranchesResult,
): { worktreeId: WorktreeProjection["worktreeId"]; branch: string }[] {
  const changes: { worktreeId: WorktreeProjection["worktreeId"]; branch: string }[] = [];
  if (result.current && result.current !== worktree.branch) {
    changes.push({ worktreeId: worktree.worktreeId, branch: result.current });
  }
  const byPath = new Map<string, string>();
  for (const [name, detail] of Object.entries(result.details ?? {})) {
    if (detail.worktreePath) byPath.set(comparablePath(detail.worktreePath), name);
  }
  if (byPath.size === 0) return changes;
  for (const other of projection.worktrees) {
    if (other.worktreeId === worktree.worktreeId || other.projectId !== worktree.projectId) continue;
    if (other.status !== "ready") continue;
    const branch = byPath.get(comparablePath(other.path));
    if (branch && branch !== other.branch) changes.push({ worktreeId: other.worktreeId, branch });
  }
  return changes;
}

function comparablePath(value: string): string {
  const path = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
}

const BRANCH_RESULT_COMMANDS = new Set<PullRequestCommand["type"]>([
  "review.git.branches",
  "review.git.fetch",
  "review.git.createBranch",
  "review.git.switchBranch",
  "review.git.renameBranch",
  "review.git.deleteBranch",
]);

/**
 * Runs one pull request command against the worktree it names. `onBranches` sees every branch list a
 * command answers with, so the caller can record a branch that was switched or renamed.
 */
export async function runPullRequestCommand(
  service: PullRequestService,
  projection: RuntimeProjection,
  command: PullRequestCommand,
  onBranches?: (worktree: WorktreeProjection, result: GitBranchesResult) => Promise<void>,
): Promise<unknown> {
  const result = await runCommand(service, projection, command);
  if (onBranches && BRANCH_RESULT_COMMANDS.has(command.type)) {
    const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === command.worktreeId);
    if (worktree) await onBranches(worktree, result as GitBranchesResult);
  }
  return result;
}

async function runCommand(
  service: PullRequestService,
  projection: RuntimeProjection,
  command: PullRequestCommand,
): Promise<unknown> {
  const worktree = projection.worktrees.find((candidate) => candidate.worktreeId === command.worktreeId);
  if (!worktree) throw new PullRequestError("Worktree does not exist.");
  if (worktree.status !== "ready") throw new PullRequestError("Worktree is not ready.");
  const input: PullRequestInput = {
    worktreePath: worktree.path,
    fallbackBase: projection.reviews?.find((review) => review.worktreeId === command.worktreeId)?.baseRef ?? "main",
  };
  switch (command.type) {
    case "review.pr.status":
      return service.status(input, command.base);
    case "review.pr.push":
      return service.push(input);
    case "review.pr.checkLog":
      return service.checkLog(input, command.url);
    case "review.pr.comments":
      return service.comments(input);
    case "review.pr.create":
      return service.create(input, {
        title: command.title,
        body: command.body,
        base: command.base,
        draft: command.draft,
      });
    case "review.pr.merge":
      return service.merge(input, { method: command.method, deleteBranch: command.deleteBranch });
    case "review.git.branches":
      return service.branches(input);
    case "review.git.fetch":
      return service.fetch(input);
    case "review.git.pull":
      return service.pull(input);
    case "review.git.createBranch":
      return service.createBranch(input, { name: command.name, from: command.from, switchTo: command.switchTo });
    case "review.git.switchBranch":
      return service.switchBranch(input, command.name);
    case "review.git.renameBranch":
      return service.renameBranch(input, { from: command.from, to: command.to });
    case "review.git.deleteBranch":
      return service.deleteBranch(input, { name: command.name, force: command.force, remote: command.remote });
    case "review.pr.review":
      return service.review(input, { event: command.event, body: command.body });
    case "review.pr.comment":
      return service.comment(input, command.body);
    case "review.pr.reply":
      return service.reply(input, { threadId: command.threadId, body: command.body });
    case "review.pr.resolve":
      return service.resolve(input, { threadId: command.threadId, resolved: command.resolved });
    case "review.pr.autoMerge":
      return service.autoMerge(input, { enabled: command.enabled, method: command.method });
  }
}

export function formatBody(subjects: readonly string[]): string {
  const shown = subjects.slice(0, MAX_BODY_SUBJECTS).map((subject) => `- ${subject}`);
  const hidden = subjects.length - shown.length;
  return [...shown, ...(hidden > 0 ? [`- and ${hidden} more commit${hidden === 1 ? "" : "s"}`] : [])].join("\n");
}

/** Removes tokens and URL credentials from Git and GitHub CLI output before it is shown. */
export function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})/gu, "[redacted]")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, "$1[redacted]@")
    .replace(/\b(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?\S+/giu, "$1[redacted]")
    .replace(/\b(bearer\s+)(?!\[redacted\])\S+/giu, "$1[redacted]")
    .replace(/\b((?:token|password)\s*[:=]\s*)\S+/giu, "$1[redacted]");
}

function lastLines(value: string): string {
  const lines = redactSecrets(value)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" ");
  return lines.length > 400 ? `${lines.slice(0, 399)}…` : lines;
}

export function ghFailure(action: string, result: ProcessResult): string {
  const detail = lastLines(result.stderr || result.stdout);
  return `GitHub CLI ${action}.${detail ? ` ${detail}` : ""}`;
}

function gitFailure(action: string, result: ProcessResult): string {
  const detail = lastLines(result.stderr);
  return `Git ${action}.${detail ? ` ${detail}` : ""}`;
}

const AUTH_FAILURE = /authentication failed|could not read username|permission denied|denied to|403/iu;
const CREDENTIALS_REFUSED =
  "origin refused the credentials. Check that git fetch and git push work for this repository in a terminal, then try again.";

function remoteFailure(action: string, result: ProcessResult): string {
  if (AUTH_FAILURE.test(`${result.stderr}\n${result.stdout}`)) return CREDENTIALS_REFUSED;
  const detail = lastLines(result.stderr);
  return `${action} failed.${detail ? ` ${detail}` : ""}`;
}

function pullFailure(branch: string, result: ProcessResult): string {
  const output = `${result.stderr}\n${result.stdout}`;
  if (/couldn't find remote ref/iu.test(output)) return `origin has no branch ${branch} yet. Push it first.`;
  if (/not possible to fast-forward|diverg/iu.test(output)) {
    return `${branch} and origin/${branch} both have commits the other lacks. Rebase or merge them in a terminal, then try again.`;
  }
  if (/would be overwritten|commit your changes or stash/iu.test(output)) {
    return "The pull would overwrite uncommitted changes. Commit or stash them first.";
  }
  return remoteFailure(`Pulling ${branch} from origin`, result);
}

function mergeFailure(number: number, result: ProcessResult): string {
  const output = `${result.stderr}\n${result.stdout}`;
  if (/merge conflict|not mergeable|conflicts?/iu.test(output)) {
    return `Pull request #${number} has conflicts with its base branch. Pull the base into this branch, resolve them, and push.`;
  }
  if (/required status check|review is required|base branch policy|--auto/iu.test(output)) {
    return `GitHub blocked merging #${number}: the base branch needs passing checks or an approving review first.`;
  }
  return ghFailure(`could not merge #${number}`, result);
}

const ELSEWHERE = /(?:checked out|used by worktree) at '([^']+)'/iu;

/** Git for Windows prints C:/like/this; ZLI shows Windows paths with backslashes everywhere else. */
export function nativeGitPath(path: string): string {
  return /^[A-Za-z]:\//u.test(path) ? path.replaceAll("/", "\\") : path;
}

function elsewhereIn(output: string): string | undefined {
  const path = ELSEWHERE.exec(output)?.[1];
  return path ? nativeGitPath(path) : undefined;
}

function switchFailure(branch: string, result: ProcessResult): string {
  const output = `${result.stderr}\n${result.stdout}`;
  const elsewhere = elsewhereIn(output);
  if (elsewhere) {
    return `${branch} is checked out in another worktree at ${elsewhere}. A branch can be checked out in one worktree at a time, so work on it there or switch that worktree to another branch first.`;
  }
  if (/would be overwritten/iu.test(output)) {
    const files = output
      .split(/\r?\n/u)
      .filter((line) => /^\t\S/u.test(line))
      .map((line) => line.trim());
    const named =
      files.length > 0
        ? ` in ${files.slice(0, 3).join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}`
        : "";
    return `Switching to ${branch} would overwrite uncommitted changes${named}. Commit or stash them, then switch again.`;
  }
  if (/resolve your current index|unmerged|merge in progress/iu.test(output)) {
    return "This worktree has unresolved merge conflicts. Finish or abort the merge before switching branches.";
  }
  return gitFailure(`could not switch to ${branch}`, result);
}

function deleteFailure(branch: string, current: string | undefined, result: ProcessResult): string {
  const output = `${result.stderr}\n${result.stdout}`;
  const elsewhere = elsewhereIn(output);
  if (elsewhere) {
    return `${branch} is checked out in another worktree at ${elsewhere}. Remove that worktree or switch it to another branch, then delete ${branch}.`;
  }
  if (/not fully merged/iu.test(output)) {
    return `${branch} has commits that are not merged into ${current ?? "HEAD"} or its upstream. Turn on Delete unmerged commits to delete it anyway.`;
  }
  return gitFailure(`could not delete ${branch}`, result);
}

/** Reads `%(upstream:short)` and `%(upstream:track,nobracket)`, for example "ahead 2, behind 1" or "gone". */
export function parseUpstream(name: string, track: string): GitUpstream | undefined {
  const upstream = name.trim();
  if (!upstream || !isSafeRef(upstream)) return undefined;
  const value = track.trim();
  const count = (word: string) => Number.parseInt(new RegExp(`${word} (\\d+)`, "u").exec(value)?.[1] ?? "0", 10);
  return {
    name: upstream,
    ahead: count("ahead"),
    behind: count("behind"),
    ...(value === "gone" ? { gone: true } : {}),
  };
}

function isSafeRef(value: string): boolean {
  try {
    assertRef(value);
    return true;
  } catch {
    return false;
  }
}

function reviewFailure(number: number, event: PullRequestReviewEvent, result: ProcessResult): string {
  const output = `${result.stderr}\n${result.stdout}`;
  if (/can ?not approve your own pull request/iu.test(output)) {
    return "GitHub does not let you approve your own pull request. Leave a comment instead, or ask someone else to review it.";
  }
  if (/can ?not request changes on your own pull request/iu.test(output)) {
    return "GitHub does not let you request changes on your own pull request. Leave a comment instead.";
  }
  const action = event === "APPROVE" ? "approve" : event === "REQUEST_CHANGES" ? "request changes on" : "review";
  return ghFailure(`could not ${action} #${number}`, result);
}

function threadFailure(action: string, result: ProcessResult): string {
  const output = `${result.stderr}\n${result.stdout}`;
  if (/could not resolve to a node|NOT_FOUND/iu.test(output)) {
    return "GitHub could not find this review thread. It may have been deleted; read the comments again.";
  }
  if (/resource not accessible|FORBIDDEN|must have (?:push|write) access/iu.test(output)) {
    return "Your GitHub account is not allowed to change this thread. Ask someone with write access to the repository.";
  }
  return ghFailure(action, result);
}

function autoMergeFailure(number: number, enabled: boolean, result: ProcessResult): string {
  const output = `${result.stderr}\n${result.stdout}`;
  if (
    enabled &&
    /auto.?merge is not allowed|auto.?merge (?:is )?(?:not enabled|disabled) for this repository/iu.test(output)
  ) {
    return "Auto-merge is turned off for this repository. Turn on Allow auto-merge in the repository settings on GitHub, or merge once the checks pass.";
  }
  if (enabled && /clean status/iu.test(output)) {
    return `Pull request #${number} can be merged now, so there is nothing to wait for. Merge it directly.`;
  }
  return ghFailure(`could not turn ${enabled ? "on" : "off"} auto-merge for #${number}`, result);
}

const THREAD_ID = /^[A-Za-z0-9_=-]{1,200}$/u;

function assertThreadId(value: string): void {
  if (!THREAD_ID.test(value)) throw new PullRequestError("That review thread id is not one GitHub uses.");
}

/** `gh api graphql` arguments; `-f` passes a value as a string and `-F` lets gh convert numbers. */
function graphqlArgs(
  host: string,
  query: string,
  variables: readonly (readonly ["-f" | "-F", string, string])[],
): string[] {
  return [
    "api",
    "graphql",
    ...(host === "github.com" ? [] : ["--hostname", host]),
    "-f",
    `query=${query}`,
    ...variables.flatMap(([flag, name, value]) => [flag, `${name}=${value}`]),
  ];
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function pushFailure(branch: string, result: ProcessResult): string {
  const output = `${result.stderr}\n${result.stdout}`;
  if (/\[rejected\]|non-fast-forward|fetch first|\[remote rejected\]/iu.test(output)) {
    return `origin rejected the push of ${branch}. The remote branch has commits this worktree does not have, or a rule on origin blocked it. Pull or rebase onto origin/${branch}, then try again.`;
  }
  if (AUTH_FAILURE.test(output)) {
    return "origin refused the credentials for this push. Check that git push works for this repository in a terminal, then try again.";
  }
  const detail = lastLines(result.stderr);
  return `Pushing ${branch} to origin failed.${detail ? ` ${detail}` : ""}`;
}

function parsePullRequest(stdout: string): PullRequestInfo | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const { statusCheckRollup, reviewDecision, autoMergeRequest, ...rest } = raw as Record<string, unknown>;
  const checks = summarizeChecks(statusCheckRollup);
  const autoMerge = autoMergeOf(autoMergeRequest);
  const parsed = PullRequestInfo.safeParse({
    ...rest,
    ...(checks ? { checks } : {}),
    ...(autoMerge ? { autoMerge } : {}),
    ...(reviewDecision === "APPROVED" || reviewDecision === "CHANGES_REQUESTED" || reviewDecision === "REVIEW_REQUIRED"
      ? { reviewDecision }
      : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

/** `gh pr view --json autoMergeRequest` is null while auto-merge is off. */
export function autoMergeOf(value: unknown): PullRequestInfo["autoMerge"] {
  if (!isRecordValue(value)) return undefined;
  const method = stringField(value.mergeMethod)?.toLowerCase();
  const enabledBy = isRecordValue(value.enabledBy) ? stringField(value.enabledBy.login) : undefined;
  return {
    ...(method === "squash" || method === "merge" || method === "rebase" ? { method } : {}),
    ...(enabledBy ? { enabledBy: enabledBy.slice(0, 100) } : {}),
  };
}

const CHECK_ORDER: Record<PullRequestCheckState, number> = { failed: 0, pending: 1, passed: 2, skipped: 3 };

/**
 * Reduces `gh pr view --json statusCheckRollup` to one entry per check. A workflow that runs for both
 * push and pull_request reports the same check twice; the most recently started one is kept.
 */
export function summarizeChecks(rollup: unknown): PullRequestCheck[] | undefined {
  if (!Array.isArray(rollup)) return undefined;
  const latest = new Map<string, { check: PullRequestCheck; startedAt: string }>();
  for (const item of rollup) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const name = stringField(entry.name) ?? stringField(entry.context);
    if (!name) continue;
    const workflow = stringField(entry.workflowName);
    const url = httpUrl(stringField(entry.detailsUrl) ?? stringField(entry.targetUrl));
    const startedAt = stringField(entry.startedAt) ?? "";
    const key = `${workflow ?? ""}\0${name}`;
    const previous = latest.get(key);
    if (previous && previous.startedAt > startedAt) continue;
    const check: PullRequestCheck = {
      name: name.slice(0, 300),
      ...(workflow ? { workflow: workflow.slice(0, 300) } : {}),
      state: checkState(entry),
      ...(url ? { url } : {}),
    };
    latest.set(key, { check, startedAt });
  }
  return [...latest.values()]
    .map((value) => value.check)
    .sort((left, right) => CHECK_ORDER[left.state] - CHECK_ORDER[right.state] || left.name.localeCompare(right.name))
    .slice(0, 200);
}

function checkState(entry: Record<string, unknown>): PullRequestCheckState {
  const outcome = (stringField(entry.conclusion) ?? stringField(entry.state) ?? "").toUpperCase();
  if (outcome === "SUCCESS") return "passed";
  if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(outcome)) {
    return "failed";
  }
  if (["SKIPPED", "NEUTRAL", "STALE"].includes(outcome)) return "skipped";
  return "pending";
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const REPO_PART = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

/** The repository and job of a GitHub Actions job link, or undefined for any other link. */
export function actionsJob(value: string): { repo: string; jobId: string } | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  const match = /^\/([^/]+)\/([^/]+)\/actions\/runs\/\d+\/job\/(\d+)\/?$/u.exec(url.pathname);
  const [, owner, repo, jobId] = match ?? [];
  if (!owner || !repo || !jobId || !REPO_PART.test(owner) || !REPO_PART.test(repo)) return undefined;
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/u.test(host)) return undefined;
  return { repo: host === "github.com" ? `${owner}/${repo}` : `${host}/${owner}/${repo}`, jobId };
}

// `gh run view --log` lines are "job<TAB>step<TAB>timestamp text".
const LOG_PREFIX = /^[^\t]*\t[^\t]*\t/u;
const LOG_TIMESTAMP = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI color codes are what is removed.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;

/**
 * The output of the step that failed, ending at the first error GitHub Actions recorded. Without an
 * error marker the end of the job before its cleanup is used.
 */
export function failedLogExcerpt(log: string): { excerpt: string; truncated: boolean } {
  const lines = log
    .split(/\r?\n/u)
    .map((line) => line.replace(LOG_PREFIX, "").replace(LOG_TIMESTAMP, "").replace(ANSI, "").trimEnd());
  const errorAt = lines.findIndex((line) => line.startsWith("##[error]"));
  let start = 0;
  let end = lines.length;
  if (errorAt >= 0) {
    end = errorAt + 1;
    for (let index = errorAt; index >= 0; index -= 1) {
      if (lines[index]?.startsWith("##[group]Run ")) {
        start = index;
        break;
      }
    }
  } else {
    const cleanup = lines.findIndex((line) => line.startsWith("Post job cleanup."));
    if (cleanup >= 0) end = cleanup;
  }
  let picked = lines
    .slice(start, end)
    .filter((line) => line !== "##[endgroup]")
    .map((line) => line.replace(/^##\[group\]/u, "").replace(/^##\[(error|warning)\]/u, "$1: "));
  while (picked.length > 0 && !picked.at(-1)) picked.pop();
  let truncated = false;
  if (picked.length > MAX_LOG_LINES) {
    picked = picked.slice(-MAX_LOG_LINES);
    truncated = true;
  }
  let excerpt = redactSecrets(picked.join("\n"));
  if (excerpt.length > MAX_LOG_CHARS) {
    const tail = excerpt.slice(-MAX_LOG_CHARS);
    excerpt = tail.slice(tail.indexOf("\n") + 1);
    truncated = true;
  }
  return { excerpt, truncated };
}

/** The repository and number behind `gh pr view --json number,url`. */
export function parsePullRequestLink(
  stdout: string,
): { host: string; owner: string; repo: string; number: number; url: string } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecordValue(raw) || typeof raw.url !== "string" || typeof raw.number !== "number") return undefined;
  let url: URL;
  try {
    url = new URL(raw.url);
  } catch {
    return undefined;
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/u.exec(url.pathname);
  const [, owner, repo] = match ?? [];
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !owner || !repo || !REPO_PART.test(owner) || !REPO_PART.test(repo)) return undefined;
  if (!/^[a-z0-9.-]+$/u.test(host) || !Number.isSafeInteger(raw.number) || raw.number <= 0) return undefined;
  return { host, owner, repo, number: raw.number, url: url.href };
}

/**
 * Reduces the GraphQL answer to the threads nobody resolved and the reviews that say something.
 * Each thread keeps the end of the diff hunk its first comment points at.
 */
export function parseReviewComments(
  stdout: string,
): { threads: PullRequestReviewThread[]; reviews: PullRequestReviewSummary[] } | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const pullRequest = pathIn(raw, ["data", "repository", "pullRequest"]);
  if (!isRecordValue(pullRequest)) return undefined;
  const threads: PullRequestReviewThread[] = [];
  for (const node of nodes(pullRequest.reviewThreads).slice(0, MAX_THREADS)) {
    if (!isRecordValue(node) || node.isResolved === true) continue;
    const id = stringField(node.id);
    const filePath = stringField(node.path);
    if (!id || !filePath) continue;
    const rawComments = nodes(node.comments);
    const comments = rawComments.flatMap((comment) => reviewComment(comment)).slice(0, MAX_THREAD_COMMENTS);
    if (comments.length === 0) continue;
    const first = rawComments.find(isRecordValue);
    const line = positiveInteger(node.line) ?? positiveInteger(node.originalLine);
    const startLine = positiveInteger(node.startLine) ?? positiveInteger(node.originalStartLine);
    const hunk = first && typeof first.diffHunk === "string" ? hunkTail(first.diffHunk) : "";
    threads.push({
      id: id.slice(0, 200),
      path: filePath.slice(0, 4_000),
      ...(line ? { line } : {}),
      ...(startLine && line && startLine < line ? { startLine } : {}),
      outdated: node.isOutdated === true,
      ...(hunk ? { diffHunk: hunk } : {}),
      comments,
      ...(typeof node.viewerCanReply === "boolean" ? { viewerCanReply: node.viewerCanReply } : {}),
      ...(typeof node.viewerCanResolve === "boolean" ? { viewerCanResolve: node.viewerCanResolve } : {}),
      ...(typeof node.viewerCanUnresolve === "boolean" ? { viewerCanUnresolve: node.viewerCanUnresolve } : {}),
    });
  }
  const reviews: PullRequestReviewSummary[] = [];
  for (const node of nodes(pullRequest.reviews).slice(-MAX_REVIEWS)) {
    if (!isRecordValue(node)) continue;
    const id = stringField(node.id);
    const body = stringField(node.body);
    const state = node.state;
    if (!id || !body || (state !== "CHANGES_REQUESTED" && state !== "COMMENTED" && state !== "APPROVED")) continue;
    const url = httpUrl(stringField(node.url));
    reviews.push({
      id: id.slice(0, 200),
      author: authorOf(node),
      state,
      body: body.slice(0, MAX_COMMENT_CHARS),
      ...(url ? { url } : {}),
    });
  }
  return { threads, reviews };
}

function reviewComment(value: unknown): PullRequestReviewComment[] {
  if (!isRecordValue(value)) return [];
  const body = typeof value.body === "string" ? value.body.trim() : "";
  if (!body) return [];
  const url = httpUrl(stringField(value.url));
  const createdAt = stringField(value.createdAt);
  const id = stringField(value.id);
  return [
    {
      ...(id ? { id: id.slice(0, 200) } : {}),
      author: authorOf(value),
      body: body.slice(0, MAX_COMMENT_CHARS),
      ...(url ? { url } : {}),
      ...(createdAt ? { createdAt: createdAt.slice(0, 40) } : {}),
    },
  ];
}

function authorOf(value: Record<string, unknown>): string {
  const author = value.author;
  return (isRecordValue(author) ? stringField(author.login) : undefined)?.slice(0, 100) ?? "ghost";
}

/**
 * The last lines of a hunk, which end at the line the comment is on. The @@ header stays only when
 * nothing was cut, since its line numbers describe the start of the hunk.
 */
export function hunkTail(hunk: string): string {
  const lines = hunk.replace(/\r\n?/gu, "\n").replace(/\n$/u, "").split("\n");
  const tail = lines.length > MAX_HUNK_LINES ? lines.slice(-MAX_HUNK_LINES) : lines;
  return tail.join("\n").slice(-8_000);
}

function nodes(connection: unknown): unknown[] {
  return isRecordValue(connection) && Array.isArray(connection.nodes) ? connection.nodes : [];
}

function pathIn(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecordValue(current)) return undefined;
    current = current[key];
  }
  return current;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fromUrl(url: string | undefined, draft: boolean): PullRequestInfo | undefined {
  const number = url ? Number(/\/pull\/(\d+)/u.exec(url)?.[1]) : Number.NaN;
  if (!url || !Number.isSafeInteger(number) || number <= 0) return undefined;
  return { number, url, state: "OPEN", isDraft: draft };
}

export function isMissingProgram(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

const PROMPTLESS_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  NO_COLOR: "1",
};

export const runProcess: ProcessRunner = (command, args, options) =>
  new Promise<ProcessResult>((resolve, reject) => {
    const child = spawnCli(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...PROMPTLESS_ENV },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (options.input !== undefined) {
      // A child that exits before reading everything closes the pipe; its exit code tells what happened.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input);
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(
          new PullRequestError(
            `${command} ${args[0] ?? ""} did not finish within ${options.timeoutMs / 1000} seconds.`,
          ),
        ),
      );
    }, options.timeoutMs);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const limit = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    const append = (current: string, chunk: Buffer) =>
      current.length >= limit ? current : current + chunk.toString("utf8");
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => resolve({ code: code ?? -1, stdout, stderr })));
  });
