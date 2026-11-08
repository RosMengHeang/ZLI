import {
  type IssueComment,
  IssueDetail,
  type IssueLabel,
  type IssueListResult,
  type IssueStateFilter,
  IssueSummary,
} from "@zli-v2/contracts";

import {
  cliFailure,
  isMissingProgram,
  type ProcessResult,
  type ProcessRunner,
  runProcess,
} from "../review/PullRequestService.js";
import { IssueError, truncate } from "./issueText.js";
import { CLI_HOSTS, type KnownHosts, type ProjectRemotes, readProjectRemotes } from "./remotes.js";

const GLAB_TIMEOUT_MS = 60_000;
const GLAB_READY_MS = 5 * 60_000;
const LIST_LIMIT = 50;
const MAX_COMMENTS = 30;

export const GLAB_MISSING =
  "GitLab CLI (glab) is not installed or not on PATH. Install it from https://gitlab.com/gitlab-org/cli, then try again.";
const NO_REMOTE =
  "This folder has no Git remote. Issues come from the GitLab project a remote points to. Add one with git remote add origin <url>, then try again.";
const NOT_REPO = "This folder is not a Git repository, so it has no GitLab issues.";

export function glabSignedOut(host: string): string {
  return `GitLab CLI is not signed in to ${host}. Run glab auth login --hostname ${host} in a terminal, then try again.`;
}

export type GitLabIssueFilter = {
  query?: string;
  state?: IssueStateFilter;
  assignee?: "me";
  labels?: readonly string[];
};

/** Reads GitLab issues with the GitLab CLI in the project folder, which picks the project from its remotes. */
export class GitLabIssues {
  private readonly readyUntil = new Map<string, number>();

  constructor(
    private readonly runner: ProcessRunner = runProcess,
    private readonly knownHosts: KnownHosts = CLI_HOSTS,
  ) {}

  async list(cwd: string, filter: GitLabIssueFilter): Promise<IssueListResult> {
    const remotes = await readProjectRemotes(this.runner, cwd, this.knownHosts);
    if (remotes.unavailable) return { issues: [], unavailable: remotes.unavailable };
    const host = await this.ready(cwd, remotes);
    const query = filter.query?.trim() ?? "";
    const number = /^#?(\d{1,10})$/u.exec(query)?.[1];
    if (number) {
      const view = await this.glab(["issue", "view", number, "--output", "json"], cwd);
      if (view.code === 0) {
        const issue = parseGitLabIssue(view.stdout);
        return { issues: issue ? [summaryOf(issue)] : [] };
      }
      if (!isNotFound(view)) throw new IssueError(listFailure(view, host));
    }
    const args = ["issue", "list", "--output", "json", "--per-page", String(LIST_LIMIT)];
    if (filter.state === "closed") args.push("--closed");
    if (filter.state === "all") args.push("--all");
    if (filter.assignee === "me") args.push("--assignee=@me");
    // The = form keeps a value that starts with a dash from being read as a flag.
    for (const label of filter.labels ?? []) args.push(`--label=${label}`);
    if (query && !number) args.push(`--search=${query}`);
    const result = await this.glab(args, cwd);
    if (result.code !== 0) throw new IssueError(listFailure(result, host));
    return { issues: parseGitLabIssueList(result.stdout) };
  }

  async get(cwd: string, number: string): Promise<IssueDetail> {
    if (!/^\d{1,10}$/u.test(number)) throw new IssueError("GitLab issues are named by number, such as 123.");
    const remotes = await readProjectRemotes(this.runner, cwd, this.knownHosts);
    if (remotes.unavailable) {
      if (remotes.unavailable.code === "not_repo") throw new IssueError(NOT_REPO);
      if (remotes.unavailable.code === "no_remote") throw new IssueError(NO_REMOTE);
      throw new IssueError(notGitLabMessage(remotes.unavailable.host));
    }
    const host = await this.ready(cwd, remotes);
    // glab lists comments oldest first, 20 at a time; the most it can fetch keeps the latest ones in reach.
    const args = ["issue", "view", number, "--comments", "--per-page", "100", "--output", "json"];
    const result = await this.glab(args, cwd);
    if (result.code !== 0) {
      if (isNotFound(result)) throw new IssueError(`Issue #${number} was not found in this project.`);
      throw new IssueError(listFailure(result, host));
    }
    const issue = parseGitLabIssue(result.stdout);
    if (!issue) throw new IssueError("GitLab CLI returned an issue ZLI could not read.");
    return issue;
  }

  private async ready(cwd: string, remotes: Exclude<ProjectRemotes, { unavailable: object }>): Promise<string> {
    const host = remotes.hosts.gitlab;
    if (!host) throw new IssueError(notGitLabMessage(remotes.host));
    if (Date.now() < (this.readyUntil.get(host) ?? 0)) return host;
    const version = await this.glab(["--version"], cwd);
    if (version.code !== 0) throw new IssueError(GLAB_MISSING);
    const auth = await this.glab(["auth", "status", "--hostname", host], cwd);
    if (auth.code !== 0) throw new IssueError(glabSignedOut(host));
    this.readyUntil.set(host, Date.now() + GLAB_READY_MS);
    return host;
  }

