import type {
  IssueDetail,
  IssueListUnavailable,
  IssueSource,
  IssueSummary,
  ListedProviderKind,
} from "@zli-v2/contracts";

import { branchFromTemplate } from "../settings/appSettings.js";

const LINKS_KEY = "zli.issueLinks.v1";
const SOURCES_KEY = "zli.issueSources.v1";
const MAX_LINKS = 200;
const MAX_SOURCES = 200;
const MAX_SLUG = 40;
const MAX_PROMPT_BODY = 12_000;
const MAX_PROMPT_COMMENTS = 5;
const MAX_PROMPT_COMMENT = 2_000;

export const ISSUE_SOURCE_NAMES: Record<IssueSource, string> = { github: "GitHub", gitlab: "GitLab", linear: "Linear" };
const ISSUE_SOURCES: readonly IssueSource[] = ["github", "gitlab", "linear"];

function isIssueSource(value: unknown): value is IssueSource {
  return ISSUE_SOURCES.includes(value as IssueSource);
}

/** What a worktree or session remembers about the issue it was started from. */
export type IssueLink = {
  source: IssueSource;
  key: string;
  reference: string;
  title: string;
  url: string;
  sessionId?: string;
  linkedAt: string;
};

export type IssueRef = Pick<IssueSummary, "source" | "key" | "reference" | "title">;

/** `issue-123-fix-the-login` for GitHub and GitLab, `eng-123-fix-the-login` for Linear. */
export function issueSlug(issue: IssueRef): string {
  const stem = issue.source === "linear" ? issue.key.toLowerCase() : `issue-${issue.key}`;
  const words = issue.title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > MAX_SLUG) break;
    slug = next;
  }
  if (!slug && words[0]) slug = words[0].slice(0, MAX_SLUG);
  return slug ? `${stem}-${slug}` : stem;
}

/**
 * The branch for an agent started from an issue. A template with `{issue}` puts the issue there;
 * otherwise the template's folder part, such as `zli/` in `zli/{agent}-{random}`, is kept in front.
 */
export function issueBranchName(
  template: string,
  provider: ListedProviderKind | undefined,
  issue: IssueRef,
  now: Date = new Date(),
  random?: () => string,
): string {
  const slug = issueSlug(issue);
  const fill = (value: string) =>
    random ? branchFromTemplate(value, provider, now, random) : branchFromTemplate(value, provider, now);
  if (template.includes("{issue}")) return fill(template.replaceAll("{issue}", slug));
  const folder = template.slice(0, template.lastIndexOf("/") + 1);
  return folder ? fill(`${folder}${slug}`) : fill(slug);
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()}\n[cut]` : trimmed;
}

/** The first message for an agent working on the issue. */
export function issuePrompt(issue: IssueDetail): string {
  const source = ISSUE_SOURCE_NAMES[issue.source];
  const lines = [`Work on ${source} issue ${issue.reference}: ${issue.title}`, issue.url, ""];
  lines.push(issue.body.trim() ? clip(issue.body, MAX_PROMPT_BODY) : "The issue has no description.");
  const comments = issue.comments.filter((comment) => comment.body.trim()).slice(-MAX_PROMPT_COMMENTS);
  if (comments.length > 0) {
    lines.push("", comments.length === 1 ? "Latest comment:" : `Latest ${comments.length} comments:`);
    for (const comment of comments) {
      const when = comment.createdAt ? ` on ${comment.createdAt.slice(0, 10)}` : "";
      lines.push("", `${comment.author ?? "Someone"}${when}:`, clip(comment.body, MAX_PROMPT_COMMENT));
    }
  }
  const request = issue.source === "gitlab" ? "merge request" : "PR";
  lines.push("", `When you finish, mention Fixes ${issue.reference} in the ${request}.`);
  return lines.join("\n");
}

/** Adds `Fixes #123` to a pull request description unless it already names the issue. */
export function withIssueReference(body: string, link: Pick<IssueLink, "reference"> | undefined): string {
  if (!link) return body;
  const escaped = link.reference.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const named = new RegExp(`(^|[^\\w-])${escaped}(?![\\w-])`, link.reference.startsWith("#") ? "u" : "iu");
  if (named.test(body)) return body;
  const line = `Fixes ${link.reference}`;
  return body.trim() ? `${body.trimEnd()}\n\n${line}` : line;
}

