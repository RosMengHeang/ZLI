import type { ForgeAccount, ForgeCli, ForgeCliStatus, ForgeKind, ForgeStatusResult } from "@zli-v2/contracts";

import { isMissingProgram, type ProcessRunner, redactSecrets, runProcess } from "../review/PullRequestService.js";
import { readTeaHosts } from "./remotes.js";

const CHECK_TIMEOUT_MS = 15_000;

/** What ZLI needs to know about each forge's CLI before it runs it. */
export type ForgeCliInfo = {
  kind: ForgeKind;
  label: string;
  cli: ForgeCli;
  minimumVersion: string;
  signInCommand: string;
  installUrl: string;
};

export const FORGE_CLIS: readonly ForgeCliInfo[] = [
  {
    kind: "github",
    label: "GitHub",
    cli: "gh",
    minimumVersion: "2.40.0",
    signInCommand: "gh auth login",
    installUrl: "https://cli.github.com/",
  },
  {
    kind: "gitlab",
    label: "GitLab",
    cli: "glab",
    minimumVersion: "1.40.0",
    signInCommand: "glab auth login",
    installUrl: "https://gitlab.com/gitlab-org/cli",
  },
  {
    kind: "gitea",
    label: "Gitea",
    cli: "tea",
    minimumVersion: "0.9.0",
    signInCommand: "tea login add",
    installUrl: "https://gitea.com/gitea/tea",
  },
];

/** The first x.y.z in a CLI's version output: "gh version 2.98.0 (2026-08-20)", "glab 1.46.1", "Version: 0.9.2". */
export function parseVersion(output: string): string | undefined {
  return /\b(\d+\.\d+(?:\.\d+)?)\b/u.exec(output)?.[1];
}

/** True when `version` is at least `minimum`, comparing numbers part by part. */
export function versionAtLeast(version: string, minimum: string): boolean {
  const have = version.split(".").map(Number);
  const need = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(have.length, need.length); index += 1) {
    const left = have[index] ?? 0;
    const right = need[index] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

/**
 * The accounts in `gh auth status` or `glab auth status` output: "Logged in to github.com account octo" (gh),
 * "Logged in to gitlab.com as octo" (glab). Both print to stdout or stderr depending on version.
 */
export function parseAuthStatus(output: string): ForgeAccount[] {
  const accounts: ForgeAccount[] = [];
  for (const match of output.matchAll(/Logged in to (\S+?)(?: (?:account|as) (\S+))?(?: \(|\s*$)/gmu)) {
    const host = match[1]?.toLowerCase();
    if (!host || accounts.some((entry) => entry.host === host && entry.login === match[2])) continue;
    accounts.push({ host, ...(match[2] ? { login: match[2] } : {}) });
  }
  return accounts;
}

/** Checks one forge CLI: on PATH, new enough, and signed in. Never throws. */
export async function checkForgeCli(
  info: ForgeCliInfo,
  runner: ProcessRunner,
  teaHosts: () => Promise<readonly string[]> = readTeaHosts,
): Promise<ForgeCliStatus> {
  const base = {
    kind: info.kind,
    label: info.label,
    cli: info.cli,
    minimumVersion: info.minimumVersion,
    signInCommand: info.signInCommand,
    installUrl: info.installUrl,
    accounts: [] as ForgeAccount[],
  };
  const options = { cwd: process.cwd(), timeoutMs: CHECK_TIMEOUT_MS };
  let version: string | undefined;
  try {
    const result = await runner(info.cli, [info.cli === "glab" ? "version" : "--version"], options);
    version = parseVersion(`${result.stdout}\n${result.stderr}`);
  } catch (error) {
    if (isMissingProgram(error)) return { ...base, state: "missing" };
    return { ...base, state: "error", message: redactSecrets(error instanceof Error ? error.message : String(error)) };
  }
  if (!version) return { ...base, state: "error", message: `${info.cli} did not say which version it is.` };
  if (!versionAtLeast(version, info.minimumVersion)) return { ...base, state: "outdated", version };

  let accounts: ForgeAccount[];
  if (info.cli === "tea") {
    accounts = (await teaHosts()).map((host) => ({ host }));
  } else {
    try {
      const result = await runner(info.cli, ["auth", "status"], options);
      accounts = parseAuthStatus(`${result.stdout}\n${result.stderr}`);
    } catch (error) {
      return {
        ...base,
        version,
        state: "error",
        message: redactSecrets(error instanceof Error ? error.message : String(error)),
      };
    }
  }
  return { ...base, version, accounts, state: accounts.length > 0 ? "ready" : "signed_out" };
}

/** Each forge CLI's status. Checked once and kept until a rescan, since each check starts a few processes. */
export class ForgeService {
  private current: Promise<ForgeStatusResult> | undefined;

  constructor(
    private readonly runner: ProcessRunner = runProcess,
    private readonly teaHosts: () => Promise<readonly string[]> = readTeaHosts,
    private readonly now: () => Date = () => new Date(),
  ) {}

  status(): Promise<ForgeStatusResult> {
    this.current ??= this.check();
    return this.current;
  }

  rescan(): Promise<ForgeStatusResult> {
    this.current = this.check();
    return this.current;
  }

  private async check(): Promise<ForgeStatusResult> {
    const forges = await Promise.all(FORGE_CLIS.map((info) => checkForgeCli(info, this.runner, this.teaHosts)));
    return { forges, checkedAt: this.now().toISOString() };
  }
}
