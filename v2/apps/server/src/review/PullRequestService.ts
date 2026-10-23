import {
  type PullRequestCheck,
  PullRequestCheckLogResult,
  type PullRequestCheckState,
  type PullRequestCommand,
  PullRequestCreateResult,
  PullRequestInfo,
  type PullRequestProblem,
  PullRequestPushResult,
  PullRequestStatusResult,
  type RuntimeProjection,
} from "@zli-v2/contracts";
import { spawnCli } from "@zli-v2/shared";

import { assertRef } from "./ReviewService.js";

export type ProcessResult = { code: number; stdout: string; stderr: string };

/** Runs `git` or `gh` without a shell. Resolves for any exit code; rejects when the program cannot start. */
export type ProcessRunner = (
  command: "git" | "gh",
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; maxOutputBytes?: number },
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
const PR_FIELDS = "url,state,isDraft,number,statusCheckRollup,reviewDecision";

const GH_MISSING =
  "GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com, then check again.";
const GH_SIGNED_OUT = "GitHub CLI is not signed in. Run gh auth login in a terminal, then check again.";
const NO_ORIGIN = "This repository has no origin remote. Add one with git remote add origin <url>, then check again.";
const DETACHED = "This worktree is not on a branch. Check out a branch to open a pull request from it.";
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

    const subjects = await this.subjectsSince(cwd, base);
    const defaults = {
      title: subjects?.at(-1) ?? branch,
      body: formatBody(subjects ?? []),
      base,
    };
    const extra = { defaults, ...(subjects ? { commitsAhead: subjects.length } : {}) };

    const problem = await this.ghProblem(cwd);
    if (problem) return result(problem, extra);
    const view = await this.gh(["pr", "view", branch, "--json", PR_FIELDS], cwd);
    if (view.code === 0) {
      const pullRequest = parsePullRequest(view.stdout);
      if (pullRequest) return result(undefined, { ...extra, pullRequest });
      return result({ code: "gh_failed", message: "GitHub CLI returned a pull request ZLI could not read." }, extra);
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

/** Runs one pull request command against the worktree it names. */
export async function runPullRequestCommand(
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
    case "review.pr.create":
      return service.create(input, {
        title: command.title,
        body: command.body,
        base: command.base,
        draft: command.draft,
      });
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

function ghFailure(action: string, result: ProcessResult): string {
  const detail = lastLines(result.stderr || result.stdout);
  return `GitHub CLI ${action}.${detail ? ` ${detail}` : ""}`;
}

function gitFailure(action: string, result: ProcessResult): string {
  const detail = lastLines(result.stderr);
  return `Git ${action}.${detail ? ` ${detail}` : ""}`;
}

function pushFailure(branch: string, result: ProcessResult): string {
  const output = `${result.stderr}\n${result.stdout}`;
  if (/\[rejected\]|non-fast-forward|fetch first|\[remote rejected\]/iu.test(output)) {
    return `origin rejected the push of ${branch}. The remote branch has commits this worktree does not have, or a rule on origin blocked it. Pull or rebase onto origin/${branch}, then try again.`;
  }
  if (/authentication failed|could not read username|permission denied|denied to|403/iu.test(output)) {
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
  const { statusCheckRollup, reviewDecision, ...rest } = raw as Record<string, unknown>;
  const checks = summarizeChecks(statusCheckRollup);
  const parsed = PullRequestInfo.safeParse({
    ...rest,
    ...(checks ? { checks } : {}),
    ...(reviewDecision === "APPROVED" || reviewDecision === "CHANGES_REQUESTED" || reviewDecision === "REVIEW_REQUIRED"
      ? { reviewDecision }
      : {}),
  });
  return parsed.success ? parsed.data : undefined;
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

function fromUrl(url: string | undefined, draft: boolean): PullRequestInfo | undefined {
  const number = url ? Number(/\/pull\/(\d+)/u.exec(url)?.[1]) : Number.NaN;
  if (!url || !Number.isSafeInteger(number) || number <= 0) return undefined;
  return { number, url, state: "OPEN", isDraft: draft };
}

function isMissingProgram(error: unknown): boolean {
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
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
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
