import type { IssueCommand, IssueSourcesResult, RuntimeProjection } from "@zli-v2/contracts";

import { runProcess } from "../review/PullRequestService.js";
import { GitHubIssues } from "./GitHubIssues.js";
import { GitLabIssues } from "./GitLabIssues.js";
import { IssueError } from "./issueText.js";
import type { LinearIssues } from "./LinearIssues.js";
import { type ProjectRemotes, readProjectRemotes } from "./remotes.js";

export { IssueError } from "./issueText.js";

export type IssueSources = {
  github: GitHubIssues;
  gitlab?: GitLabIssues;
  linear?: LinearIssues;
  /** Reads where a project folder's remotes point. */
  remotes?: (cwd: string) => Promise<ProjectRemotes>;
};

const LINEAR_UNAVAILABLE = "Linear is not available in this runtime.";
const GITLAB_UNAVAILABLE = "GitLab is not available in this runtime.";

/** Runs one issue command against the project it names. */
export async function runIssueCommand(
  sources: IssueSources,
  projection: Pick<RuntimeProjection, "projects">,
  command: IssueCommand,
): Promise<unknown> {
  switch (command.type) {
    case "issues.linear.status":
      return sources.linear ? sources.linear.status() : { connected: false, problem: LINEAR_UNAVAILABLE };
    case "issues.linear.connect":
      if (!sources.linear) throw new IssueError(LINEAR_UNAVAILABLE);
      return sources.linear.connect(command.apiKey);
    case "issues.linear.disconnect":
      if (!sources.linear) throw new IssueError(LINEAR_UNAVAILABLE);
      return sources.linear.disconnect();
    case "issues.list":
    case "issues.get":
    case "issues.sources":
      break;
  }
  const project = projection.projects.find((candidate) => candidate.projectId === command.projectId);
  if (!project) throw new IssueError("Project does not exist.");
  if (command.type === "issues.sources") {
    const remotes = await (sources.remotes ?? ((cwd) => readProjectRemotes(runProcess, cwd)))(project.path);
    if (remotes.unavailable) return { sources: [], unavailable: remotes.unavailable } satisfies IssueSourcesResult;
    const forges = remotes.sources.filter((source) => source === "github" || sources.gitlab);
    return { sources: forges } satisfies IssueSourcesResult;
  }
  const filter = {
    ...(command.type === "issues.list" && command.query ? { query: command.query } : {}),
    ...(command.type === "issues.list" && command.state ? { state: command.state } : {}),
    ...(command.type === "issues.list" && command.assignee ? { assignee: command.assignee } : {}),
    ...(command.type === "issues.list" && command.labels ? { labels: command.labels } : {}),
  };
  if (command.source === "linear") {
    if (!sources.linear) throw new IssueError(LINEAR_UNAVAILABLE);
    return command.type === "issues.list"
      ? sources.linear.list(filter)
      : { issue: await sources.linear.get(command.key) };
  }
  if (command.source === "gitlab") {
    if (!sources.gitlab) throw new IssueError(GITLAB_UNAVAILABLE);
    return command.type === "issues.list"
      ? sources.gitlab.list(project.path, filter)
      : { issue: await sources.gitlab.get(project.path, command.key) };
  }
  return command.type === "issues.list"
    ? sources.github.list(project.path, filter)
    : { issue: await sources.github.get(project.path, command.key) };
}

export function defaultIssueSources(): IssueSources {
  return { github: new GitHubIssues(), gitlab: new GitLabIssues() };
}
