import { z } from "zod";

import { ProjectId } from "./ids.js";

export const IssueSource = z.enum(["github", "linear"]);
export type IssueSource = z.infer<typeof IssueSource>;

export const IssueStateFilter = z.enum(["open", "closed", "all"]);
export type IssueStateFilter = z.infer<typeof IssueStateFilter>;

/** A GitHub issue number or a Linear identifier such as ENG-123. */
export const IssueKey = z
  .string()
  .trim()
  .regex(/^(?:\d{1,10}|[A-Za-z][A-Za-z0-9]{0,15}-\d{1,10})$/u, "Use an issue number or an identifier like ENG-123.");

const LinearApiKey = z
  .string()
  .trim()
  .min(1, "Paste a Linear API key.")
  .max(500)
  .regex(/^[\x21-\x7e]+$/u, "The key has characters Linear keys never use.");

/** Handled directly by the runtime server; none of these reach the event log. */
export const IssueCommand = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("issues.list"),
    projectId: ProjectId,
    source: IssueSource,
    query: z.string().max(256).optional(),
    state: IssueStateFilter.optional(),
    assignee: z.literal("me").optional(),
    labels: z.array(z.string().trim().min(1).max(100)).max(10).optional(),
  }),
  z.object({ type: z.literal("issues.get"), projectId: ProjectId, source: IssueSource, key: IssueKey }),
  z.object({ type: z.literal("issues.linear.status") }),
  /** Checks the key with Linear before it is saved; the key is never sent back. */
  z.object({ type: z.literal("issues.linear.connect"), apiKey: LinearApiKey }),
  z.object({ type: z.literal("issues.linear.disconnect") }),
]);
export type IssueCommand = z.infer<typeof IssueCommand>;
export const ISSUE_COMMAND_TYPES = [
  "issues.list",
  "issues.get",
  "issues.linear.status",
  "issues.linear.connect",
  "issues.linear.disconnect",
] as const;

export const IssueLabel = z.object({ name: z.string().min(1).max(200), color: z.string().max(20).optional() });
export type IssueLabel = z.infer<typeof IssueLabel>;

/** One row of an issue list, the same shape for every source. */
export const IssueSummary = z.object({
  source: IssueSource,
  /** `123` on GitHub, `ENG-123` on Linear. */
  key: IssueKey,
  /** How the issue is written in text: `#123` or `ENG-123`. */
  reference: z.string().min(1).max(40),
  title: z.string().max(1_000),
  /** Open issues are anything not closed, completed, or canceled. */
  state: z.enum(["open", "closed"]),
  /** The source's own state name, such as In Progress on Linear. */
  stateName: z.string().max(100).optional(),
  url: z.string().url(),
  labels: z.array(IssueLabel).max(50),
  assignees: z.array(z.string().max(200)).max(50),
  author: z.string().max(200).optional(),
  updatedAt: z.string().max(64).optional(),
  commentCount: z.number().int().nonnegative().optional(),
});
export type IssueSummary = z.infer<typeof IssueSummary>;

export const IssueComment = z.object({
  author: z.string().max(200).optional(),
  body: z.string().max(65_536),
  createdAt: z.string().max(64).optional(),
});
export type IssueComment = z.infer<typeof IssueComment>;

export const IssueDetail = IssueSummary.extend({
  body: z.string().max(262_144),
  /** Oldest first. Long threads keep only the most recent comments. */
  comments: z.array(IssueComment).max(100),
  /** The branch name the source suggests, when it has one. */
  branchName: z.string().max(255).optional(),
});
export type IssueDetail = z.infer<typeof IssueDetail>;

/** Why a project has no GitHub issues to list, so the list is empty rather than failed. */
export const IssueListUnavailable = z.object({
  code: z.enum(["not_github", "no_remote", "not_repo"]),
  /** The host the project's remote points to, such as gitlab.example.com, when it has one. */
  host: z.string().min(1).max(253).optional(),
});
export type IssueListUnavailable = z.infer<typeof IssueListUnavailable>;

export const IssueListResult = z.object({
  issues: z.array(IssueSummary).max(100),
  unavailable: IssueListUnavailable.optional(),
});
export type IssueListResult = z.infer<typeof IssueListResult>;

export const IssueGetResult = z.object({ issue: IssueDetail });
export type IssueGetResult = z.infer<typeof IssueGetResult>;

export const LinearStatusResult = z.object({
  connected: z.boolean(),
  /** Who the saved key belongs to. */
  viewer: z.object({ name: z.string().max(200), email: z.string().max(320).optional() }).optional(),
  /** Set when a key is saved but Linear could not be reached or refused it. */
  problem: z.string().optional(),
});
export type LinearStatusResult = z.infer<typeof LinearStatusResult>;
