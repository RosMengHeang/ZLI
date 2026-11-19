import type { ForgeKind } from "@zli-v2/contracts";

import { type ProcessRunner, redactSecrets, runProcess } from "../review/PullRequestService.js";
import { CLI_TIMEOUT_MS, parseJson, printedUrl, record, text } from "./ForgeDriver.js";
import { checkForgeCli, FORGE_CLIS } from "./ForgeService.js";

const PUSH_TIMEOUT_MS = 5 * 60_000;

/** Thrown with a message the person can act on. */
export class PublishError extends Error {}

export type PublishRequest = { forge: ForgeKind; owner?: string | undefined; name: string; private: boolean };

const NAME = /^[\w.-]{1,100}$/u;
const OWNER = /^[\w.-]+(\/[\w.-]+)*$/u;

function said(result: { stdout: string; stderr: string }): string {
  return redactSecrets((result.stderr || result.stdout).trim())
    .split(/\r?\n/u)
    .slice(-3)
    .join(" ");
}

/**
 * Creates a repository on the forge for a local repository with no origin, adds it as origin, and pushes the
 * current branch. Answers with the repository's web address.
 */
export async function publishRepository(
  cwd: string,
  request: PublishRequest,
  runner: ProcessRunner = runProcess,
  teaHosts?: () => Promise<readonly string[]>,
): Promise<{ url: string }> {
  const name = request.name.trim();
  const owner = request.owner?.trim() || undefined;
  if (!NAME.test(name)) throw new PublishError("Use letters, numbers, dots, dashes or underscores for the name.");
  if (owner && !OWNER.test(owner)) throw new PublishError("That owner or group name isn't valid.");
  const git = (args: string[], timeoutMs = CLI_TIMEOUT_MS) => runner("git", args, { cwd, timeoutMs });

  if ((await git(["rev-parse", "--verify", "--quiet", "HEAD"])).code !== 0) {
    throw new PublishError("Make a first commit, then publish.");
  }
  if ((await git(["remote", "get-url", "origin"])).code === 0) {
    throw new PublishError("This repository already has an origin remote.");
  }
  const info = FORGE_CLIS.find((entry) => entry.kind === request.forge);
  if (!info) throw new PublishError("Pick a forge.");
  const status = await checkForgeCli(info, runner, teaHosts);
  if (status.state === "missing") throw new PublishError(`Install ${info.cli} to publish to ${info.label}.`);
  if (status.state === "outdated") throw new PublishError(`Update ${info.cli} to ${info.minimumVersion} or newer.`);
  if (status.state !== "ready") throw new PublishError(`Sign ${info.cli} in first: run ${info.signInCommand}.`);

  const full = owner ? `${owner}/${name}` : name;
  const visibility = request.private ? "--private" : "--public";
  const cli = (args: string[]) => runner(info.cli, args, { cwd, timeoutMs: PUSH_TIMEOUT_MS });

  if (request.forge === "github") {
    // gh adds origin and pushes the current branch itself.
    const created = await cli(["repo", "create", full, visibility, "--source", ".", "--remote", "origin", "--push"]);
    if (created.code !== 0) throw new PublishError(`gh couldn't create ${full}: ${said(created)}`);
    const url = printedUrl(created.stdout) ?? printedUrl(created.stderr);
    if (!url) throw new PublishError("gh created the repository but did not print its link.");
    return { url: url.replace(/\.git$/u, "") };
  }

  let webUrl: string | undefined;
  let cloneUrl: string | undefined;
  if (request.forge === "gitlab") {
    const created = await cli(["repo", "create", full, visibility, "--defaultBranch", "main"]);
    if (created.code !== 0) throw new PublishError(`glab couldn't create ${full}: ${said(created)}`);
    webUrl = printedUrl(created.stdout) ?? printedUrl(created.stderr);
  } else {
    const args = ["repo", "create", "--name", name, visibility === "--private" ? "--private" : "--private=false"];
    if (owner) args.push("--owner", owner);
    args.push("--output", "json");
    const created = await cli(args);
    if (created.code !== 0) throw new PublishError(`tea couldn't create ${full}: ${said(created)}`);
    const repo = record(parseJson(created.stdout));
    webUrl = text(repo?.html_url) ?? text(repo?.url) ?? printedUrl(created.stdout);
    cloneUrl = text(repo?.clone_url);
  }
  if (!webUrl) throw new PublishError(`${info.cli} created the repository but did not print its link.`);
  webUrl = webUrl.replace(/\.git$/u, "");
  cloneUrl ??= `${webUrl}.git`;

  // glab may add origin itself when run inside the repository.
  if ((await git(["remote", "get-url", "origin"])).code !== 0) {
    const added = await git(["remote", "add", "origin", cloneUrl]);
    if (added.code !== 0) throw new PublishError(`git couldn't add origin: ${said(added)}`);
  }
  const pushed = await git(["push", "-u", "origin", "HEAD"], PUSH_TIMEOUT_MS);
  if (pushed.code !== 0) {
    throw new PublishError(`The repository is at ${webUrl}, but git couldn't push to it: ${said(pushed)}`);
  }
  return { url: webUrl };
}
