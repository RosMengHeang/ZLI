import {
  type GitBranchesResult,
  type IssueSource,
  type IssueSummary,
  type PullRequestInfo,
  type RuntimeProjection,
  TerminalReadResult,
  type ThreadMessageProjection,
} from "@zli-v2/contracts";
import { useEffect, useMemo, useState } from "react";

import { type FileIndex, useFileIndex } from "../files/FileIndex.js";
import { type Dispatch, listFiles, readFileDiff } from "../files/fileClient.js";
import { fuzzyMatch } from "../files/fuzzy.js";
import { getIssue, issueSources, listIssues } from "../issues/issuesClient.js";
import { trackText } from "../review/branches.js";
import { listBranches } from "../review/pullRequestClient.js";
import { refreshPullRequest, usePullRequestEntries } from "../review/pullRequestStore.js";
import { makeCommandId } from "../runtime/commandId.js";
import { useRuntime, useRuntimeSelector } from "../runtime/RuntimeProvider.js";
import { conversationThreads, deriveSessions, sessionTitle } from "../sessions/sessions.js";
import { attachedSection, splitAttachedContext } from "./attachedContext.js";

/** What "#" can attach: things ZLI knows about that the agent cannot see on its own. */
export type ContextKind = "diff" | "chat" | "pullRequest" | "issue" | "branch" | "terminal" | "browser";

export type ContextChoice = {
  key: string;
  kind: ContextKind;
  label: string;
  detail?: string | undefined;
  /** The block that goes out with the message, read when it is sent. */
  load(): Promise<string>;
};

export const CONTEXT_GROUPS: Record<ContextKind, string> = {
  diff: "Changes",
  chat: "Chats",
  pullRequest: "Pull requests",
  issue: "Issues",
  branch: "Branches",
  terminal: "Terminals",
  browser: "Browser",
};

/** Words that find a whole group, so "#pr" lists pull requests and "#term" lists terminals. */
const GROUP_WORDS: Record<ContextKind, string> = {
  diff: "diff changes uncommitted",
  chat: "chat session",
  pullRequest: "pr pull request",
  issue: "issue",
  branch: "branch",
  terminal: "terminal output",
  browser: "browser page",
};

const ORDER: readonly ContextKind[] = ["diff", "chat", "pullRequest", "issue", "branch", "terminal", "browser"];
const PER_GROUP = 8;

export const MAX_DIFF_CHARS = 24_000;
const MAX_DIFF_FILES = 30;
export const TERMINAL_LINES = 80;
const TERMINAL_BYTES = 32 * 1024;
const MAX_TRANSCRIPT_MESSAGES = 8;
const MAX_TRANSCRIPT_CHARS = 6_000;
const MAX_BODY_CHARS = 4_000;

