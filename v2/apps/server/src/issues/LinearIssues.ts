import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  type IssueComment,
  IssueDetail,
  type IssueLabel,
  type IssueListResult,
  type IssueStateFilter,
  IssueSummary,
  type LinearStatusResult,
} from "@zli-v2/contracts";

import { IssueError, truncate } from "./issueText.js";

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const REQUEST_TIMEOUT_MS = 20_000;
const LIST_LIMIT = 50;
const MAX_COMMENTS = 30;
const CLOSED_TYPES = ["completed", "canceled"];

const KEY_REFUSED =
  "Linear did not accept this API key. Create a personal API key in Linear under Settings, Security and access, then connect again.";
const NOT_CONNECTED = "Linear is not connected. Add a personal API key in Settings, Issues.";
const UNREACHABLE = "Linear could not be reached. Check the internet connection and try again.";
const RATE_LIMITED = "Linear is limiting requests from this key right now. Try again in a minute.";

/** The part of `fetch` this client uses, so tests can stand in for Linear. */
export type LinearFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type LinearIssueFilter = {
  query?: string;
  state?: IssueStateFilter;
  assignee?: "me";
  labels?: readonly string[];
};

type StoredKey = { version: 1; apiKey: string };

const ROW_FIELDS = `id identifier title url updatedAt branchName
  state { name type }
  labels(first: 20) { nodes { name color } }
  assignee { name displayName }
  creator { name displayName }`;

const VIEWER_QUERY = "query ZliViewer { viewer { name displayName email } }";
const LIST_QUERY = `query ZliIssues($first: Int!, $filter: IssueFilter) {
  issues(first: $first, filter: $filter, orderBy: updatedAt) { nodes { ${ROW_FIELDS} } }
}`;
const ISSUE_QUERY = `query ZliIssue($id: String!) {
  issue(id: $id) {
    ${ROW_FIELDS}
    description
    comments(first: 100) { nodes { body createdAt user { name displayName } } }
  }
}`;

/**
 * Linear issues read with a personal API key. The key lives in a file beside the database that only
 * this user can read, and it never leaves the runtime except in requests to Linear.
 */
