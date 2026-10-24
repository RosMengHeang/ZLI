import type { IssueCommand, RuntimeProjection } from "@zli-v2/contracts";

import { GitHubIssues } from "./GitHubIssues.js";
import { IssueError } from "./issueText.js";
import type { LinearIssues } from "./LinearIssues.js";

export { IssueError } from "./issueText.js";

export type IssueSources = { github: GitHubIssues; linear?: LinearIssues };

const LINEAR_UNAVAILABLE = "Linear is not available in this runtime.";

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
      break;
  }
  const project = projection.projects.find((candidate) => candidate.projectId === command.projectId);
  if (!project) throw new IssueError("Project does not exist.");
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
  return command.type === "issues.list"
    ? sources.github.list(project.path, filter)
    : { issue: await sources.github.get(project.path, command.key) };
}

export function defaultIssueSources(): IssueSources {
  return { github: new GitHubIssues() };
}
