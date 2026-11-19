import type { PullRequestInfo, PullRequestMergeMethod, PullRequestProblem } from "@zli-v2/contracts";

import type { ProcessRunner } from "../review/PullRequestService.js";
import {
  ForgeCliRunner,
  type ForgeDriver,
  ForgeError,
  parseJson,
  printedUrl,
  record,
  text,
  whole,
} from "./ForgeDriver.js";
import { readTeaHosts } from "./remotes.js";

const FIELDS = "index,title,body,state,author,url,head,base,updated";
/** Gitea marks a draft with a title prefix. */
const DRAFT_PREFIX = /^(WIP:|\[WIP\])\s*/iu;

/** Reads one entry of `tea pulls list --output json`. */
export function parseTeaPull(value: unknown): (PullRequestInfo & { head?: string | undefined }) | undefined {
  const entry = record(value);
  const number = whole(entry?.index);
  const url = text(entry?.url);
  if (!entry || !number || !url) return undefined;
  const title = text(entry.title);
  const state = String(entry.state).toLowerCase();
  return {
    number,
    url,
    state: state === "merged" ? "MERGED" : state === "open" ? "OPEN" : "CLOSED",
    isDraft: title ? DRAFT_PREFIX.test(title) : false,
    ...(title ? { title: title.slice(0, 500) } : {}),
    ...(typeof entry.body === "string" ? { body: entry.body.slice(0, 100_000) } : {}),
    ...(text(entry.author) ? { author: { login: text(entry.author) as string } } : {}),
    ...(text(entry.updated) ? { updatedAt: text(entry.updated) } : {}),
    ...(text(entry.base) ? { baseRefName: text(entry.base) } : {}),
    ...(text(entry.head) ? { headRefName: text(entry.head), head: text(entry.head) } : {}),
  };
}

/** Gitea, Forgejo and Codeberg, through tea. tea finds the repository from the worktree's remote. */
export class GiteaDriver implements ForgeDriver {
  readonly info: ForgeDriver["info"] = {
    kind: "gitea",
    label: "Gitea",
    requestNoun: "pull request",
    capabilities: {
      checks: false,
      checkLog: false,
      reviewThreads: false,
      review: false,
      autoMerge: false,
      mergeMethods: ["merge", "squash", "rebase"],
    },
  };
  private readonly cli: ForgeCliRunner;

  constructor(runner: ProcessRunner, teaHosts: () => Promise<readonly string[]> = readTeaHosts) {
    this.cli = new ForgeCliRunner("gitea", runner, teaHosts);
  }

  problem(): Promise<PullRequestProblem | undefined> {
    return this.cli.problem();
  }

  async view(cwd: string, branch: string): Promise<PullRequestInfo | undefined> {
    const result = await this.cli.run(cwd, [
      "pulls",
      "list",
      "--state",
      "all",
      "--limit",
      "50",
      "--fields",
      FIELDS,
      "--output",
      "json",
    ]);
    if (result.code !== 0) throw new ForgeError(this.cli.failure("could not list the pull requests", result));
    const list = parseJson(result.stdout);
    if (!Array.isArray(list)) throw new ForgeError("tea returned pull requests ZLI could not read.");
    // Newest first; an open one wins over an older closed one from the same branch.
    const pulls = list.flatMap((entry) => {
      const pull = parseTeaPull(entry);
      return pull && pull.head === branch ? [pull] : [];
    });
    const found = pulls.find((pull) => pull.state === "OPEN") ?? pulls[0];
    if (!found) return undefined;
    const { head: _head, ...pullRequest } = found;
    return pullRequest;
  }

  async create(
    cwd: string,
    request: { branch: string; title: string; body: string; base: string; draft: boolean },
  ): Promise<PullRequestInfo> {
    const title = request.draft && !DRAFT_PREFIX.test(request.title) ? `WIP: ${request.title}` : request.title;
    const created = await this.cli.run(cwd, [
      "pulls",
      "create",
      "--head",
      request.branch,
      "--base",
      request.base,
      "--title",
      title,
      "--description",
      request.body,
    ]);
    if (created.code !== 0) {
      if (/already exists/iu.test(`${created.stderr}\n${created.stdout}`)) {
        const existing = await this.view(cwd, request.branch);
        if (existing) return existing;
      }
      throw new ForgeError(this.cli.failure("could not create the pull request", created));
    }
    const viewed = await this.view(cwd, request.branch);
    if (viewed) return viewed;
    const url = printedUrl(created.stdout);
    const number = whole(url?.match(/\/pulls\/(\d+)/u)?.[1]);
    if (!url || !number) throw new ForgeError("tea created the pull request but did not print its link.");
    return { number, url, state: "OPEN", isDraft: request.draft };
  }

  async merge(cwd: string, number: number, method: PullRequestMergeMethod): Promise<void> {
    const merged = await this.cli.run(cwd, ["pulls", "merge", String(number), "--style", method]);
    if (merged.code !== 0) throw new ForgeError(this.cli.failure(`could not merge #${number}`, merged));
  }

  async comment(cwd: string, number: number, body: string): Promise<void> {
    const commented = await this.cli.run(cwd, ["comment", String(number), body]);
    if (commented.code !== 0) throw new ForgeError(this.cli.failure(`could not comment on #${number}`, commented));
  }
}