  private async glab(args: readonly string[], cwd: string): Promise<ProcessResult> {
    try {
      return await this.runner("glab", args, { cwd, timeoutMs: GLAB_TIMEOUT_MS });
    } catch (error) {
      if (isMissingProgram(error)) throw new IssueError(GLAB_MISSING);
      throw error;
    }
  }
}

function notGitLabMessage(host: string | undefined): string {
  return host
    ? `This folder's remote is on ${host}, not GitLab, so it has no GitLab issues.`
    : "None of this folder's Git remotes point to a GitLab project, so it has no GitLab issues.";
}

function isNotFound(result: ProcessResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return /\b404\b|issue not found|not found/iu.test(output) && !/project not found|404 project/iu.test(output);
}

function listFailure(result: ProcessResult, host: string): string {
  const output = `${result.stderr}\n${result.stdout}`;
  if (
    /glab auth login|not logged in|not authenticated|\b401\b|unauthorized|none of the git remotes|not a known gitlab host/iu.test(
      output,
    )
  ) {
    return glabSignedOut(host);
  }
  if (/project not found|404 project/iu.test(output)) {
    return "GitLab has no project at this folder's remote, or this account cannot see it.";
  }
  if (/\b403\b|forbidden/iu.test(output)) {
    return "GitLab did not let this account read the project's issues, or issues are turned off for it.";
  }
  return cliFailure("GitLab CLI", "could not read the issues", result);
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
  return entry ? (text(entry.username) ?? text(entry.name)) : undefined;
}

/** GitLab lists labels as names, or as objects when label details are asked for. */
function labelsOf(value: unknown): IssueLabel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const entry = record(item);
    const name = typeof item === "string" ? text(item) : entry ? text(entry.name) : undefined;
    if (!name) return [];
    const color = entry ? text(entry.color) : undefined;
    return [{ name: truncate(name, 200), ...(color && color.length <= 20 ? { color } : {}) }];
  });
}

/** Comments people wrote, oldest first; GitLab's own notes about changes are left out. */
function commentsOf(value: unknown): IssueComment[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      const entry = record(item);
      const body = entry && typeof entry.body === "string" ? entry.body : undefined;
      if (!entry || body === undefined || entry.system === true) return [];
      const author = person(entry.author);
      const createdAt = text(entry.created_at);
      return [{ body: truncate(body, 65_536), ...(author ? { author } : {}), ...(createdAt ? { createdAt } : {}) }];
    })
    .sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""))
    .slice(-MAX_COMMENTS);
}

function fromRaw(raw: Raw): IssueDetail | undefined {
  const iid = typeof raw.iid === "number" ? raw.iid : Number.NaN;
  if (!Number.isSafeInteger(iid) || iid <= 0) return undefined;
  const author = person(raw.author);
  const updatedAt = text(raw.updated_at);
  const people = Array.isArray(raw.assignees) ? raw.assignees : raw.assignee ? [raw.assignee] : [];
  const assignees = people.flatMap((entry) => person(entry) ?? []).slice(0, 50);
  const state = text(raw.state)?.toLowerCase();
  // glab puts the comments in Notes next to the issue's own fields.
  const notes = Array.isArray(raw.Notes) ? raw.Notes : raw.notes;
  const parsed = IssueDetail.safeParse({
    source: "gitlab",
    key: String(iid),
    reference: `#${iid}`,
    title: truncate(text(raw.title) ?? "", 1_000),
    state: state === "closed" ? "closed" : "open",
    ...(state ? { stateName: state === "closed" ? "Closed" : "Open" } : {}),
    url: raw.web_url,
    labels: labelsOf(raw.labels).slice(0, 50),
    assignees,
    ...(author ? { author } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(typeof raw.user_notes_count === "number" && raw.user_notes_count >= 0
      ? { commentCount: raw.user_notes_count }
      : {}),
    body: truncate(typeof raw.description === "string" ? raw.description : "", 262_144),
    comments: commentsOf(notes),
  });
  return parsed.success ? parsed.data : undefined;
}

function summaryOf(issue: IssueDetail): IssueSummary {
  const { body: _body, comments: _comments, branchName: _branch, ...summary } = issue;
  return summary;
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some glab versions print a line of text before the JSON.
    const start = trimmed.search(/^[[{]/mu);
    if (start <= 0) return undefined;
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return undefined;
    }
  }
}

/** Reads `glab issue list --output json` output; entries ZLI cannot read are left out. */
export function parseGitLabIssueList(stdout: string): IssueSummary[] {
  if (!stdout.trim()) return [];
  const raw = parseJson(stdout);
  if (!Array.isArray(raw)) throw new IssueError("GitLab CLI returned an issue list ZLI could not read.");
  return raw
    .flatMap((item) => {
      const entry = record(item);
      const issue = entry ? fromRaw(entry) : undefined;
      return issue ? [IssueSummary.parse(summaryOf(issue))] : [];
    })
    .slice(0, 100);
}

/** Reads `glab issue view --output json` output, or undefined when it is not an issue. */
export function parseGitLabIssue(stdout: string): IssueDetail | undefined {
  const entry = record(parseJson(stdout));
  return entry ? fromRaw(entry) : undefined;
}