function readLinks(): Record<string, IssueLink> {
  try {
    const value = JSON.parse(window.localStorage.getItem(LINKS_KEY) ?? "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const links: Record<string, IssueLink> = {};
    for (const [worktreeId, entry] of Object.entries(value as Record<string, unknown>)) {
      const link = parseLink(entry);
      if (link) links[worktreeId] = link;
    }
    return links;
  } catch {
    return {};
  }
}

function parseLink(value: unknown): IssueLink | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  const strings = ["key", "reference", "title", "url", "linkedAt"] as const;
  if (!isIssueSource(entry.source)) return undefined;
  if (!strings.every((field) => typeof entry[field] === "string" && entry[field])) return undefined;
  return {
    source: entry.source,
    key: entry.key as string,
    reference: entry.reference as string,
    title: entry.title as string,
    url: entry.url as string,
    linkedAt: entry.linkedAt as string,
    ...(typeof entry.sessionId === "string" && entry.sessionId ? { sessionId: entry.sessionId } : {}),
  };
}

/** Remembers which issue a worktree was started for, so its pull request can close the issue. */
export function rememberIssueLink(worktreeId: string, link: IssueLink): void {
  const links = { ...readLinks(), [worktreeId]: link };
  const kept = Object.entries(links)
    .sort(([, left], [, right]) => right.linkedAt.localeCompare(left.linkedAt))
    .slice(0, MAX_LINKS);
  try {
    window.localStorage.setItem(LINKS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // The link only prefills the pull request description; losing it is harmless.
  }
}

export function issueLinkFor(worktreeId: string): IssueLink | undefined {
  return readLinks()[worktreeId];
}

function readSources(): Record<string, IssueSource> {
  try {
    const value = JSON.parse(window.localStorage.getItem(SOURCES_KEY) ?? "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, IssueSource] =>
        isIssueSource(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

/** The issue source last used in a project, if one was picked there. */
export function lastIssueSource(projectId: string): IssueSource | undefined {
  return readSources()[projectId];
}

export function rememberIssueSource(projectId: string, source: IssueSource): void {
  const { [projectId]: _previous, ...rest } = readSources();
  // Newest last, so the oldest projects are the ones dropped.
  const kept = Object.entries({ ...rest, [projectId]: source }).slice(-MAX_SOURCES);
  try {
    window.localStorage.setItem(SOURCES_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Only the starting source depends on it.
  }
}

/**
 * The source the issues dialog shows: the one picked last when it still applies, then the forge the
 * project's remote is on, then Linear. Undefined while that depends on a Linear status not known yet;
 * null when no source applies.
 */
export function pickIssueSource(
  picked: IssueSource | undefined,
  forges: readonly IssueSource[],
  linear: { connected: boolean } | undefined,
): IssueSource | null | undefined {
  if (picked === "linear") {
    if (!linear) return undefined;
    if (linear.connected) return "linear";
  } else if (picked && forges.includes(picked)) {
    return picked;
  }
  if (forges[0]) return forges[0];
  if (!linear) return undefined;
  return linear.connected ? "linear" : null;
}

/** What the issues dialog says when a project has no GitHub or GitLab issues to list. */
export function unavailableText(unavailable: IssueListUnavailable): { title: string; detail: string } {
  const detail = "ZLI can read issues from GitHub, GitLab, and Linear today.";
  switch (unavailable.code) {
    case "other_host":
      return {
        title: unavailable.host
          ? `This project's remote is on ${unavailable.host}.`
          : "This project's remotes are not on GitHub or GitLab.",
        detail,
      };
    case "no_remote":
      return {
        title: "This project has no Git remote.",
        detail: "Add a GitHub or GitLab remote to see its issues here. ZLI can also read issues from Linear.",
      };
    case "not_repo":
      return { title: "This project is not a Git repository.", detail };
  }
}

/** Short relative time for list rows, such as 3h or 2d; older dates show as the day. */
export function updatedLabel(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const minutes = Math.max(0, Math.round((now.getTime() - time) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return iso.slice(0, 10);
}
