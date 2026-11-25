import type { PullRequestCheck, PullRequestInfo, PullRequestMergeMethod, PullRequestProblem } from "@zli-v2/contracts";

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

const NO_MERGE_REQUEST = /no (open )?merge requests? (available|found)|not found/iu;

const PIPELINE_STATE: Record<string, PullRequestCheck["state"]> = {
  success: "passed",
  failed: "failed",
  canceled: "failed",
  skipped: "skipped",
  manual: "skipped",
};

/** Reads `glab mr view --output json` into the shape ZLI shows; undefined when it is not a merge request. */
export function parseMergeRequest(stdout: string): PullRequestInfo | undefined {
  const value = record(parseJson(stdout));
  const number = whole(value?.iid);
  const url = text(value?.web_url);
  if (!value || !number || !url) return undefined;
  const state = value.state === "merged" ? "MERGED" : value.state === "opened" ? "OPEN" : "CLOSED";
  const pipeline = record(value.head_pipeline) ?? record(value.pipeline);
  const pipelineStatus = text(pipeline?.status);
  const checks: PullRequestCheck[] | undefined = pipelineStatus
    ? [
        {
          name: "Pipeline",
          state: PIPELINE_STATE[pipelineStatus] ?? "pending",
          ...(text(pipeline?.web_url) ? { url: text(pipeline?.web_url) } : {}),
        },
      ]
    : undefined;
  const author = text(record(value.author)?.username);
  const changes = whole(value.changes_count);
  return {
    number,
    url,
    state,
    isDraft: value.draft === true || value.work_in_progress === true,
    ...(text(value.title) ? { title: text(value.title)?.slice(0, 500) } : {}),
    ...(typeof value.description === "string" ? { body: value.description.slice(0, 100_000) } : {}),
    ...(author ? { author: { login: author } } : {}),
    ...(text(value.updated_at) ? { updatedAt: text(value.updated_at) } : {}),
    ...(text(value.target_branch) ? { baseRefName: text(value.target_branch) } : {}),
    ...(text(value.source_branch) ? { headRefName: text(value.source_branch) } : {}),
    ...(changes !== undefined ? { changedFiles: changes } : {}),
    ...(checks ? { checks } : {}),
  };
}

/** GitLab and self-hosted GitLab, through glab. GitLab calls pull requests merge requests. */
export class GitLabDriver implements ForgeDriver {
  readonly info: ForgeDriver["info"] = {
    kind: "gitlab",
    label: "GitLab",
    requestNoun: "merge request",
    capabilities: {
      checks: true,
      checkLog: false,
      reviewThreads: false,
      review: false,
      autoMerge: false,
      mergeMethods: ["merge", "squash", "rebase"],
    },
  };
  private readonly cli: ForgeCliRunner;

  constructor(runner: ProcessRunner) {
    this.cli = new ForgeCliRunner("gitlab", runner);
  }

  problem(): Promise<PullRequestProblem | undefined> {
    return this.cli.problem();
  }

  async view(cwd: string, branch: string): Promise<PullRequestInfo | undefined> {
    const result = await this.cli.run(cwd, ["mr", "view", branch, "--output", "json"]);
    if (result.code !== 0) {
      if (NO_MERGE_REQUEST.test(`${result.stderr}\n${result.stdout}`)) return undefined;
      throw new ForgeError(this.cli.failure("could not look up the merge request", result));
    }
    const mergeRequest = parseMergeRequest(result.stdout);
    if (!mergeRequest) throw new ForgeError("glab returned a merge request ZLI could not read.");
    return mergeRequest;
  }

  async create(
    cwd: string,
    request: { branch: string; title: string; body: string; base: string; draft: boolean },
  ): Promise<PullRequestInfo> {
    const args = [
      "mr",
      "create",
      "--source-branch",
      request.branch,
      "--target-branch",
      request.base,
      "--title",
      request.title,
      "--description",
      request.body,
      "--yes",
    ];
    if (request.draft) args.push("--draft");
    const created = await this.cli.run(cwd, args);
    if (created.code !== 0) {
      if (/already exists/iu.test(created.stderr)) {
        const existing = await this.view(cwd, request.branch);
        if (existing) return existing;
      }
      throw new ForgeError(this.cli.failure("could not create the merge request", created));
    }
    const viewed = await this.view(cwd, request.branch);
    if (viewed) return viewed;
    const url = printedUrl(created.stdout);
    const number = whole(url?.match(/\/merge_requests\/(\d+)/u)?.[1]);
    if (!url || !number) throw new ForgeError("glab created the merge request but did not print its link.");
    return { number, url, state: "OPEN", isDraft: request.draft };
  }

  async merge(cwd: string, number: number, method: PullRequestMergeMethod): Promise<void> {
    const args = ["mr", "merge", String(number), "--yes"];
    if (method === "squash") args.push("--squash");
    if (method === "rebase") args.push("--rebase");
    const merged = await this.cli.run(cwd, args);
    if (merged.code !== 0) throw new ForgeError(this.cli.failure(`could not merge !${number}`, merged));
  }

  async comment(cwd: string, number: number, body: string): Promise<void> {
    const commented = await this.cli.run(cwd, ["mr", "note", String(number), `--message=${body}`]);
    if (commented.code !== 0) throw new ForgeError(this.cli.failure(`could not comment on !${number}`, commented));
  }
}