/** Fuzzy on the label, detail, and group words. Groups keep their order; the best match leads each one. */
export function matchContext(query: string, choices: readonly ContextChoice[]): ContextChoice[] {
  const needle = query.trim();
  const scored = choices.flatMap((choice) => {
    if (!needle) return [{ choice, score: 0 }];
    // Read as a path whose file name is the label, so word starts and the label count most.
    const text = [GROUP_WORDS[choice.kind], choice.detail ?? "", choice.label]
      .map((part) => part.replaceAll("/", "-").replace(/\s+/gu, "-"))
      .join("/");
    const match = fuzzyMatch(needle, text);
    // Letters scattered across unrelated words are not a match.
    return match && match.score >= needle.length * 3 ? [{ choice, score: match.score }] : [];
  });
  return ORDER.flatMap((kind) =>
    scored
      .filter((entry) => entry.choice.kind === kind)
      .sort((left, right) => right.score - left.score)
      .slice(0, PER_GROUP)
      .map((entry) => entry.choice),
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n(cut at ${max.toLocaleString("en-US")} characters)` : text;
}

function fenced(body: string, language = ""): string {
  const longest = Math.max(0, ...(body.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${body}\n${fence}`;
}

/**
 * One attached block: a heading the agent can tell apart from what the person typed, then the body, in a
 * marked section the chat shows as a tag named `label`.
 */
export function contextBlock(kind: ContextKind, label: string, heading: string, body: string): string {
  return attachedSection(kind, label, `### Context: ${heading}\n\n${body.trim()}`);
}

/** A quoted message: its words, with what it had attached named instead of repeated. */
function quoted(text: string): string {
  const { body, attachments } = splitAttachedContext(text.trim());
  if (attachments.length === 0) return body;
  const names = `(Attached: ${attachments.map((attachment) => attachment.label || attachment.kind).join(", ")}.)`;
  return body ? `${body}\n${names}` : names;
}

/** Appends the picked "#" blocks after the message, the way skill requests go after it. */
export function withContextBlocks(text: string, blocks: readonly string[]): string {
  const present = blocks.filter((block) => block.trim());
  if (present.length === 0) return text;
  const joined = present.join("\n\n");
  return text ? `${text}\n\n${joined}` : joined;
}

/** The chat's latest few messages, for another chat to read. */
export function recentTranscript(title: string, messages: readonly ThreadMessageProjection[]): string {
  const said = messages.filter(
    (message) => (message.role === "user" || message.role === "assistant") && message.text.trim(),
  );
  const recent = said.slice(-MAX_TRANSCRIPT_MESSAGES);
  let body = recent
    .map((message) => `${message.role === "user" ? "User" : "Agent"}: ${quoted(message.text)}`)
    .join("\n\n");
  if (body.length > MAX_TRANSCRIPT_CHARS) body = `…${body.slice(-MAX_TRANSCRIPT_CHARS)}`;
  const earlier = said.length > recent.length ? `(${said.length - recent.length} earlier messages left out.)\n\n` : "";
  return contextBlock(
    "chat",
    `Chat · ${title}`,
    `the chat "${title}"`,
    body ? `${earlier}${body}` : "Nothing has been said in it yet.",
  );
}

/** The last `lines` lines of a terminal. */
export function terminalTail(text: string, lines = TERMINAL_LINES): string {
  const all = text.replace(/\s+$/u, "").split(/\r?\n/u);
  return all.slice(-lines).join("\n");
}

export function pullRequestBlock(pullRequest: PullRequestInfo): string {
  const state = pullRequest.isDraft ? "draft" : pullRequest.state.toLowerCase();
  const lines = [`${pullRequest.url}`, `State: ${state}`];
  if (pullRequest.headRefName && pullRequest.baseRefName)
    lines.push(`Branch: ${pullRequest.headRefName} into ${pullRequest.baseRefName}`);
  if (pullRequest.changedFiles !== undefined)
    lines.push(
      `Changes: ${pullRequest.changedFiles} files, +${pullRequest.additions ?? 0} -${pullRequest.deletions ?? 0}`,
    );
  const body = pullRequest.body?.trim();
  if (body) lines.push("", clip(body, MAX_BODY_CHARS));
  const name = `#${pullRequest.number}${pullRequest.title ? ` ${pullRequest.title}` : ""}`;
  return contextBlock("pullRequest", `PR ${name}`, `pull request ${name}`, lines.join("\n"));
}

/** Uncommitted changes as one diff, cut to a size the agent can read in one go. */
export async function diffBlock(dispatch: Dispatch, worktreeId: string): Promise<string> {
  const { files } = await listFiles(dispatch, worktreeId);
  const changed = files.filter((file) => file.status);
  if (changed.length === 0)
    return contextBlock("diff", "Uncommitted changes", "uncommitted changes", "There are no uncommitted changes.");
  const patches: string[] = [];
  let size = 0;
  let left = 0;
  for (const file of changed.slice(0, MAX_DIFF_FILES)) {
    if (size >= MAX_DIFF_CHARS) {
      left += 1;
      continue;
    }
    const diff = await readFileDiff(dispatch, worktreeId, file.path);
    const patch = diff.binary ? `Binary file ${file.path} changed.` : diff.patch.trim();
    if (!patch) continue;
    const room = MAX_DIFF_CHARS - size;
    patches.push(patch.length > room ? `${patch.slice(0, room)}\n(cut)` : patch);
    size += Math.min(patch.length, room);
  }
  left += Math.max(0, changed.length - MAX_DIFF_FILES);
  const note = left > 0 ? `\n\n(${left} more changed files left out.)` : "";
  const count = changed.length === 1 ? "1 file" : `${changed.length} files`;
  return contextBlock(
    "diff",
    `Uncommitted changes · ${count}`,
    `uncommitted changes, ${count}`,
    `${fenced(patches.join("\n"), "diff")}${note}`,
  );
}

async function terminalBlock(dispatch: Dispatch, terminalId: string, title: string): Promise<string> {
  const response = await dispatch({
    protocolVersion: 1,
    commandId: makeCommandId(),
    command: { type: "terminal.read", terminalId, maxBytes: TERMINAL_BYTES },
  });
  if (!response) throw new Error("ZLI is not connected to its runtime.");
  if (!response.accepted) throw new Error(response.error.message);
  const { text } = TerminalReadResult.parse(response.result);
  const tail = terminalTail(text);
  return contextBlock(
    "terminal",
    `${title} · last ${TERMINAL_LINES} lines`,
    `terminal "${title}", last ${TERMINAL_LINES} lines`,
    tail ? fenced(tail) : "The terminal has no output yet.",
  );
}

function branchBlock(name: string, branches: GitBranchesResult): string {
  const upstream = branches.details?.[name]?.upstream;
  const lines = [
    name === branches.current ? "Checked out in this worktree." : "Not checked out here.",
    upstream ? `Tracks ${upstream.name}${trackText(upstream) ? ` (${trackText(upstream)})` : ""}.` : "",
    branches.defaultBranch ? `The default branch is ${branches.defaultBranch}.` : "",
  ].filter(Boolean);
  return contextBlock("branch", `Branch ${name}`, `branch ${name}`, lines.join("\n"));
}

const SOURCES_MAX_AGE_MS = 30_000;
type Loaded = { at: number; result: Promise<unknown> };
const loadCache = new Map<string, Loaded>();

/** One read per key per half minute, shared by every message box. */
function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
  const hit = loadCache.get(key);
  if (hit && Date.now() - hit.at < SOURCES_MAX_AGE_MS) return hit.result as Promise<T>;
  const result = read();
  loadCache.set(key, { at: Date.now(), result });
  result.catch(() => loadCache.delete(key));
  return result;
}

