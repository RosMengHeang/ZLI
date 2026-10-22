import {
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
  options: { cwd: string; timeoutMs: number },
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
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_BODY_SUBJECTS = 50;
const PR_FIELDS = "url,state,isDraft,number";

const GH_MISSING =
  "GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com, then check again.";
const GH_SIGNED_OUT = "GitHub CLI is not signed in. Run gh auth login in a terminal, then check again.";
const NO_ORIGIN = "This repository has no origin remote. Add one with git remote add origin <url>, then check again.";
const DETACHED = "This worktree is not on a branch. Check out a branch to open a pull request from it.";

export class PullRequestService {
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

  private async view(cwd: string, target: string): Promise<PullRequestInfo | undefined> {
    const view = await this.gh(["pr", "view", target, "--json", PR_FIELDS], cwd);
    return view.code === 0 ? parsePullRequest(view.stdout) : undefined;
  }

  private async ghProblem(cwd: string): Promise<PullRequestProblem | undefined> {
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
    return undefined;
  }

  private async gh(args: readonly string[], cwd: string): Promise<ProcessResult> {
    try {
      return await this.runner("gh", args, { cwd, timeoutMs: GH_TIMEOUT_MS });
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
  try {
    const parsed = PullRequestInfo.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
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
    const append = (current: string, chunk: Buffer) =>
      current.length >= MAX_OUTPUT_BYTES ? current : current + chunk.toString("utf8");
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => resolve({ code: code ?? -1, stdout, stderr })));
  });
