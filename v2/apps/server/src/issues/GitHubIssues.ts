import {
  type IssueComment,
  IssueDetail,
  type IssueLabel,
  type IssueListResult,
  type IssueStateFilter,
  IssueSummary,
} from "@zli-v2/contracts";

import {
  GH_MISSING,
  GH_SIGNED_OUT,
  ghFailure,
  isMissingProgram,
  type ProcessResult,
  type ProcessRunner,
  runProcess,
} from "../review/PullRequestService.js";
import { IssueError, truncate } from "./issueText.js";

const GH_TIMEOUT_MS = 60_000;
const GH_READY_MS = 5 * 60_000;
const LIST_LIMIT = 50;
const MAX_COMMENTS = 30;
const LIST_FIELDS = "number,title,state,labels,assignees,author,updatedAt,url,comments";
const VIEW_FIELDS = `${LIST_FIELDS},body`;

const NO_REMOTE =
  "This folder has no Git remote. Issues come from the GitHub repository a remote points to. Add one with git remote add origin <url>, then try again.";
const NOT_GITHUB = "None of this folder's Git remotes point to a GitHub repository, so it has no GitHub issues.";
const NOT_REPO = "This folder is not a Git repository, so it has no GitHub issues.";

export type GitHubIssueFilter = {
  query?: string;
  state?: IssueStateFilter;
  assignee?: "me";
  labels?: readonly string[];
};

/** Reads GitHub issues with the GitHub CLI in the project folder, which picks the repository from its remotes. */
export class GitHubIssues {
  private ghReadyUntil = 0;

  constructor(private readonly runner: ProcessRunner = runProcess) {}

  async list(cwd: string, filter: GitHubIssueFilter): Promise<IssueListResult> {
    await this.ready(cwd);
    const query = filter.query?.trim() ?? "";
    const number = /^#?(\d{1,10})$/u.exec(query)?.[1];
    if (number) {
      const view = await this.gh(["issue", "view", number, "--json", LIST_FIELDS], cwd);
      if (view.code === 0) {
        const issue = parseGitHubIssue(view.stdout);
        return { issues: issue ? [summaryOf(issue)] : [] };
      }
      if (!isNotFound(view)) throw new IssueError(listFailure(view));
    }
    const args = ["issue", "list", "--json", LIST_FIELDS, "--limit", String(LIST_LIMIT)];
    args.push("--state", filter.state ?? "open");
    if (filter.assignee === "me") args.push("--assignee", "@me");
    for (const label of filter.labels ?? []) args.push("--label", label);
    if (query && !number) args.push("--search", query);
    const result = await this.gh(args, cwd);
    if (result.code !== 0) throw new IssueError(listFailure(result));
    return { issues: parseGitHubIssueList(result.stdout) };
  }

  async get(cwd: string, number: string): Promise<IssueDetail> {
    if (!/^\d{1,10}$/u.test(number)) throw new IssueError("GitHub issues are named by number, such as 123.");
    await this.ready(cwd);
    const result = await this.gh(["issue", "view", number, "--json", VIEW_FIELDS], cwd);
    if (result.code !== 0) {
      if (isNotFound(result)) throw new IssueError(`Issue #${number} was not found in this repository.`);
      throw new IssueError(listFailure(result));
    }
    const issue = parseGitHubIssue(result.stdout);
    if (!issue) throw new IssueError("GitHub CLI returned an issue ZLI could not read.");
    return issue;
  }

  private async ready(cwd: string): Promise<void> {
    const remotes = await this.runner("git", ["remote"], { cwd, timeoutMs: GH_TIMEOUT_MS });
    if (remotes.code !== 0) {
      throw new IssueError(/not a git repository/iu.test(remotes.stderr) ? NOT_REPO : NO_REMOTE);
    }
    if (!remotes.stdout.trim()) throw new IssueError(NO_REMOTE);
    if (Date.now() < this.ghReadyUntil) return;
    const version = await this.gh(["--version"], cwd);
    if (version.code !== 0) throw new IssueError(GH_MISSING);
    const auth = await this.gh(["auth", "status"], cwd);
    if (auth.code !== 0) throw new IssueError(GH_SIGNED_OUT);
    this.ghReadyUntil = Date.now() + GH_READY_MS;
  }

