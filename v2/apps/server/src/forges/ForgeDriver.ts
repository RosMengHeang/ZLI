import type {
  ForgeCapabilities,
  ForgeInfo,
  PullRequestInfo,
  PullRequestMergeMethod,
  PullRequestProblem,
} from "@zli-v2/contracts";

import { type ProcessResult, type ProcessRunner, redactSecrets } from "../review/PullRequestService.js";
import { checkForgeCli, FORGE_CLIS, type ForgeCliInfo } from "./ForgeService.js";

export const CLI_TIMEOUT_MS = 60_000;
/** A CLI that answered as ready is trusted this long before ZLI checks it again. */
const READY_FOR_MS = 60_000;

export const GITHUB_CAPABILITIES: ForgeCapabilities = {
  checks: true,
  checkLog: true,
  reviewThreads: true,
  review: true,
  autoMerge: true,
  mergeMethods: ["squash", "merge", "rebase"],
};

/** Pull request work on one forge, through its CLI, run in the worktree so the CLI finds the repository. */
export interface ForgeDriver {
  readonly info: Omit<ForgeInfo, "host">;
  /** Why the CLI cannot be used right now: not installed, too old, or signed out. */
  problem(cwd: string): Promise<PullRequestProblem | undefined>;
  /** The newest pull request from `branch`, open or not; undefined when it has none. */
  view(cwd: string, branch: string): Promise<PullRequestInfo | undefined>;
  create(
    cwd: string,
    request: { branch: string; title: string; body: string; base: string; draft: boolean },
  ): Promise<PullRequestInfo>;
  merge(cwd: string, number: number, method: PullRequestMergeMethod): Promise<void>;
  comment(cwd: string, number: number, body: string): Promise<void>;
}

/** Thrown with a message the person can act on; the pull request service passes it through as is. */
export class ForgeError extends Error {}

/** Runs a forge CLI and keeps track of when it was last seen working. */
export class ForgeCliRunner {
  private readyUntil = 0;
  readonly info: ForgeCliInfo;

  constructor(
    kind: "gitlab" | "gitea",
    private readonly runner: ProcessRunner,
    private readonly teaHosts?: () => Promise<readonly string[]>,
  ) {
    const info = FORGE_CLIS.find((entry) => entry.kind === kind);
    if (!info) throw new Error(`No CLI for ${kind}.`);
    this.info = info;
  }

  run(cwd: string, args: readonly string[]): Promise<ProcessResult> {
    return this.runner(this.info.cli, args, { cwd, timeoutMs: CLI_TIMEOUT_MS });
  }

  async problem(): Promise<PullRequestProblem | undefined> {
    if (Date.now() < this.readyUntil) return undefined;
    const status = await checkForgeCli(this.info, this.runner, this.teaHosts);
    const { cli, label, signInCommand, minimumVersion } = this.info;
    switch (status.state) {
      case "ready":
        this.readyUntil = Date.now() + READY_FOR_MS;
        return undefined;
      case "missing":
        return {
          code: "cli_missing",
          message: `${label} needs ${cli}, which is not installed. Install it, then check again.`,
        };
      case "outdated":
        return {
          code: "cli_outdated",
          message: `${cli} ${status.version ?? ""} is too old. ZLI needs ${minimumVersion} or newer.`.replace(
            "  ",
            " ",
          ),
        };
      case "signed_out":
        return {
          code: "cli_unauthenticated",
          message: `${cli} is not signed in. Run ${signInCommand} in a terminal, then check again.`,
        };
      case "error":
        return { code: "cli_failed", message: status.message ?? `${cli} could not be run.` };
    }
  }

  /** A failure message: the CLI's own words, without secrets, after what ZLI was doing. */
  failure(action: string, result: ProcessResult): string {
    const said = redactSecrets((result.stderr || result.stdout).trim())
      .split(/\r?\n/u)
      .slice(0, 4)
      .join(" ");
    return `${this.info.cli} ${action}${said ? `: ${said}` : "."}`;
  }
}

/** The first http(s) link a CLI printed, as `glab mr create` and `tea pulls create` do. */
export function printedUrl(output: string): string | undefined {
  return output
    .split(/\s+/u)
    .map((word) => word.trim())
    .filter((word) => /^https?:\/\/\S+$/u.test(word))
    .at(-1);
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function whole(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number >= 0 ? number : undefined;
}