/** Forgets loaded issues and branches. For tests. */
export function resetContextSourceCache(): void {
  loadCache.clear();
}

function useLoaded<T>(key: string | undefined, read: () => Promise<T>): T | undefined {
  const [state, setState] = useState<{ key: string; value: T }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key names what read loads.
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    cached(key, read).then(
      (value) => {
        if (!cancelled) setState({ key, value });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [key]);
  return state && state.key === key ? state.value : undefined;
}

const whole = (projection: RuntimeProjection | undefined) => projection;
const none = () => undefined;

type IssueList = { source: IssueSource; issues: readonly IssueSummary[] };

/**
 * Everything "#" offers for the chat's worktree and project. Reads only while `wanted`, so a closed list
 * costs nothing.
 */
export function useContextChoices({
  wanted,
  worktreeId,
  projectId,
  currentChat,
}: {
  wanted: boolean;
  worktreeId: string | undefined;
  projectId: string | undefined;
  /** The chat this box belongs to, by session or thread id, left out of Chats. */
  currentChat: string | undefined;
}): { choices: ContextChoice[]; loading: boolean } {
  const { dispatch } = useRuntime();
  const projection = useRuntimeSelector(wanted ? whole : none);
  const index: FileIndex | undefined = useFileIndex(wanted ? worktreeId : undefined, { maxAgeMs: 15_000 });
  const pullRequests = usePullRequestEntries();
  // The branch's pull request is usually known already; ask once if it is not.
  useEffect(() => {
    if (wanted && worktreeId && !pullRequests.has(worktreeId))
      void refreshPullRequest(dispatch, worktreeId).catch(() => undefined);
  }, [wanted, worktreeId, pullRequests, dispatch]);
  const branches = useLoaded(wanted && worktreeId ? `branches:${worktreeId}` : undefined, () =>
    listBranches(dispatch, worktreeId as string),
  );
  const issues = useLoaded(
    wanted && projectId ? `issues:${projectId}` : undefined,
    async (): Promise<IssueList | undefined> => {
      const { sources } = await issueSources(dispatch, projectId as string);
      const source = sources[0];
      if (!source) return undefined;
      const result = await listIssues(dispatch, projectId as string, source, { state: "open" });
      return { source, issues: result.issues };
    },
  );

  const choices = useMemo((): ContextChoice[] => {
    if (!wanted || !projection) return [];
    const out: ContextChoice[] = [];
    const projectWorktrees = projection.worktrees.filter(
      (worktree) => worktree.worktreeId === worktreeId || (projectId && worktree.projectId === projectId),
    );
    const inProject = new Set<string>(projectWorktrees.map((worktree) => worktree.worktreeId));

    const changed = index?.entries.filter((entry) => entry.status).length ?? 0;
    if (worktreeId && changed > 0) {
      out.push({
        key: "diff",
        kind: "diff",
        label: "Uncommitted changes",
        detail: changed === 1 ? "1 file" : `${changed} files`,
        load: () => diffBlock(dispatch, worktreeId),
      });
    }

    const messages = projection.messages ?? [];
    for (const session of deriveSessions(projection)) {
      const thread = session.thread;
      if (!thread || session.mode !== "chat" || !inProject.has(session.worktreeId)) continue;
      if (currentChat && (session.sessionId === currentChat || thread.threadId === currentChat)) continue;
      const chain = new Set(conversationThreads(thread, session.threads).map((entry) => entry.threadId));
      const said = messages.filter((message) => chain.has(message.threadId));
      if (!said.some((message) => message.role === "user")) continue;
      const title = sessionTitle(session, messages, projection.providers);
      const worktree = projectWorktrees.find((entry) => entry.worktreeId === session.worktreeId);
      out.push({
        key: `chat:${session.sessionId}`,
        kind: "chat",
        label: title,
        detail: worktree?.branch,
        load: async () => recentTranscript(title, said),
      });
    }

    for (const worktree of projectWorktrees) {
      const pullRequest = pullRequests.get(worktree.worktreeId)?.status?.pullRequest;
      if (!pullRequest) continue;
      out.push({
        key: `pr:${pullRequest.number}`,
        kind: "pullRequest",
        label: `#${pullRequest.number} ${pullRequest.title ?? worktree.branch}`,
        detail: pullRequest.isDraft
          ? "Draft"
          : pullRequest.state === "OPEN"
            ? "Open"
            : pullRequest.state === "MERGED"
              ? "Merged"
              : "Closed",
        load: async () => pullRequestBlock(pullRequest),
      });
    }

    if (issues && projectId) {
      for (const issue of issues.issues) {
        out.push({
          key: `issue:${issue.key}`,
          kind: "issue",
          label: `${issue.reference} ${issue.title}`,
          detail: issue.stateName ?? undefined,
          load: async () => {
            const { issue: detail } = await getIssue(dispatch, projectId, issues.source, issue.key);
            const body = detail.body.trim()
              ? clip(detail.body.trim(), MAX_BODY_CHARS)
              : "The issue has no description.";
            const name = `${detail.reference} ${detail.title}`;
            return contextBlock("issue", `Issue ${name}`, `issue ${name}`, `${detail.url}\n\n${body}`);
          },
        });
      }
    }

    if (branches) {
      const names = [...new Set([...(branches.current ? [branches.current] : []), ...branches.local])];
      for (const name of names) {
        out.push({
          key: `branch:${name}`,
          kind: "branch",
          label: name,
          detail: name === branches.current ? "Current" : undefined,
          load: async () => branchBlock(name, branches),
        });
      }
    }

    for (const terminal of projection.terminals) {
      if (terminal.worktreeId !== worktreeId) continue;
      const title = terminal.name ?? (terminal.title.trim() || "Terminal");
      out.push({
        key: `terminal:${terminal.terminalId}`,
        kind: "terminal",
        label: title,
        detail: terminal.kind === "agent" ? "Agent" : terminal.status === "running" ? "Running" : undefined,
        load: () => terminalBlock(dispatch, terminal.terminalId, title),
      });
    }

    for (const tab of projection.browserTabs) {
      if (tab.worktreeId !== worktreeId || !tab.url) continue;
      const title = tab.title.trim() || tab.url;
      out.push({
        key: `browser:${tab.browserTabId}`,
        kind: "browser",
        label: title,
        detail: tab.url,
        load: async () =>
          contextBlock(
            "browser",
            `Page · ${title}`,
            "the page open in ZLI's browser",
            `Title: ${tab.title.trim() || "none"}\nURL: ${tab.url}`,
          ),
      });
    }
    return out;
  }, [wanted, projection, worktreeId, projectId, currentChat, index, pullRequests, issues, branches, dispatch]);

  const loading = wanted && (!projection || (Boolean(worktreeId) && !index));
  return { choices, loading };
}