  private async gh(args: readonly string[], cwd: string): Promise<ProcessResult> {
    try {
      return await this.runner("gh", args, { cwd, timeoutMs: GH_TIMEOUT_MS });
    } catch (error) {
      if (isMissingProgram(error)) throw new IssueError(GH_MISSING);
      throw error;
    }
  }
}

function isNotFound(result: ProcessResult): boolean {
  return /could not resolve to an? (issue|issueorpullrequest)|issue .* not found|no issue found/iu.test(result.stderr);
}

function listFailure(result: ProcessResult): string {
  const output = `${result.stderr}\n${result.stdout}`;
  if (
    /none of the git remotes|no git remotes|unable to determine (the )?(base )?repo|not a known github host/iu.test(
      output,
    )
  ) {
    return NOT_GITHUB;
  }
  if (/gh auth login|not logged in|authentication required|HTTP 401/iu.test(output)) return GH_SIGNED_OUT;
  if (/could not resolve to a repository/iu.test(output)) {
    return "GitHub has no repository at this folder's remote, or this account cannot see it.";
  }
  if (/disabled issues|issues are disabled|has issues disabled/iu.test(output)) {
    return "Issues are turned off for this repository on GitHub.";
  }
  return ghFailure("could not read the issues", result);
}

type Raw = Record<string, unknown>;

function record(value: unknown): Raw | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function person(value: unknown): string | undefined {
  const entry = record(value);
  return entry ? (text(entry.login) ?? text(entry.name)) : undefined;
}

function labelsOf(value: unknown): IssueLabel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = record(item);
    const name = entry ? text(entry.name) : undefined;
    if (!entry || !name) return [];
    const color = text(entry.color);
    return [{ name: truncate(name, 200), ...(color && color.length <= 20 ? { color } : {}) }];
  });
}

function commentsOf(value: unknown): IssueComment[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      const entry = record(item);
      const body = entry && typeof entry.body === "string" ? entry.body : undefined;
      if (!entry || body === undefined) return [];
      const author = person(entry.author);
      const createdAt = text(entry.createdAt);
      return [{ body: truncate(body, 65_536), ...(author ? { author } : {}), ...(createdAt ? { createdAt } : {}) }];
    })
    .slice(-MAX_COMMENTS);
}

function fromRaw(raw: Raw): IssueDetail | undefined {
  const number = typeof raw.number === "number" ? raw.number : Number.NaN;
  if (!Number.isSafeInteger(number) || number <= 0) return undefined;
  const author = person(raw.author);
  const updatedAt = text(raw.updatedAt);
  const assignees = Array.isArray(raw.assignees)
    ? raw.assignees.flatMap((entry) => person(entry) ?? []).slice(0, 50)
    : [];
  const state = text(raw.state)?.toUpperCase();
  const parsed = IssueDetail.safeParse({
    source: "github",
    key: String(number),
    reference: `#${number}`,
    title: truncate(text(raw.title) ?? "", 1_000),
    state: state === "CLOSED" ? "closed" : "open",
    ...(state ? { stateName: state === "CLOSED" ? "Closed" : "Open" } : {}),
    url: raw.url,
    labels: labelsOf(raw.labels).slice(0, 50),
    assignees,
    ...(author ? { author } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(Array.isArray(raw.comments) ? { commentCount: raw.comments.length } : {}),
    body: truncate(typeof raw.body === "string" ? raw.body : "", 262_144),
    comments: commentsOf(raw.comments),
  });
  return parsed.success ? parsed.data : undefined;
}

function summaryOf(issue: IssueDetail): IssueSummary {
  const { body: _body, comments: _comments, branchName: _branch, ...summary } = issue;
  return summary;
}

/** Reads `gh issue list --json` output; entries ZLI cannot read are left out. */
export function parseGitHubIssueList(stdout: string): IssueSummary[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new IssueError("GitHub CLI returned an issue list ZLI could not read.");
  }
  if (!Array.isArray(raw)) throw new IssueError("GitHub CLI returned an issue list ZLI could not read.");
  return raw
    .flatMap((item) => {
      const entry = record(item);
      const issue = entry ? fromRaw(entry) : undefined;
      return issue ? [IssueSummary.parse(summaryOf(issue))] : [];
    })
    .slice(0, 100);
}

/** Reads `gh issue view --json` output, or undefined when it is not an issue. */
export function parseGitHubIssue(stdout: string): IssueDetail | undefined {
  try {
    const entry = record(JSON.parse(stdout));
    return entry ? fromRaw(entry) : undefined;
  } catch {
    return undefined;
  }
}