export class LinearIssues {
  private apiKey: string | undefined;
  private loaded = false;
  private viewer: LinearStatusResult["viewer"];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: { keyPath: string; fetch?: LinearFetch }) {}

  async status(): Promise<LinearStatusResult> {
    const apiKey = await this.key();
    if (!apiKey) return { connected: false };
    if (this.viewer) return { connected: true, viewer: this.viewer };
    try {
      this.viewer = await this.fetchViewer(apiKey);
      return { connected: true, viewer: this.viewer };
    } catch (error) {
      return { connected: true, problem: error instanceof IssueError ? error.message : UNREACHABLE };
    }
  }

  connect(apiKey: string): Promise<LinearStatusResult> {
    return this.serialize(async () => {
      const key = apiKey.trim();
      const viewer = await this.fetchViewer(key);
      await writePrivateFile(
        this.options.keyPath,
        `${JSON.stringify({ version: 1, apiKey: key } satisfies StoredKey)}\n`,
      );
      this.apiKey = key;
      this.loaded = true;
      this.viewer = viewer;
      return { connected: true, viewer };
    });
  }

  disconnect(): Promise<LinearStatusResult> {
    return this.serialize(async () => {
      await rm(this.options.keyPath, { force: true });
      this.apiKey = undefined;
      this.loaded = true;
      this.viewer = undefined;
      return { connected: false };
    });
  }

  async list(filter: LinearIssueFilter): Promise<IssueListResult> {
    const data = await this.request(LIST_QUERY, { first: LIST_LIMIT, filter: linearFilter(filter) });
    return { issues: parseLinearIssueList(data) };
  }

  async get(identifier: string): Promise<IssueDetail> {
    const data = await this.request(ISSUE_QUERY, { id: identifier });
    const issue = parseLinearIssue(data);
    if (!issue) throw new IssueError(`Issue ${identifier.toUpperCase()} was not found in Linear.`);
    return issue;
  }

  async waitForIdle(): Promise<void> {
    await this.queue.catch(() => undefined);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(work);
    this.queue = run;
    return run;
  }

  private async key(): Promise<string | undefined> {
    if (this.loaded) return this.apiKey;
    try {
      const parsed = JSON.parse(await readFile(this.options.keyPath, "utf8")) as Partial<StoredKey>;
      this.apiKey = typeof parsed.apiKey === "string" && parsed.apiKey ? parsed.apiKey : undefined;
    } catch {
      this.apiKey = undefined;
    }
    this.loaded = true;
    return this.apiKey;
  }

  private async fetchViewer(apiKey: string): Promise<NonNullable<LinearStatusResult["viewer"]>> {
    const data = await this.post(apiKey, VIEWER_QUERY, {});
    const viewer = record(record(data)?.viewer);
    const name = text(viewer?.displayName) ?? text(viewer?.name);
    if (!viewer || !name) throw new IssueError("Linear answered without the account for this key.");
    const email = text(viewer.email);
    return { name: truncate(name, 200), ...(email && email.length <= 320 ? { email } : {}) };
  }

  private async request(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const apiKey = await this.key();
    if (!apiKey) throw new IssueError(NOT_CONNECTED);
    try {
      return await this.post(apiKey, query, variables);
    } catch (error) {
      if (error instanceof IssueError && error.message === KEY_REFUSED) this.viewer = undefined;
      throw error;
    }
  }

  private async post(apiKey: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
    const fetcher: LinearFetch = this.options.fetch ?? ((url, init) => fetch(url, init));
    let response: Awaited<ReturnType<LinearFetch>>;
    try {
      response = await fetcher(LINEAR_GRAPHQL_URL, {
        method: "POST",
        // Personal API keys go in the header as is; only OAuth tokens take a Bearer prefix.
        headers: { "Content-Type": "application/json", Authorization: apiKey },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new IssueError(UNREACHABLE);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const failure = linearFailure(response.status, body);
    if (failure) throw new IssueError(failure);
    if (!response.ok && !Array.isArray(record(body)?.errors))
      throw new IssueError(`Linear answered with HTTP ${response.status}. Try again later.`);
    return record(body)?.data;
  }
}

/** A message for a failed Linear reply, or undefined when it succeeded. */
export function linearFailure(status: number, body: unknown): string | undefined {
  const errors = Array.isArray(record(body)?.errors) ? (record(body)?.errors as unknown[]) : [];
  const codes = errors.map((error) => {
    const extensions = record(record(error)?.extensions);
    return `${text(extensions?.code) ?? ""} ${text(extensions?.type) ?? ""}`.toUpperCase();
  });
  if (status === 401 || codes.some((code) => /AUTHENTICATION|UNAUTHENTICATED|FORBIDDEN/u.test(code))) {
    return KEY_REFUSED;
  }
  if (status === 429 || codes.some((code) => code.includes("RATELIMITED"))) return RATE_LIMITED;
  if (errors.length === 0) return undefined;
  const messages = errors.map((error) => text(record(error)?.message) ?? "");
  if (messages.every((message) => /entity not found|could not find/iu.test(message))) {
    // A missing issue comes back as an error and no data; the caller says which issue was missing.
    return undefined;
  }
  const message = messages[0];
  return `Linear could not answer.${message ? ` ${truncate(message.replace(/\s+/gu, " "), 300)}` : ""}`;
}

/** The Linear `IssueFilter` for the filters the Issues panel offers. */
export function linearFilter(filter: LinearIssueFilter): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];
  const state = filter.state ?? "open";
  if (state === "open") parts.push({ state: { type: { nin: CLOSED_TYPES } } });
  if (state === "closed") parts.push({ state: { type: { in: CLOSED_TYPES } } });
  if (filter.assignee === "me") parts.push({ assignee: { isMe: { eq: true } } });
  if (filter.labels && filter.labels.length > 0) {
    for (const label of filter.labels) parts.push({ labels: { name: { eqIgnoreCase: label } } });
  }
  const query = filter.query?.trim();
  if (query) {
    const options: Record<string, unknown>[] = [
      { title: { containsIgnoreCase: query } },
      { description: { containsIgnoreCase: query } },
    ];
    const identifier = /^([A-Za-z][A-Za-z0-9]{0,15})-(\d{1,10})$/u.exec(query);
    if (identifier) {
      options.push({ team: { key: { eqIgnoreCase: identifier[1] } }, number: { eq: Number(identifier[2]) } });
    } else if (/^\d{1,10}$/u.test(query)) {
      options.push({ number: { eq: Number(query) } });
    }
    parts.push({ or: options });
  }
  return parts.length === 0 ? {} : parts.length === 1 ? (parts[0] ?? {}) : { and: parts };
}

type Raw = Record<string, unknown>;

function record(value: unknown): Raw | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nodes(value: unknown): Raw[] {
  const list = record(value)?.nodes;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown) => {
    const item = record(entry);
    return item ? [item] : [];
  });
}

function personName(value: unknown): string | undefined {
  const entry = record(value);
  return entry ? (text(entry.displayName) ?? text(entry.name)) : undefined;
}

function fromRaw(raw: Raw): IssueDetail | undefined {
  const identifier = text(raw.identifier);
  if (!identifier) return undefined;
  const state = record(raw.state);
  const stateType = text(state?.type);
  const stateName = text(state?.name);
  const labels: IssueLabel[] = nodes(raw.labels).flatMap((label) => {
    const name = text(label.name);
    const color = text(label.color);
    return name ? [{ name: truncate(name, 200), ...(color && color.length <= 20 ? { color } : {}) }] : [];
  });
  const assignee = personName(raw.assignee);
  const author = personName(raw.creator);
  const updatedAt = text(raw.updatedAt);
  const branchName = text(raw.branchName);
  const comments: IssueComment[] = nodes(raw.comments)
    .flatMap((comment) => {
      if (typeof comment.body !== "string") return [];
      const name = personName(comment.user);
      const createdAt = text(comment.createdAt);
      return [
        {
          body: truncate(comment.body, 65_536),
          ...(name ? { author: name } : {}),
          ...(createdAt ? { createdAt } : {}),
        },
      ];
    })
    .sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""))
    .slice(-MAX_COMMENTS);
  const parsed = IssueDetail.safeParse({
    source: "linear",
    key: identifier,
    reference: identifier,
    title: truncate(text(raw.title) ?? "", 1_000),
    state: stateType && CLOSED_TYPES.includes(stateType) ? "closed" : "open",
    ...(stateName ? { stateName: truncate(stateName, 100) } : {}),
    url: raw.url,
    labels: labels.slice(0, 50),
    assignees: assignee ? [assignee] : [],
    ...(author ? { author } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    body: truncate(typeof raw.description === "string" ? raw.description : "", 262_144),
    comments,
    ...(branchName && branchName.length <= 255 ? { branchName } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

export function parseLinearIssueList(data: unknown): IssueSummary[] {
  return nodes(record(data)?.issues)
    .flatMap((entry) => {
      const issue = fromRaw(entry);
      if (!issue) return [];
      const { body: _body, comments: _comments, branchName: _branch, ...summary } = issue;
      return [IssueSummary.parse(summary)];
    })
    .slice(0, 100);
}

export function parseLinearIssue(data: unknown): IssueDetail | undefined {
  const raw = record(record(data)?.issue);
  return raw ? fromRaw(raw) : undefined;
}

/** Writes through a temporary file so a crash never leaves half a key, readable only by this user. */
async function writePrivateFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, contents, { encoding: "utf8", mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
